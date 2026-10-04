// Simulador local da plataforma WEDU (register / burst / enrich / callback).
// Zero dependências. Uso: `node test/mock-platform/server.js` (porta 5000) ou createMockPlatform().
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash01(...parts) {
  let h = 2166136261;
  for (const c of parts.join('|')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return mulberry32(h >>> 0)();
}
// seq é 0-based (0..total-1); sku-001 corresponde a seq 0
const skuOf = (seq) => `sku-${String(seq + 1).padStart(3, '0')}`;
export const expectedFor = (seq) => ({
  seq, sku: skuOf(seq),
  price: Number((10 + (((seq + 1) * 7919) % 9000) / 100).toFixed(2)),
  stock: ((seq + 1) * 31) % 100,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}
function send(res, status, body, headers = {}) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...headers });
  res.end(s);
}

export function createMockPlatform(opts = {}) {
  const cfg = {
    total: 20, dupRate: 0.125, seed: 1, errorRate: 0.1,
    enrichMin: 400, enrichMax: 800, maxInflight: 3, slaMs: 600, ackTimeoutMs: 3000,
    processBeforeBurstResponse: false, // dispara /process antes de responder o /burst
    burstResponseDelayMs: 0,
    ...opts,
  };
  const clients = new Map(); // cid -> {token, webhook, name, runs:[], enrich:{...}}
  const runs = new Map();    // run_id -> run
  const reports = [];
  const waiters = [];
  let runCounter = 0;

  async function post(url, body, timeoutMs) {
    return fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function dispatch(run, client) {
    const rng = mulberry32(cfg.seed * 1000 + run.n);
    const msgs = Array.from({ length: run.total }, (_, i) => i);
    const dupCount = Math.max(1, Math.round(run.total * cfg.dupRate));
    for (let i = 0; i < dupCount; i++) msgs.push(Math.floor(rng() * run.total));
    run.dupsSent = dupCount;
    for (let i = msgs.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [msgs[i], msgs[j]] = [msgs[j], msgs[i]]; }
    run.sentOrder = msgs;
    await Promise.all(msgs.map(async (seq, idx) => {
      const t0 = performance.now();
      let ok = false, status = 0;
      try {
        const r = await post(`${client.webhook}/process`, { run_id: run.id, seq, sku: skuOf(seq) }, cfg.ackTimeoutMs);
        status = r.status; ok = r.status >= 200 && r.status < 300;
        await r.arrayBuffer().catch(() => {});
      } catch { status = 0; }
      run.acks.push({ idx, seq, ms: performance.now() - t0, ok, status });
    }));
  }

  function buildReport(run, body) {
    const client = clients.get(run.cid);
    const raw = body.result ?? body.results;
    const results = Array.isArray(raw) ? raw : (raw && typeof raw === 'object') ? Object.values(raw) : [];
    const got = new Map();
    const divergences = [];
    for (const it of results) {
      const seq = Number(it.seq);
      const exp = expectedFor(seq);
      if (!(Number.isInteger(seq) && seq >= 0 && seq < run.total) || (it.sku && it.sku !== exp.sku)) {
        divergences.push({ seq, reason: 'seq/sku inesperado', got: it }); continue;
      }
      const price = it.price ?? it.enrichment?.price ?? it.data?.price;
      const stock = it.stock ?? it.enrichment?.stock ?? it.data?.stock;
      if (price !== exp.price || stock !== exp.stock) divergences.push({ seq, reason: 'valor divergente', expected: exp, got: { price, stock } });
      got.set(seq, it);
    }
    const lost = [];
    for (let s = 0; s < run.total; s++) if (!got.has(s)) lost.push(s);
    // ignora a 1ª mensagem enviada (warm-up)
    const sorted = [...run.acks].sort((a, b) => a.idx - b.idx);
    const measured = sorted.slice(1).map((a) => a.ms);
    const avg = measured.length ? measured.reduce((a, b) => a + b, 0) / measured.length : 0;
    const e = client.enrich;
    return {
      run_id: run.id, cid: run.cid, total: run.total,
      ack_avg_ms: Number(avg.toFixed(2)),
      ack_max_ms: Number((measured.length ? Math.max(...measured) : 0).toFixed(2)),
      sla_violations: sorted.slice(1).filter((a) => a.ms > cfg.slaMs || !a.ok).length,
      ack_failures: run.acks.filter((a) => !a.ok).length,
      received: run.sentOrder.length,
      processed: got.size,
      duplicates: run.dupsSent,
      lost: lost.length, lost_seqs: lost,
      divergences: divergences.length, divergence_details: divergences,
      enrich_calls: e.calls, enrich_ok: e.ok, enrich_ok_by_sku: { ...e.okBySku },
      peak_concurrency: e.peak, rate_limited_429: e.r429, errors_500: e.r500,
      latency_samples: sorted.map((a) => Number(a.ms.toFixed(1))),
      callback_at: new Date().toISOString(),
    };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const parts = url.pathname.split('/').filter(Boolean);
      const m = req.method;

      if (m === 'POST' && url.pathname === '/register') {
        const body = await readJson(req);
        if (!body || !body.webhook) return send(res, 400, { error: 'bad_request' });
        const probe = randomUUID();
        let reason = null;
        try {
          const r = await post(`${body.webhook}/check`, { token: probe }, 5000);
          const j = await r.json().catch(() => null);
          if (!r.ok) reason = `check status ${r.status}`;
          else if (!j || j.token !== probe) reason = 'token not echoed';
        } catch (err) { reason = `check unreachable: ${err.message}`; }
        if (reason) return send(res, 422, { error: 'handshake_failed', reason });
        const cid = randomUUID(), token = randomUUID();
        clients.set(cid, { token, webhook: body.webhook, name: body.name, runs: [],
          enrich: { inflight: 0, peak: 0, calls: 0, ok: 0, r429: 0, r500: 0, okBySku: {}, attempts: {} } });
        return send(res, 200, { cid, token });
      }

      if (m === 'POST' && parts[0] === 'burst' && parts[1]) {
        const client = clients.get(parts[1]);
        if (!client) return send(res, 404, { error: 'unknown_cid' });
        if (req.headers['x-token'] !== client.token) return send(res, 401, { error: 'unauthorized' });
        const run = { id: randomUUID(), n: ++runCounter, cid: parts[1], total: cfg.total, acks: [],
          started_at: new Date().toISOString(), skus: new Set() };
        for (let i = 0; i < run.total; i++) run.skus.add(skuOf(i));
        runs.set(run.id, run); client.runs.push(run.id);
        client.enrich = { inflight: 0, peak: 0, calls: 0, ok: 0, r429: 0, r500: 0, okBySku: {}, attempts: {} };
        client.activeRun = run.id;
        const d = dispatch(run, client);
        if (cfg.processBeforeBurstResponse) await sleep(cfg.burstResponseDelayMs || 300);
        send(res, 200, { run_id: run.id, total: run.total, started_at: run.started_at });
        d.catch(() => {});
        return;
      }

      if (m === 'GET' && parts[0] === 'enrich' && parts[1]) {
        const cid = req.headers['x-cid'];
        const client = clients.get(cid);
        if (!client || req.headers['x-token'] !== client.token) return send(res, 401, { error: 'unauthorized' });
        const run = runs.get(client.activeRun);
        const sku = parts[1];
        if (!run || !run.skus.has(sku)) return send(res, 404, { error: 'unknown_sku' });
        const e = client.enrich;
        e.calls++;
        if (e.inflight >= cfg.maxInflight) {
          e.r429++;
          return send(res, 429, { error: 'too_many_requests' }, { 'retry-after': '1' });
        }
        e.inflight++; e.peak = Math.max(e.peak, e.inflight);
        try {
          const lat = cfg.enrichMin + Math.random() * (cfg.enrichMax - cfg.enrichMin);
          await sleep(lat);
          const att = (e.attempts[sku] = (e.attempts[sku] || 0) + 1);
          if (hash01(cfg.seed, sku, att) < cfg.errorRate) { e.r500++; return send(res, 500, { error: 'internal' }); }
          const exp = expectedFor(Number(sku.slice(4)) - 1);
          e.ok++; e.okBySku[sku] = (e.okBySku[sku] || 0) + 1;
          return send(res, 200, { sku, price: exp.price, stock: exp.stock });
        } finally { e.inflight--; }
      }

      if (m === 'POST' && url.pathname === '/callback') {
        const body = await readJson(req);
        if (!body) return send(res, 400, { error: 'bad_json' });
        const run = runs.get(body.run_id);
        if (!run) return send(res, 404, { error: 'unknown_run' });
        const client = clients.get(run.cid);
        if (req.headers['x-token'] !== client.token) return send(res, 401, { error: 'unauthorized' });
        const report = buildReport(run, body);
        reports.push(report);
        for (const w of waiters.splice(0)) w(report);
        return send(res, 200, report);
      }

      send(res, 404, { error: 'not_found' });
    } catch (err) {
      send(res, 500, { error: 'mock_crash', message: String(err) });
    }
  });

  return {
    server, reports, cfg, clients, runs,
    listen: (port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
    waitForReport(timeoutMs = 60000, runId) {
      const found = runId ? reports.find((r) => r.run_id === runId) : null;
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout waiting callback')), timeoutMs);
        const w = (rep) => { if (runId && rep.run_id !== runId) { waiters.push(w); return; } clearTimeout(t); resolve(rep); };
        waiters.push(w);
      });
    },
  };
}

if (!process.env.NODE_TEST_CONTEXT && process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const mock = createMockPlatform({ seed: Number(process.env.SEED) || 1 });
  const port = await mock.listen(Number(process.env.PORT) || 5000);
  console.log(`mock platform em http://127.0.0.1:${port}`);
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createEnrichClient } from '../../src/enrich-client.js';

async function stub(handler) {
  const state = { calls: 0, inflight: 0, peak: 0, times: [] };
  const srv = http.createServer(async (req, res) => {
    state.calls++; state.times.push(Date.now()); state.inflight++; state.peak = Math.max(state.peak, state.inflight);
    try { await handler(state, req, res); } finally { state.inflight--; }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections(); srv.close(); } };
}
const ok = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const creds = () => ({ cid: 'c', token: 't' });

test('500 é retentado até dar certo', async () => {
  const s = await stub((st, req, res) => { if (st.calls < 3) { res.writeHead(500); res.end('{}'); } else ok(res, { price: 5, stock: 1 }); });
  try {
    let retries = 0;
    const c = createEnrichClient({ platformUrl: s.url, getCredentials: creds, backoffBaseMs: 5 });
    assert.deepEqual(await c.enrich('sku-001', { onRetry: () => retries++ }), { price: 5, stock: 1 });
    assert.equal(s.state.calls, 3);
    assert.equal(retries, 2);
  } finally { s.close(); }
});

test('500 permanente esgota retries e rejeita', async () => {
  const s = await stub((st, req, res) => { res.writeHead(500); res.end('{}'); });
  try {
    const c = createEnrichClient({ platformUrl: s.url, getCredentials: creds, backoffBaseMs: 1, maxRetries: 2 });
    await assert.rejects(c.enrich('sku-001'), /esgotou retries/);
    assert.equal(s.state.calls, 3);
  } finally { s.close(); }
});

test('429 respeita retry-after e não consome retries', async () => {
  const s = await stub((st, req, res) => { if (st.calls <= 2) { res.writeHead(429, { 'retry-after': '1' }); res.end('{}'); } else ok(res, { price: 1, stock: 1 }); });
  try {
    let rl = 0;
    const c = createEnrichClient({ platformUrl: s.url, getCredentials: creds, backoffBaseMs: 1, maxRetries: 0 });
    await c.enrich('sku-001', { onRateLimited: () => rl++ });
    assert.equal(rl, 2);
    assert.equal(s.state.calls, 3);
    assert.ok(s.state.times[1] - s.state.times[0] >= 950, 'esperou retry-after');
    assert.ok(s.state.times[2] - s.state.times[1] >= 950);
  } finally { s.close(); }
});

test('401 e 404 são permanentes (sem retry)', async () => {
  for (const code of [401, 404]) {
    const s = await stub((st, req, res) => { res.writeHead(code); res.end('{}'); });
    try {
      const c = createEnrichClient({ platformUrl: s.url, getCredentials: creds, backoffBaseMs: 1 });
      await assert.rejects(c.enrich('x'), (e) => e.permanent === true);
      assert.equal(s.state.calls, 1);
    } finally { s.close(); }
  }
});

test('semáforo global: nunca mais que `concurrency` em voo', async () => {
  const s = await stub(async (st, req, res) => { await new Promise((r) => setTimeout(r, 30)); ok(res, { price: 1, stock: 1 }); });
  try {
    const c = createEnrichClient({ platformUrl: s.url, getCredentials: creds, concurrency: 3 });
    await Promise.all(Array.from({ length: 25 }, (_, i) => c.enrich(`sku-${i}`)));
    assert.equal(s.state.peak, 3);
    assert.equal(s.state.calls, 25);
  } finally { s.close(); }
});

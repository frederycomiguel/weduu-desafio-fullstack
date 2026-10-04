// Demonstração ponta a ponta do fluxo completo.
//
//   npm run demo        modo LOCAL: plataforma simulada, sem rede e sem ngrok.
//                       Opcionais: TOTAL (SKUs), DUP_RATE (0 a 1), ERROR_RATE (0 a 1).
//   npm run demo:real   modo REAL: abre o ngrok, registra na plataforma Weduu de verdade,
//                       pede um lote e mostra o relatório devolvido por ela.
//                       Requer o ngrok instalado e autenticado. Opcional: WEBHOOK_NAME.
import { spawn } from 'node:child_process';
import { createMockPlatform } from '../test/mock-platform/server.js';
import { createService } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { createPlatformClient } from '../src/platform-client.js';
import { loadConfig } from '../src/config.js';

const real = process.argv.includes('--real');
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Garante um túnel ngrok para `port` e devolve { url, stop }.
 * Se já houver um ngrok rodando (API local em 4040), reaproveita o túnel existente e não
 * o encerra no final; senão inicia um processo próprio e o encerra em `stop()`.
 */
async function openTunnel(port) {
  const api = 'http://127.0.0.1:4040/api/tunnels';
  const current = async () => {
    try {
      const { tunnels } = await (await fetch(api)).json();
      return tunnels.find((t) => t.public_url.startsWith('https://') && t.config.addr.endsWith(`:${port}`))?.public_url;
    } catch { return undefined; }
  };

  const existing = await current();
  if (existing) return { url: existing, stop: () => {} };

  const child = spawn('ngrok', ['http', String(port), '--log=stdout'], { stdio: 'ignore' });
  let spawnError;
  child.on('error', (e) => { spawnError = e; });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (spawnError) throw new Error(`não consegui iniciar o ngrok (${spawnError.message}). Ele está instalado e autenticado?`);
    const url = await current();
    if (url) return { url, stop: () => child.kill() };
  }
  child.kill();
  throw new Error('o ngrok não abriu o túnel em 20 s. Rode `ngrok http 4000` à mão para ver o erro.');
}

/** Imprime o relatório devolvido pela plataforma real de forma legível. */
function printRealReport(r) {
  console.log(`\nScore: ${r.score}/100 (tentativa ${r.attempt})`);
  console.table({
    'ACK p50 (ms)': r.ack.p50,
    'ACK p95 (ms)': r.ack.p95,
    'ACK pior (ms)': r.ack.worst.ms,
    'Acima de 600 ms': r.ack.over_target.length,
    'Duplicata tratada': r.idempotency.pass,
    '500 forçados pela plataforma': r.retry.forced_500,
    'SKUs com 500 recuperados': `${r.retry.recovered}/${r.retry.skus_with_500}`,
    '429 recebidos': r.concurrency.got_429,
    'Itens corretos': `${r.result.matched.length}/${r.result.expected}`,
    'Duração (ms)': r.duration_ms,
  });
  return r.result.pass && r.idempotency.pass && r.retry.pass && r.concurrency.pass;
}

const cleanups = [];
async function finish(ok) {
  for (const fn of cleanups.reverse()) await fn();
  process.exit(ok ? 0 : 1);
}

try {
  if (real) {
    // ---------- MODO REAL ----------
    const cfg = loadConfig();
    // O serviço chama onRunComplete depois do /callback, já com o relatório da plataforma no run.
    let resolveDone;
    const completed = new Promise((resolve) => { resolveDone = resolve; });
    const service = createService({ logger: createLogger(), onRunComplete: (run) => resolveDone(run) });
    await service.listen(cfg.port);
    cleanups.push(() => service.close());
    console.log(`\n[1] serviço no ar na porta ${cfg.port}`);

    console.log('[2] abrindo túnel ngrok...');
    const tunnel = await openTunnel(cfg.port);
    cleanups.push(() => tunnel.stop());
    console.log(`    ${tunnel.url}`);

    console.log('[3] registrando na plataforma Weduu...');
    const platform = createPlatformClient({ platformUrl: cfg.platformUrl, logger: createLogger() });
    const creds = await platform.register(cfg.webhookName, tunnel.url);
    service.setCredentials(creds);
    console.log(`    cid=${creds.cid}`);

    console.log('[4] pedindo lote e processando...\n');
    const info = await service.requestBurst();
    const run = await Promise.race([completed, sleep(120000).then(() => null)]);
    if (!run) throw new Error('o lote não terminou em 120 s');
    console.log(`\n[5] lote ${info.run_id} concluído.`);
    if (!run.callback.report) throw new Error(`callback não confirmado (estado: ${run.callback.state})`);
    const ok = printRealReport(run.callback.report);
    console.log(ok ? 'RESULTADO: APROVADO' : 'RESULTADO: COM FALHAS');
    await finish(ok);
  } else {
    // ---------- MODO LOCAL ----------
    const mock = createMockPlatform({
      total: num(process.env.TOTAL, 20),
      dupRate: num(process.env.DUP_RATE, 0.15),
      errorRate: num(process.env.ERROR_RATE, 0.1),
    });
    const platformUrl = `http://127.0.0.1:${await mock.listen(0)}`;
    cleanups.push(() => mock.close());

    // Logs completos do serviço (retries, 429, run_complete) para acompanhar o que acontece.
    const service = createService({ platformUrl, logger: createLogger() });
    const serviceUrl = `http://127.0.0.1:${await service.listen(0)}`;
    cleanups.push(() => service.close());

    // 1) Registro: a plataforma chama <webhook>/check e devolve cid/token.
    const res = await fetch(`${platformUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo-local', webhook: serviceUrl }),
    });
    const creds = await res.json();
    console.log(`\n[1] registrado (status ${res.status}): cid=${creds.cid}`);
    service.setCredentials(creds);

    // 2) Lote: a plataforma envia as mensagens ao /process e o serviço processa e dá o callback.
    console.log('[2] pedindo lote...\n');
    const waiter = mock.waitForReport(120000);
    const info = await service.requestBurst();
    const report = await waiter;

    // 3) Relatório gerado pela plataforma simulada.
    const { latency_samples, enrich_ok_by_sku, ...resumo } = report;
    console.log(`\n[3] lote ${info.run_id} concluído. Relatório:`);
    console.table(resumo);
    const ok = report.lost === 0 && report.divergences === 0 && report.peak_concurrency <= 3 && report.sla_violations === 0;
    console.log(ok ? 'RESULTADO: APROVADO' : 'RESULTADO: COM FALHAS');
    await finish(ok);
  }
} catch (err) {
  const hint = err.code === 'EADDRINUSE'
    ? ' A porta já está em uso, provavelmente por um `npm start` aberto. Encerre-o (Ctrl+C) e tente de novo: o demo sobe o serviço sozinho.'
    : '';
  console.error(`\nERRO: ${err.message}.${hint}`);
  await finish(false);
}

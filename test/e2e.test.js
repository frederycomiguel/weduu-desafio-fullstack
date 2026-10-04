import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setup, runBurst } from './helpers.js';

function assertHealthy(report, total) {
  assert.equal(report.total, total);
  assert.equal(report.lost, 0, `perdidos: ${report.lost_seqs}`);
  assert.equal(report.divergences, 0, JSON.stringify(report.divergence_details));
  assert.equal(report.processed, total);
  assert.ok(report.peak_concurrency <= 3, `pico ${report.peak_concurrency}`);
  assert.ok(report.ack_avg_ms < 300, `ack medio ${report.ack_avg_ms}`);
  for (const [sku, n] of Object.entries(report.enrich_ok_by_sku)) assert.equal(n, 1, `${sku} enriquecido ${n}x com sucesso`);
  assert.equal(Object.keys(report.enrich_ok_by_sku).length, total);
}

describe('e2e', { concurrency: false }, () => {
  test('fluxo feliz: 20 SKUs, duplicatas, 429/500 padrao', async () => {
    const ctx = await setup({ mock: { seed: 7 } });
    try {
      assert.equal(ctx.registerStatus, 200);
      const { report } = await runBurst(ctx);
      assertHealthy(report, 20);
      assert.ok(report.duplicates >= 1);
      assert.equal(report.received, 20 + report.duplicates);
      assert.equal(report.sla_violations, 0);
      assert.ok(report.ack_max_ms < 600, `ack max ${report.ack_max_ms}`);
    } finally { await ctx.teardown(); }
  });

  test('taxa de 500 alta (40%) nao gera perda', async () => {
    const ctx = await setup({ mock: { seed: 3, errorRate: 0.4 }, service: { backoffBaseMs: 20 } });
    try {
      const { report } = await runBurst(ctx);
      assertHealthy(report, 20);
      assert.ok(report.errors_500 > 0, 'esperava ao menos um 500');
    } finally { await ctx.teardown(); }
  });

  test('enrich lento (1.2-2s) segue sem perda e <=3 em voo', async () => {
    const ctx = await setup({ mock: { seed: 5, enrichMin: 1200, enrichMax: 2000 } });
    try {
      const { report } = await runBurst(ctx);
      assertHealthy(report, 20);
    } finally { await ctx.teardown(); }
  });

  test('dupRate alto (60%): duplicatas contadas e nao reprocessadas', async () => {
    const ctx = await setup({ mock: { seed: 11, dupRate: 0.6 } });
    try {
      const { report } = await runBurst(ctx);
      assertHealthy(report, 20);
      assert.equal(report.duplicates, 12);
      assert.equal(report.enrich_ok, 20);
      const run = ctx.completed[0];
      if (run && typeof run === 'object' && 'duplicates' in run) assert.ok(run.duplicates >= 1);
    } finally { await ctx.teardown(); }
  });

  test('/process chegando ANTES da resposta do /burst', async () => {
    const ctx = await setup({ mock: { seed: 13, processBeforeBurstResponse: true, burstResponseDelayMs: 500 } });
    try {
      const { report } = await runBurst(ctx);
      assertHealthy(report, 20);
    } finally { await ctx.teardown(); }
  });

  test('handshake com token errado => 422', async () => {
    const ctx = await setup({ register: false });
    try {
      // serviço "quebrado": um webhook que nao ecoa o token
      const http = await import('node:http');
      const bad = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"token":"errado"}'); });
      await new Promise((r) => bad.listen(0, '127.0.0.1', r));
      const r = await fetch(`${ctx.platformUrl}/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x', webhook: `http://127.0.0.1:${bad.address().port}` }),
      });
      assert.equal(r.status, 422);
      const j = await r.json();
      assert.equal(j.error, 'handshake_failed');
      bad.close();
      // e o /check real do serviço ecoa corretamente
      const c = await fetch(`${ctx.serviceUrl}/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'abc' }) });
      assert.equal(c.status, 200);
      assert.equal((await c.json()).token, 'abc');
    } finally { await ctx.teardown(); }
  });

  test('200 SKUs', async () => {
    const ctx = await setup({ mock: { seed: 17, total: 200 } });
    try {
      const { report } = await runBurst(ctx, 240000);
      assert.equal(report.total, 200);
      assert.equal(report.lost, 0);
      assert.equal(report.divergences, 0);
      assert.ok(report.peak_concurrency <= 3);
      assert.equal(Object.keys(report.enrich_ok_by_sku).length, 200);
      for (const n of Object.values(report.enrich_ok_by_sku)) assert.equal(n, 1);
    } finally { await ctx.teardown(); }
  });

  test('requestBurst() do serviço dispara o burst e conclui', async () => {
    const ctx = await setup({ mock: { seed: 19 } });
    try {
      const p = ctx.mock.waitForReport(60000);
      await ctx.service.requestBurst();
      const report = await p;
      assertHealthy(report, 20);
    } finally { await ctx.teardown(); }
  });

  test('429 forcado (concorrencia do cliente 6 > limite 3): sem perda, retry-after respeitado', async () => {
    const ctx = await setup({ mock: { seed: 23, errorRate: 0.2 }, service: { concurrency: 6, backoffBaseMs: 20 } });
    try {
      const { report } = await runBurst(ctx);
      assert.equal(report.lost, 0);
      assert.equal(report.divergences, 0);
      assert.ok(report.rate_limited_429 > 0, 'esperava 429');
      assert.ok(report.peak_concurrency <= 3);
      for (const n of Object.values(report.enrich_ok_by_sku)) assert.equal(n, 1);
      assert.equal(Object.keys(report.enrich_ok_by_sku).length, 20);
    } finally { await ctx.teardown(); }
  });
});

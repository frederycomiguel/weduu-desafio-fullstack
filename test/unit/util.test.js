import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore, backoffDelay } from '../../src/util.js';
import { WorkQueue } from '../../src/queue.js';
import { RunStore } from '../../src/run-store.js';

test('backoffDelay: exponencial com jitter e teto', () => {
  for (let i = 0; i < 200; i++) {
    assert.ok(backoffDelay(1, 100) < 200);
    assert.ok(backoffDelay(3, 100) < 800);
    assert.ok(backoffDelay(20, 100) < 8000);
    assert.ok(backoffDelay(20, 100, 500) < 500);
  }
});

test('Semaphore nunca excede o limite', async () => {
  const sem = new Semaphore(3);
  let cur = 0, peak = 0;
  await Promise.all(Array.from({ length: 20 }, () => sem.run(async () => {
    cur++; peak = Math.max(peak, cur);
    await new Promise((r) => setTimeout(r, 10));
    cur--;
  })));
  assert.equal(peak, 3);
});

test('Semaphore libera mesmo se a função lançar', async () => {
  const sem = new Semaphore(1);
  await assert.rejects(sem.run(async () => { throw new Error('x'); }));
  assert.equal(await sem.run(async () => 'ok'), 'ok');
});

test('WorkQueue respeita concorrência e processa tudo; erro não trava', async () => {
  let cur = 0, peak = 0; const done = []; const errs = [];
  const q = new WorkQueue({ concurrency: 3, onError: (e, j) => errs.push(j),
    handler: async (j) => { cur++; peak = Math.max(peak, cur); await new Promise((r) => setTimeout(r, 5)); cur--; if (j === 4) throw new Error('b'); done.push(j); } });
  for (let i = 0; i < 15; i++) q.push(i);
  while (q.size || q.active) await new Promise((r) => setTimeout(r, 10));
  assert.equal(peak, 3);
  assert.equal(done.length, 14);
  assert.deepEqual(errs, [4]);
});

test('RunStore: dedupe de seq, contadores e conclusão', () => {
  const s = new RunStore();
  assert.equal(s.addItem('r', 0, 'sku-001'), true);
  assert.equal(s.addItem('r', 0, 'sku-001'), false);
  assert.equal(s.addItem('r', 1, 'sku-002'), true);
  const run = s.get('r');
  assert.equal(run.counters.duplicates, 1);
  assert.equal(run.counters.received, 2);
  assert.equal(s.isComplete(run), false); // total desconhecido
  s.setTotal('r', 2);
  assert.equal(s.isComplete(run), false);
  s.markDone(run, 0, { price: 1, stock: 2 });
  s.markDone(run, 0, { price: 9, stock: 9 }); // idempotente
  s.markFailed(run, 1, 'boom');
  assert.equal(s.isComplete(run), true);
  assert.deepEqual(s.buildResult(run), [{ seq: 0, sku: 'sku-001', price: 1, stock: 2 }]);
  assert.equal(s.failures(run).length, 1);
});

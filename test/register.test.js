// O gatilho local POST /register registra o webhook na plataforma (mock) e libera o /burst.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPlatform } from './mock-platform/server.js';
import { createService } from '../src/app.js';

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('POST /register guarda credenciais e libera o /burst; rejeita corpo inválido', async () => {
  const mock = createMockPlatform();
  const platformUrl = `http://127.0.0.1:${await mock.listen(0)}`;
  const service = createService({ platformUrl, logger: { info() {}, warn() {}, error() {} } });
  const serviceUrl = `http://127.0.0.1:${await service.listen(0)}`;
  try {
    // sem credenciais, o burst falha
    assert.equal((await post(`${serviceUrl}/burst`, {})).status, 502);

    assert.equal((await post(`${serviceUrl}/register`, { name: 'x' })).status, 400);

    const res = await post(`${serviceUrl}/register`, { name: 'teste', webhook: serviceUrl });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.cid);
    assert.equal(body.token, undefined, 'o token não deve ser devolvido');

    assert.equal((await post(`${serviceUrl}/burst`, {})).status, 200);
  } finally {
    await service.close();
    await mock.close();
  }
});

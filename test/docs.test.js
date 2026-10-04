// Garante que a documentação interativa (Swagger UI) e a especificação OpenAPI são servidas
// e que a spec descreve todas as rotas realmente implementadas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/app.js';

test('/docs serve o Swagger UI e /openapi.json descreve as rotas', async () => {
  const service = createService({ logger: { info() {}, warn() {}, error() {} } });
  const port = await service.listen(0);
  try {
    const docs = await fetch(`http://127.0.0.1:${port}/docs`);
    assert.equal(docs.status, 200);
    assert.match(docs.headers.get('content-type'), /text\/html/);
    assert.match(await docs.text(), /SwaggerUIBundle/);

    const spec = await (await fetch(`http://127.0.0.1:${port}/openapi.json`)).json();
    assert.equal(spec.openapi, '3.0.3');
    for (const path of ['/check', '/process', '/health', '/runs/{id}', '/burst']) {
      assert.ok(spec.paths[path], `spec sem a rota ${path}`);
    }

    const platform = await (await fetch(`http://127.0.0.1:${port}/openapi-platform.json`)).json();
    for (const path of ['/register', '/burst/{cid}', '/enrich/{sku}', '/callback']) {
      assert.ok(platform.paths[path], `spec da plataforma sem a rota ${path}`);
    }
  } finally {
    await service.close();
  }
});

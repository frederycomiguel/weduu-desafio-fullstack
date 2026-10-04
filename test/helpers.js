import { createMockPlatform } from './mock-platform/server.js';
import { createService } from '../src/app.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

// Sobe mock + serviço em portas aleatórias, registra e devolve tudo.
export async function setup({ mock: mockOpts = {}, service: svcOpts = {}, register = true } = {}) {
  const mock = createMockPlatform(mockOpts);
  const mockPort = await mock.listen(0);
  const platformUrl = `http://127.0.0.1:${mockPort}`;
  const completed = [];
  const service = createService({
    platformUrl,
    logger: { info() {}, warn() {}, error() {}, debug() {}, log() {} },
    onRunComplete: (r) => completed.push(r),
    ...svcOpts,
  });
  const lp = await service.listen(0);
  const port = typeof lp === 'number' ? lp : service.server.address().port;
  const serviceUrl = `http://127.0.0.1:${port}`;
  const ctx = { mock, service, platformUrl, serviceUrl, completed, mockPort, port };
  if (register) {
    const res = await fetch(`${platformUrl}/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'teste', webhook: serviceUrl }),
    });
    ctx.registerStatus = res.status;
    ctx.creds = await res.json();
    service.setCredentials(ctx.creds);
  }
  ctx.teardown = async () => { await service.close(); await mock.close(); };
  return ctx;
}

// Dispara burst no mock (direto, como a plataforma real faria) e espera o callback.
export async function runBurst(ctx, timeoutMs = 120000) {
  // Como em produção: o serviço pede o burst (precisa saber o total) e a plataforma dispara /process.
  const waiter = ctx.mock.waitForReport(timeoutMs);
  const info = await ctx.service.requestBurst();
  const report = await waiter;
  return { info, report };
}

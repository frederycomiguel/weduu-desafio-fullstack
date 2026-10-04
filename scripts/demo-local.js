// Demonstração local ponta a ponta, sem ngrok e sem a plataforma real. Uso: `npm run demo`.
// Sobe a plataforma simulada e o serviço, registra, pede um lote, espera o callback
// e imprime o relatório. Variáveis opcionais: TOTAL (SKUs), DUP_RATE (0 a 1), ERROR_RATE (0 a 1).
import { createMockPlatform } from '../test/mock-platform/server.js';
import { createService } from '../src/app.js';
import { createLogger } from '../src/logger.js';

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

const mock = createMockPlatform({
  total: num(process.env.TOTAL, 20),
  dupRate: num(process.env.DUP_RATE, 0.15),
  errorRate: num(process.env.ERROR_RATE, 0.1),
});
const platformUrl = `http://127.0.0.1:${await mock.listen(0)}`;

// Logs completos do serviço (retries, 429, run_complete) para acompanhar o que acontece.
const service = createService({ platformUrl, logger: createLogger() });
const serviceUrl = `http://127.0.0.1:${await service.listen(0)}`;

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

await service.close();
await mock.close();
process.exit(ok ? 0 : 1);

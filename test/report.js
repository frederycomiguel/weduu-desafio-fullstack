// Roda um burst completo contra o mock local e grava reports/melhor-execucao.{json,md}
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, runBurst } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'reports');
fs.mkdirSync(outDir, { recursive: true });

const ctx = await setup({ mock: { seed: Number(process.env.SEED) || 42 } });
try {
  const { report } = await runBurst(ctx);
  const { latency_samples, ...clean } = report;
  const out = { gerado_em: new Date().toISOString(), ambiente: 'mock local (test/mock-platform)', ...clean };
  fs.writeFileSync(path.join(outDir, 'melhor-execucao.json'), JSON.stringify({ ...out, latency_samples }, null, 2));
  const ok = report.lost === 0 && report.divergences === 0 && report.peak_concurrency <= 3 && report.sla_violations === 0;
  const md = `# Melhor execução (mock local)

Gerado em ${out.gerado_em}. Resultado: **${ok ? 'APROVADO' : 'COM FALHAS'}**

| Métrica | Valor |
|---|---|
| Run | \`${report.run_id}\` |
| SKUs no burst | ${report.total} |
| ACK médio (sem a 1ª) | ${report.ack_avg_ms} ms |
| ACK máximo | ${report.ack_max_ms} ms |
| Violações de SLA (>600ms) | ${report.sla_violations} |
| Mensagens recebidas (com duplicatas) | ${report.received} |
| Processadas (únicas) | ${report.processed} |
| Duplicadas | ${report.duplicates} |
| Perdidas | ${report.lost} |
| Divergências | ${report.divergences} |
| Chamadas ao enrich | ${report.enrich_calls} (${report.enrich_ok} com sucesso) |
| Pico de concorrência no enrich | ${report.peak_concurrency} (limite 3) |
| Respostas 429 | ${report.rate_limited_429} |
| Respostas 500 | ${report.errors_500} |

Cada SKU foi enriquecido com sucesso exatamente uma vez: ${Object.values(report.enrich_ok_by_sku).every((n) => n === 1)}.
`;
  fs.writeFileSync(path.join(outDir, 'melhor-execucao.md'), md);
  console.log(md);
} finally { await ctx.teardown(); }

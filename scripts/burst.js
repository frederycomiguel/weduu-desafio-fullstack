// Dispara um novo lote (burst) na plataforma e imprime o run_id. Uso: `npm run burst`.
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();

// O serviço em execução (npm start) é quem chama a plataforma, para registrar o total do run.
// Por isso este script não fala direto com a plataforma: ele só aciona o gatilho local POST /burst.
const res = await fetch(`http://localhost:${cfg.port}/burst`, { method: 'POST' });
const body = await res.json();
if (!res.ok) {
  console.error('falha ao iniciar burst:', body);
  process.exit(1);
}
console.log(JSON.stringify(body));
console.log(`acompanhe em GET http://localhost:${cfg.port}/runs/${body.run_id}`);

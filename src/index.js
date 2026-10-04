// Ponto de entrada (`npm start`): sobe o serviço HTTP que a plataforma Weduu vai chamar.
import { readFileSync, existsSync } from 'node:fs';
import { createService } from './app.js';
import { loadConfig } from './config.js';

const cfg = loadConfig();
const service = createService();

// Se já houve registro (npm run register), carrega cid/token salvos em disco.
// Sem isso o serviço responde /check e /process, mas não consegue chamar /enrich, /burst nem /callback.
if (existsSync(cfg.credentialsFile)) {
  service.setCredentials(JSON.parse(readFileSync(cfg.credentialsFile, 'utf8')));
}

await service.listen(cfg.port);
console.log(JSON.stringify({ msg: 'listening', port: cfg.port, platform: cfg.platformUrl }));

// Encerramento limpo ao receber Ctrl+C ou SIGTERM: para a fila, fecha o servidor e sai.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => service.close().then(() => process.exit(0)));

// Registra o webhook na plataforma e salva cid/token em disco. Uso: `WEBHOOK_URL=https://... npm run register`.
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createPlatformClient } from '../src/platform-client.js';
import { createLogger } from '../src/logger.js';

const cfg = loadConfig();
const platform = createPlatformClient({ platformUrl: cfg.platformUrl, logger: createLogger() });

// A plataforma chama <webhook>/check durante o registro: o serviço precisa estar no ar.
const { cid, token } = await platform.register(cfg.webhookName, cfg.webhookUrl);
// Credenciais ficam só neste arquivo (listado no .gitignore); `npm start` as lê na inicialização.
writeFileSync(cfg.credentialsFile, JSON.stringify({ cid, token }, null, 2));
console.log(`registrado: cid=${cid} (salvo em ${cfg.credentialsFile})`);

/**
 * Converte uma variável de ambiente em inteiro >= 0.
 * Se estiver ausente, não for número ou for negativa, devolve o valor padrão `d`.
 */
const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

/**
 * Lê a configuração do serviço a partir das variáveis de ambiente (com padrões sensatos).
 * Recebe `env` como parâmetro para facilitar testes (por padrão usa process.env).
 *
 * Variáveis:
 *  - PORT                  porta HTTP do serviço (4000)
 *  - PLATFORM_URL          URL base da plataforma Weduu (sem barra final)
 *  - WEBHOOK_NAME          nome enviado no /register
 *  - WEBHOOK_URL           URL pública HTTPS (ngrok) enviada no /register
 *  - ENRICH_CONCURRENCY    máx. de chamadas /enrich em voo (3, mínimo 1: é o limite da plataforma)
 *  - ENRICH_MAX_RETRIES    tentativas extras do /enrich em erro 5xx/rede (6)
 *  - CALLBACK_MAX_RETRIES  tentativas extras do /callback (5)
 *  - BACKOFF_BASE_MS       base do backoff exponencial em ms (200)
 *  - CREDENTIALS_FILE      arquivo onde ficam cid/token após o registro (.credentials.json)
 */
export function loadConfig(env = process.env) {
  const port = int(env.PORT, 4000);
  return {
    port,
    platformUrl: (env.PLATFORM_URL || 'https://dev-wdu-ped-test-1014944555984.us-central1.run.app').replace(/\/+$/, ''),
    webhookName: env.WEBHOOK_NAME || 'weduu-webhook-service',
    webhookUrl: env.WEBHOOK_URL || `http://localhost:${port}`,
    enrichConcurrency: Math.max(1, int(env.ENRICH_CONCURRENCY, 3)),
    enrichMaxRetries: int(env.ENRICH_MAX_RETRIES, 6),
    callbackMaxRetries: int(env.CALLBACK_MAX_RETRIES, 5),
    backoffBaseMs: int(env.BACKOFF_BASE_MS, 200),
    credentialsFile: env.CREDENTIALS_FILE || '.credentials.json',
  };
}

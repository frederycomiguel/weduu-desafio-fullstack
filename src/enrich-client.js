import { HttpError, request } from './platform-client.js';
import { Semaphore, backoffDelay, sleep } from './util.js';

const MAX_429_WAITS = 60; // trava de segurança; 429 não consome tentativas normais

/**
 * Cliente do /enrich com semáforo GLOBAL (limite de requisições em voo da plataforma).
 * O semáforo cobre só a requisição; esperas de backoff/retry-after ocorrem fora dele.
 *
 * Por que fora do semáforo: se a espera ficasse dentro, um worker aguardando backoff
 * ocuparia uma das 3 vagas sem fazer trabalho, deixando a plataforma ociosa.
 *
 * @param {object}   opts
 * @param {string}   opts.platformUrl    URL base da plataforma
 * @param {Function} opts.getCredentials devolve { cid, token } (lido a cada tentativa)
 * @param {number}   opts.concurrency    máx. de requisições simultâneas (3)
 * @param {number}   opts.maxRetries     máx. de falhas "normais" (5xx/rede/timeout) antes de desistir
 * @param {number}   opts.backoffBaseMs  base do backoff exponencial
 * @param {number}   opts.timeoutMs      timeout de cada requisição
 * @param {object}   opts.logger         logger estruturado (opcional)
 */
export function createEnrichClient({ platformUrl, getCredentials, concurrency = 3, maxRetries = 6, backoffBaseMs = 200, timeoutMs = 5000, logger }) {
  const sem = new Semaphore(concurrency);

  /**
   * Consulta preço e estoque de um SKU, com tratamento completo de falhas:
   *  - 200: devolve { sku, price, stock };
   *  - 401/404: erro PERMANENTE (retentar não adianta) -> lança com `permanent: true`;
   *  - 429: a plataforma pediu para esperar; aguarda o `retry-after` e tenta de novo SEM
   *    gastar o orçamento de retries (não é falha do item), limitado por MAX_429_WAITS;
   *  - 500/timeout/erro de rede: falha transitória; espera com backoff exponencial + jitter
   *    e tenta de novo, até `maxRetries` falhas.
   *
   * @param {string} sku
   * @param {{onRetry?: Function, onRateLimited?: Function}} hooks callbacks para contar métricas no run
   */
  async function enrich(sku, hooks = {}) {
    let failures = 0;
    let waits429 = 0;
    for (;;) {
      const { cid, token } = getCredentials();
      try {
        return await sem.run(() =>
          request(`${platformUrl}/enrich/${encodeURIComponent(sku)}`, {
            headers: { 'x-cid': cid, 'x-token': token },
            timeoutMs,
          }),
        );
      } catch (err) {
        // Credencial inválida ou SKU inexistente: não adianta tentar de novo.
        if (err instanceof HttpError && (err.status === 401 || err.status === 404)) {
          throw Object.assign(new Error(`enrich ${sku}: HTTP ${err.status}`), { permanent: true });
        }
        // Limite de concorrência estourado: respeita o retry-after (com um pequeno jitter).
        if (err instanceof HttpError && err.status === 429) {
          hooks.onRateLimited?.();
          if (++waits429 > MAX_429_WAITS) throw new Error(`enrich ${sku}: rate limited demais`);
          const ra = Number(err.headers.get('retry-after'));
          const delay = (ra > 0 ? ra * 1000 : 500) + Math.random() * 100;
          logger?.warn('enrich_429', { sku, delay_ms: Math.round(delay) });
          await sleep(delay);
          continue;
        }
        // Qualquer outra falha (500, timeout, rede) é tratada como transitória.
        if (++failures > maxRetries) {
          throw new Error(`enrich ${sku}: esgotou retries (${err.message})`);
        }
        hooks.onRetry?.();
        const delay = backoffDelay(failures, backoffBaseMs);
        logger?.warn('enrich_retry', { sku, attempt: failures, error: err.message, delay_ms: Math.round(delay) });
        await sleep(delay);
      }
    }
  }

  return { enrich };
}

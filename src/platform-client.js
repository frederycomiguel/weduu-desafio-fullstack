import { backoffDelay, sleep } from './util.js';

/**
 * Erro lançado quando a plataforma responde com status HTTP fora de 2xx.
 * Guarda status, corpo e headers para quem chamou decidir (ex.: ler `retry-after` no 429).
 */
export class HttpError extends Error {
  constructor(status, body, headers) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/**
 * Faz uma requisição HTTP com timeout e devolve o corpo já convertido de JSON.
 * - Envia `content-type: application/json` e serializa `body` quando houver.
 * - Aborta após `timeoutMs` (AbortSignal.timeout).
 * - Se o corpo não for JSON válido, devolve o texto cru.
 * - Status fora de 2xx lança HttpError; erros de rede/timeout propagam como erros comuns.
 */
export async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 5000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* corpo não-JSON */ }
  if (!res.ok) throw new HttpError(res.status, data, res.headers);
  return data;
}

/**
 * Cliente dos endpoints da plataforma que o serviço CONSOME: /register, /burst e /callback.
 * (O /enrich fica em enrich-client.js por precisar de semáforo e retries próprios.)
 */
export function createPlatformClient({ platformUrl, logger, callbackMaxRetries = 5, backoffBaseMs = 200, timeoutMs = 8000 }) {
  return {
    /**
     * POST /register: registra o webhook. A plataforma chama <webhook>/check e,
     * se o token for ecoado, devolve { cid, token }.
     */
    register: (name, webhook) =>
      request(`${platformUrl}/register`, { method: 'POST', body: { name, webhook }, timeoutMs }),

    /**
     * POST /burst/:cid: pede um novo lote. Devolve { run_id, total, started_at };
     * depois a plataforma envia as `total` mensagens para o nosso /process.
     */
    burst: (cid, token) =>
      request(`${platformUrl}/burst/${encodeURIComponent(cid)}`, { method: 'POST', headers: { 'x-token': token }, timeoutMs }),

    /**
     * POST /callback: entrega o resultado consolidado do run e devolve o relatório da plataforma.
     * Retenta erros de rede, 5xx e 429 (respeitando retry-after); demais 4xx são definitivos
     * e propagam na hora. Após `callbackMaxRetries` tentativas extras, propaga o último erro.
     */
    async callback({ cid, token }, runId, result) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await request(`${platformUrl}/callback`, {
            method: 'POST',
            headers: { 'x-token': token },
            body: { cid, run_id: runId, result },
            timeoutMs,
          });
        } catch (err) {
          const retryable = !(err instanceof HttpError) || err.status >= 500 || err.status === 429;
          if (!retryable || attempt >= callbackMaxRetries) throw err;
          const ra = Number(err.headers?.get('retry-after'));
          const delay = err.status === 429 && ra > 0 ? ra * 1000 : backoffDelay(attempt + 1, backoffBaseMs);
          logger?.warn('callback_retry', { run_id: runId, attempt: attempt + 1, error: err.message, delay_ms: Math.round(delay) });
          await sleep(delay);
        }
      }
    },
  };
}

import http from 'node:http';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { WorkQueue } from './queue.js';
import { RunStore } from './run-store.js';
import { createEnrichClient } from './enrich-client.js';
import { createPlatformClient } from './platform-client.js';

// Tamanho máximo aceito para o corpo de uma requisição (proteção contra payloads gigantes).
const MAX_BODY = 1024 * 1024;

/**
 * Lê o corpo de uma requisição HTTP e o converte de JSON.
 * Rejeita com 'body too large' se passar de MAX_BODY (e derruba a conexão) ou
 * com 'invalid json' se o texto não for um JSON válido.
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

/** Responde com `status` e `body` serializado em JSON (já definindo content-type e content-length). */
function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * Cria o serviço completo (servidor HTTP + fila + estado + clientes da plataforma).
 *
 * Fluxo resumido:
 *   POST /process  -> valida, deduplica, responde ACK 202 e enfileira (rápido, sem I/O externo)
 *   WorkQueue      -> workers chamam /enrich (no máx. 3 em voo) e gravam o resultado no RunStore
 *   maybeComplete  -> quando todos os seqs terminaram, envia o POST /callback uma única vez
 *
 * Tudo que varia (URL da plataforma, concorrência, retries, backoff, logger) pode ser
 * sobrescrito via `opts`, o que permite testes rápidos e sem acesso à plataforma real.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.platformUrl]        URL base da plataforma (ou do mock)
 * @param {number}   [opts.concurrency]        máx. de /enrich em voo e de workers
 * @param {number}   [opts.maxRetries]         retries do /enrich
 * @param {number}   [opts.callbackMaxRetries] retries do /callback
 * @param {number}   [opts.backoffBaseMs]      base do backoff
 * @param {number}   [opts.enrichTimeoutMs]    timeout de cada /enrich
 * @param {object}   [opts.logger]             logger {info,warn,error}
 * @param {object}   [opts.credentials]        { cid, token } já conhecidos
 * @param {Function} [opts.onRunComplete]      chamado ao fim de cada run (depois do callback)
 */
export function createService(opts = {}) {
  const cfg = loadConfig();
  const logger = opts.logger ?? createLogger();
  const platformUrl = (opts.platformUrl ?? cfg.platformUrl).replace(/\/+$/, '');
  const backoffBaseMs = opts.backoffBaseMs ?? cfg.backoffBaseMs;
  const concurrency = opts.concurrency ?? cfg.enrichConcurrency;
  let credentials = opts.credentials ?? null;

  /** Devolve { cid, token }; lança erro permanente se o serviço ainda não foi registrado. */
  const getCredentials = () => {
    if (!credentials) throw Object.assign(new Error('sem credenciais'), { permanent: true });
    return credentials;
  };

  const store = new RunStore();
  const platform = createPlatformClient({
    platformUrl, logger, backoffBaseMs,
    callbackMaxRetries: opts.callbackMaxRetries ?? cfg.callbackMaxRetries,
  });
  const enrichClient = createEnrichClient({
    platformUrl, getCredentials, logger, backoffBaseMs, concurrency,
    maxRetries: opts.maxRetries ?? cfg.enrichMaxRetries,
    timeoutMs: opts.enrichTimeoutMs ?? 5000,
  });

  // Fila que alimenta os workers; cada job é { runId, seq, sku } e é tratado por processItem.
  const queue = new WorkQueue({
    concurrency,
    handler: processItem,
    onError: (err, job) => logger.error('worker_error', { run_id: job.runId, seq: job.seq, error: err.message }),
  });

  /**
   * Processa UM item da fila: consulta o /enrich do SKU e grava o resultado.
   * - Cache por SKU dentro do run: se dois itens têm o mesmo SKU, compartilham a mesma
   *   Promise (inclusive enquanto a chamada ainda está em voo), então o /enrich é chamado 1x.
   * - Falhas transitórias são removidas do cache para permitir nova tentativa; falhas
   *   permanentes (401/404) ficam, pois repetir não mudaria nada.
   * - Em sucesso marca o item como done; em falha definitiva marca como failed e loga.
   * - No fim sempre verifica se o run inteiro já terminou (maybeComplete).
   */
  async function processItem({ runId, seq, sku }) {
    const run = store.get(runId);
    // Cache por sku no run: SKUs repetidos compartilham a mesma chamada.
    let p = run.skuCache.get(sku);
    if (!p) {
      p = enrichClient.enrich(sku, {
        onRetry: () => run.counters.retries++,
        onRateLimited: () => run.counters.rateLimited++,
      });
      run.skuCache.set(sku, p);
      p.catch((err) => { if (!err.permanent) run.skuCache.delete(sku); });
    }
    try {
      const { price, stock } = await p;
      store.markDone(run, seq, { price, stock });
    } catch (err) {
      store.markFailed(run, seq, err.message);
      logger.error('item_failed', { run_id: runId, seq, sku, error: err.message });
    }
    await maybeComplete(run);
  }

  /**
   * Se o run terminou (todos os seqs 0..total-1 finalizados), consolida o resultado e
   * envia o POST /callback. Garantias:
   *  - Só dispara uma vez: o estado muda de 'idle' para 'sending' de forma SÍNCRONA
   *    (antes de qualquer await), então duas chamadas concorrentes não enviam em duplicidade.
   *  - Guarda no run o relatório que a plataforma devolve no /callback.
   *  - Em falha do callback (após os retries) marca 'failed' e registra em log.
   *  - Por fim notifica o hook opcional `onRunComplete` (usado nos testes).
   */
  async function maybeComplete(run) {
    if (run.callback.state !== 'idle' || !store.isComplete(run)) return;
    run.callback.state = 'sending'; // trava síncrona: garante um único envio automático
    const result = store.buildResult(run);
    const failures = store.failures(run);
    logger.info('run_complete', { run_id: run.id, total: run.total, ok: result.length, failed: failures.length });
    try {
      const report = await platform.callback(getCredentials(), run.id, result);
      run.callback.state = 'sent';
      run.callback.sentAt = new Date().toISOString();
      run.callback.report = report; // relatório devolvido pela plataforma
      logger.info('callback_sent', { run_id: run.id, items: result.length, report });
    } catch (err) {
      run.callback.state = 'failed';
      logger.error('callback_failed', { run_id: run.id, error: err.message });
    }
    try {
      await opts.onRunComplete?.({ ...store.summary(run), result, failures });
    } catch (err) {
      logger.error('on_run_complete_error', { error: err.message });
    }
  }

  /**
   * POST /process: recebe uma mensagem do lote. É o caminho crítico do SLA de 600 ms,
   * por isso faz o mínimo possível:
   *   1) lê e valida o JSON ({run_id: string, seq: inteiro >= 0, sku: string}) -> 400 se inválido;
   *   2) registra no RunStore, que deduplica por run_id+seq;
   *   3) responde 202 IMEDIATAMENTE (ack), informando se era duplicata;
   *   4) só depois do ack enfileira o job (se for novo). Nenhum I/O externo acontece antes do ack.
   * Duplicatas também recebem 2xx (a plataforma exige 2xx) mas não são reprocessadas.
   */
  async function handleProcess(req, res) {
    let body;
    try { body = await readJson(req); } catch (err) { return send(res, 400, { error: err.message }); }
    const { run_id: runId, seq, sku } = body ?? {};
    if (typeof runId !== 'string' || !runId || !Number.isInteger(seq) || seq < 0 || typeof sku !== 'string' || !sku) {
      return send(res, 400, { error: 'expected {run_id:string, seq:int>=0, sku:string}' });
    }
    const isNew = store.addItem(runId, seq, sku);
    send(res, 202, { ok: true, duplicate: !isNew }); // ack antes de qualquer trabalho
    if (isNew) queue.push({ runId, seq, sku });
  }

  /**
   * Roteador HTTP. Rotas:
   *  - POST /check     validação do webhook: devolve o mesmo token recebido
   *  - POST /process   recebimento das mensagens do lote (ver handleProcess)
   *  - POST /burst     gatilho LOCAL (não faz parte do contrato da plataforma): usado por
   *                    scripts/burst.js para pedir um lote de dentro deste processo, que é
   *                    quem precisa guardar o `total` do run
   *  - GET  /health    estado da fila (tamanho e workers ativos)
   *  - GET  /runs/:id  resumo/contadores de um run (observabilidade e testes)
   * Qualquer erro inesperado vira 500 sem derrubar o servidor.
   */
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x');
      if (req.method === 'POST' && pathname === '/process') return await handleProcess(req, res);
      if (req.method === 'POST' && pathname === '/check') {
        const body = await readJson(req).catch(() => null);
        if (!body || typeof body.token !== 'string') return send(res, 400, { error: 'token required' });
        return send(res, 200, { token: body.token });
      }
      // Gatilho local usado por scripts/burst.js: o serviço precisa registrar o total do run.
      if (req.method === 'POST' && pathname === '/burst') {
        try { return send(res, 200, await service.requestBurst()); } catch (err) {
          return send(res, 502, { error: err.message });
        }
      }
      if (req.method === 'GET' && pathname === '/health') {
        return send(res, 200, { status: 'ok', queued: queue.size, active: queue.active });
      }
      const m = req.method === 'GET' && pathname.match(/^\/runs\/([^/]+)$/);
      if (m) {
        const run = store.get(decodeURIComponent(m[1]));
        return run ? send(res, 200, store.summary(run)) : send(res, 404, { error: 'run not found' });
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      logger.error('http_error', { error: err.message });
      if (!res.headersSent) send(res, 500, { error: 'internal' });
    }
  });
  // Mantém conexões ociosas abertas por 30 s: a plataforma envia as 20 mensagens em
  // rajada e reaproveitar conexões evita custo de novo handshake (ajuda no ACK).
  server.keepAliveTimeout = 30_000;

  /** API pública do serviço (usada por src/index.js e pelos testes). */
  const service = {
    server,
    /** Sobe o servidor na porta indicada (0 = porta aleatória) e resolve com a porta real. */
    listen: (port = cfg.port) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => resolve(server.address().port));
      }),
    /** Encerra tudo: esvazia a fila, fecha o servidor e derruba conexões abertas. */
    close: () =>
      new Promise((resolve) => {
        queue.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    /** Define cid/token (depois do registro, ou lidos do .credentials.json). */
    setCredentials(c) { credentials = c; },
    /**
     * Pede um novo lote à plataforma (POST /burst/:cid) e registra o `total` do run.
     * Depois reavalia a conclusão, pois as mensagens podem ter chegado (e terminado)
     * antes de esta resposta ser processada.
     */
    async requestBurst() {
      const { cid, token } = getCredentials();
      const resp = await platform.burst(cid, token);
      const run = store.setTotal(resp.run_id, resp.total, resp.started_at);
      logger.info('burst_started', { run_id: resp.run_id, total: resp.total });
      await maybeComplete(run); // caso tudo já tenha sido processado antes do total chegar
      return resp;
    },
    /** Resumo de um run (ou null se desconhecido); o mesmo conteúdo do GET /runs/:id. */
    getRun(runId) {
      const run = store.get(runId);
      return run ? store.summary(run) : null;
    },
  };
  return service;
}

/**
 * Estado em memória de cada run (lote). Um run é identificado pelo `run_id` e
 * contém um item por `seq` (0..total-1).
 *
 * Detalhe importante: `total` pode ser desconhecido no começo. A plataforma pode
 * enviar /process antes de a resposta do /burst chegar até nós, então o run é
 * criado "sob demanda" e o `total` é preenchido depois (veja `setTotal`).
 */
export class RunStore {
  /** run_id -> objeto do run. */
  #runs = new Map();

  /**
   * Devolve o run de `runId`, criando-o vazio se ainda não existir.
   * Estrutura do run:
   *  - total/startedAt: vindos do /burst (null até lá)
   *  - items:     seq -> { sku, status: pending|done|failed, price, stock, error }
   *  - skuCache:  sku -> Promise do /enrich (evita chamar duas vezes o mesmo SKU)
   *  - counters:  métricas (recebidas, duplicadas, processadas, falhas, retries, 429)
   *  - finalized: quantos itens já terminaram (done ou failed); usado para calcular `pending`
   *  - callback:  estado do envio do resultado (idle|sending|sent|failed) + relatório da plataforma
   */
  ensure(runId) {
    let run = this.#runs.get(runId);
    if (!run) {
      run = {
        id: runId,
        total: null,
        startedAt: null,
        createdAt: Date.now(),
        items: new Map(), // seq -> { sku, status: pending|done|failed, price, stock, error }
        skuCache: new Map(), // sku -> Promise<{price,stock}>
        counters: { received: 0, duplicates: 0, processed: 0, failed: 0, retries: 0, rateLimited: 0 },
        finalized: 0,
        callback: { state: 'idle', sentAt: null }, // idle|sending|sent|failed
      };
      this.#runs.set(runId, run);
    }
    return run;
  }

  /** Busca um run existente (undefined se não existir). Não cria nada. */
  get(runId) { return this.#runs.get(runId); }

  /**
   * Registra o total de itens esperado e o horário de início, informados pela
   * resposta do /burst. Cria o run se as mensagens de /process chegaram antes.
   */
  setTotal(runId, total, startedAt = null) {
    const run = this.ensure(runId);
    run.total = total;
    run.startedAt = startedAt;
    return run;
  }

  /**
   * Registra um item recebido em /process, com deduplicação por (run_id, seq).
   * A entrega é at-least-once, então o mesmo seq pode chegar mais de uma vez:
   * a repetição só incrementa o contador de duplicadas e NÃO é reprocessada.
   * @returns {boolean} true se o item é novo; false se for duplicata
   */
  addItem(runId, seq, sku) {
    const run = this.ensure(runId);
    if (run.items.has(seq)) { run.counters.duplicates++; return false; }
    run.items.set(seq, { sku, status: 'pending' });
    run.counters.received++;
    return true;
  }

  /**
   * Marca o item como processado com sucesso e guarda preço/estoque.
   * Só age se o item ainda estiver `pending`: estados finais nunca são sobrescritos,
   * o que torna a operação idempotente.
   */
  markDone(run, seq, { price, stock }) {
    const item = run.items.get(seq);
    if (!item || item.status !== 'pending') return;
    Object.assign(item, { status: 'done', price, stock });
    run.counters.processed++;
    run.finalized++;
  }

  /**
   * Marca o item como falha definitiva (ex.: 404, 401 ou retries esgotados).
   * Também só age sobre itens `pending`.
   */
  markFailed(run, seq, error) {
    const item = run.items.get(seq);
    if (!item || item.status !== 'pending') return;
    Object.assign(item, { status: 'failed', error });
    run.counters.failed++;
    run.finalized++;
  }

  /**
   * O run terminou? Só é verdade quando o total já é conhecido E todos os seqs
   * de 0 a total-1 chegaram e saíram de `pending` (done ou failed).
   * Verificar seq a seq (e não só contar) também detecta itens que nunca chegaram.
   */
  isComplete(run) {
    if (run.total === null) return false;
    for (let seq = 0; seq < run.total; seq++) {
      const it = run.items.get(seq);
      if (!it || it.status === 'pending') return false;
    }
    return true;
  }

  /**
   * Monta o array `result` do /callback: apenas itens com sucesso, em ordem crescente
   * de seq. Como é calculado do estado, é determinístico e pode ser reenviado quantas
   * vezes for preciso com o mesmo conteúdo.
   * @returns {{seq:number, sku:string, price:number, stock:number}[]}
   */
  buildResult(run) {
    const out = [];
    for (let seq = 0; seq < run.total; seq++) {
      const it = run.items.get(seq);
      if (it?.status === 'done') out.push({ seq, sku: it.sku, price: it.price, stock: it.stock });
    }
    return out;
  }

  /** Lista os itens que falharam definitivamente (seq, sku, motivo), ordenados por seq. Usada para log. */
  failures(run) {
    const out = [];
    for (const [seq, it] of run.items) if (it.status === 'failed') out.push({ seq, sku: it.sku, error: it.error });
    return out.sort((a, b) => a.seq - b.seq);
  }

  /**
   * Resumo serializável do run (é o corpo do GET /runs/:id): total, contadores,
   * quantos ainda estão pendentes, se está completo e o estado/relatório do callback.
   */
  summary(run) {
    return {
      run_id: run.id,
      total: run.total,
      started_at: run.startedAt,
      ...run.counters,
      pending: run.items.size - run.finalized,
      // Amostra dos primeiros SKUs (por seq): útil para testar o /enrich à mão com um SKU real.
      sample_skus: [...run.items.entries()].sort((a, b) => a[0] - b[0]).slice(0, 20).map(([, it]) => it.sku),
      complete: this.isComplete(run),
      callback: { ...run.callback },
    };
  }
}

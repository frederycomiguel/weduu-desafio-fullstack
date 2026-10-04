/**
 * Fila FIFO em memória com no máximo `concurrency` workers ativos.
 *
 * É o que desacopla o RECEBIMENTO do PROCESSAMENTO: o handler de /process só
 * faz `push()` (instantâneo) e responde o ACK; os workers consomem a fila em
 * segundo plano, no ritmo permitido pelo /enrich.
 */
export class WorkQueue {
  /** Jobs aguardando um worker livre. */
  #items = [];
  /** Quantidade de jobs sendo processados agora. */
  #active = 0;
  /** Depois de fechada, a fila ignora novos jobs e descarta os pendentes. */
  #closed = false;

  /**
   * @param {object}   opts
   * @param {number}   opts.concurrency máximo de jobs simultâneos
   * @param {Function} opts.handler     função assíncrona que processa um job
   * @param {Function} opts.onError     chamada com (erro, job) se o handler lançar; o erro não derruba a fila
   */
  constructor({ concurrency = 3, handler, onError = () => {} }) {
    this.concurrency = concurrency;
    this.handler = handler;
    this.onError = onError;
  }

  /** Quantos jobs estão esperando na fila (usado no /health). */
  get size() { return this.#items.length; }
  /** Quantos jobs estão em execução agora (usado no /health). */
  get active() { return this.#active; }

  /** Enfileira um job e tenta iniciar workers imediatamente. Não bloqueia. */
  push(job) {
    if (this.#closed) return;
    this.#items.push(job);
    this.#pump();
  }

  /** Encerra a fila: descarta o que estava pendente e impede novos jobs (usado no shutdown/testes). */
  close() { this.#closed = true; this.#items.length = 0; }

  /**
   * Motor da fila: enquanto houver vaga de worker e jobs pendentes, inicia jobs.
   * Quando um job termina (com sucesso ou erro), libera a vaga e chama `#pump()`
   * de novo para puxar o próximo. Um erro em um job nunca interrompe os demais.
   */
  #pump() {
    while (!this.#closed && this.#active < this.concurrency && this.#items.length) {
      const job = this.#items.shift();
      this.#active++;
      Promise.resolve()
        .then(() => this.handler(job))
        .catch((err) => this.onError(err, job))
        .finally(() => { this.#active--; this.#pump(); });
    }
  }
}

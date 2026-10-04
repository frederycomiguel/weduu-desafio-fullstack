/**
 * Espera `ms` milissegundos.
 * O timer usa `.unref()` para não segurar o processo vivo: se só restarem
 * sleeps pendentes (ex.: durante o encerramento), o Node pode finalizar normalmente.
 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());

/**
 * Calcula quanto esperar antes da próxima tentativa (backoff exponencial com "full jitter").
 *
 * - Exponencial: o teto cresce como baseMs * 2^attempt (200, 400, 800, ...), limitado por `capMs`.
 * - Full jitter: o valor final é sorteado entre 0 e esse teto. Assim, vários workers que
 *   falharam ao mesmo tempo não voltam todos no mesmo instante (evita "thundering herd").
 *
 * @param {number} attempt  número da tentativa que acabou de falhar (1, 2, 3...)
 * @param {number} baseMs   base do backoff em ms
 * @param {number} capMs    teto máximo da espera em ms (padrão 8 s)
 * @returns {number} espera em ms
 */
export function backoffDelay(attempt, baseMs, capMs = 8000) {
  return Math.random() * Math.min(capMs, baseMs * 2 ** attempt);
}

/**
 * Semáforo assíncrono: limita quantas operações rodam ao mesmo tempo.
 * É a peça que garante o limite de 3 requisições em voo do /enrich, para nunca
 * receber 429 por excesso de concorrência.
 */
export class Semaphore {
  /** Quantidade de vagas livres neste momento. */
  #free;
  /** Fila (FIFO) de quem está esperando vaga: cada item é o `resolve` de uma Promise pendente. */
  #waiters = [];

  /** @param {number} n número máximo de execuções simultâneas */
  constructor(n) { this.#free = n; }

  /**
   * Pede uma vaga. Se houver, consome e retorna na hora; senão, fica
   * aguardando na fila até alguém chamar `release()`.
   */
  async acquire() {
    if (this.#free > 0) { this.#free--; return; }
    await new Promise((r) => this.#waiters.push(r));
  }

  /**
   * Devolve uma vaga. Se há alguém esperando, a vaga é repassada diretamente
   * ao primeiro da fila (sem passar por `#free`, o que preserva a ordem justa);
   * caso contrário, a vaga volta ao contador.
   */
  release() {
    const next = this.#waiters.shift();
    if (next) next(); else this.#free++;
  }

  /**
   * Executa `fn` dentro do semáforo: adquire a vaga, roda, e SEMPRE libera
   * (mesmo se `fn` lançar erro), evitando vazamento de vagas.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async run(fn) {
    await this.acquire();
    try { return await fn(); } finally { this.release(); }
  }
}

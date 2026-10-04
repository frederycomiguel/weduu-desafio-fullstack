/**
 * Cria um logger estruturado: cada evento vira uma linha JSON com horário, nível,
 * mensagem e campos extras (fácil de filtrar com grep/jq e de ingerir em ferramentas de log).
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.silent] se true, não escreve nada (usado nos testes)
 * @param {object}  [opts.out]    destino com método write() (padrão: stdout)
 * @returns {{info: Function, warn: Function, error: Function}}
 */
export function createLogger({ silent = false, out = process.stdout } = {}) {
  /** Escreve uma linha JSON: { t, level, msg, ...fields }. */
  const log = (level, msg, fields) => {
    if (silent) return;
    out.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }) + '\n');
  };
  return {
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
  };
}

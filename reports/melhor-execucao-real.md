# Melhor execução — plataforma real (Weduu)

Run `mqt8ikjhm3cgk6aavc4oylms` em 2026-10-03T21:41:47.062Z, via ngrok (túnel do Brasil para us-central1). Resposta do /callback:

| Item | Resultado |
|---|---|
| Score | **100/100** |
| ACK (alvo 600 ms) | p50 242 ms, p95 414 ms, pior 487 ms, acima do alvo: 0 |
| Idempotência | duplicata seq 3, enrich 1/1 chamada, OK |
| Retry | 1 falhas 500 forçadas, 1 recuperadas |
| Concorrência | limite 3, 429 recebidos: 0 |
| Resultado | 20/20 corretos, 0 faltando, 0 divergentes |
| Duração | 1824 ms |

## Variação entre execuções (8 lotes reais)
Scores de 97 a 100. O ACK é dominado pela latência do túnel (p50 de 240 a 520 ms); o serviço em si responde em poucos ms (medido localmente). Quando o score fica em 99, uma mensagem passa de 600 ms, por oscilação do túnel e não por processamento.

JSON completo: `melhor-execucao-real.json`.

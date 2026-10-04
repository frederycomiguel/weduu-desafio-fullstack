# Decisões

## (a) Decisões arquiteturais

- **ACK desacoplado do processamento.** `/process` valida o payload, registra o item e responde `202` antes de qualquer I/O externo; o trabalho vai para a fila. O ACK não depende da latência do `/enrich` (400-800 ms), então o SLA de 600 ms se mantém mesmo sob rajada.
- **Fila em memória + semáforo global de 3.** Uma fila FIFO (`queue.js`) alimenta os workers; o `enrich-client` aplica um semáforo único para todos os runs, garantindo no máximo 3 requisições em voo contra a plataforma. O semáforo cobre só a requisição: esperas de backoff e `retry-after` ficam fora, para não ocupar vaga sem fazer trabalho.
- **Dedupe idempotente por `run_id:seq`.** A entrega é at-least-once e fora de ordem. O item é indexado por `seq` dentro do run; reentregas respondem `202` com `duplicate: true` e não reenfileiram. Estados finais (`done`/`failed`) não são sobrescritos.
- **Retry com backoff exponencial + jitter** para 5xx, timeouts e falhas de rede (padrão: 6 tentativas, base 200 ms, teto 8 s, jitter total). O jitter evita retentativas sincronizadas dos 3 workers.
- **429 não é falha.** Respeita o `retry-after`, espera fora do semáforo e não consome o orçamento de tentativas (só há uma trava de segurança de 60 esperas). Erros 401/404 são permanentes e não são retentados.
- **Cache por SKU dentro do run.** SKUs repetidos compartilham a mesma promessa de enrich, inclusive chamadas em voo. Falhas transitórias saem do cache para permitir nova tentativa.
- **Callback idempotente e reenviável.** O resultado é montado de forma determinística, ordenado por `seq`, a partir do estado do run, então pode ser reenviado sem efeito colateral. O envio automático acontece uma única vez (trava síncrona de estado `idle -> sending -> sent|failed`), com retry próprio. Itens que falharam definitivamente ficam registrados em log e fora do resultado.
- **`/process` pode chegar antes da resposta do `/burst`.** O `total` do run é desconhecido até o `/burst` responder. O run é criado sob demanda no primeiro `/process` e o `total` é preenchido depois; a completude só é avaliada quando `total` existe, e `requestBurst` reavalia caso tudo já tenha sido processado.
- **Zero dependências:** só `node:http`, `fetch` e `node:test`. Simples de rodar e auditar.

## (b) Trade-offs aceitos

- **Memória volátil vs durabilidade.** Fila e estado vivem em memória: se o processo cair, itens já aceitos (com ACK) e o progresso do run se perdem. Aceitável para 20 SKUs e para o teste; não para produção.
- **Processo único.** Sem escala horizontal; o semáforo de 3 em voo é local ao processo. Com mais instâncias o limite global seria violado.
- **ACK sem persistência.** Responder `202` antes de gravar em disco ou banco troca segurança por latência.
- **Falhas definitivas ficam fora do callback** (aparecem só em log e em `/runs/:id`), em vez de bloquear o run inteiro.
- **FIFO simples**, sem prioridade ou justiça entre runs simultâneos.
- **Credenciais em arquivo local** (`.credentials.json`, ignorado pelo git), carregadas só na inicialização.
- **Observabilidade mínima:** logs JSON e os endpoints `/health` e `/runs/:id`.
- **Estado de runs nunca é descartado** (sem TTL), adequado só a poucos runs.

## (c) Com 20.000 SKUs em vez de 20

**O gargalo é o `/enrich`, não o webhook.** Com 3 em voo e ~0,6 s por chamada: 20.000 x 0,6 s / 3 ≈ 4.000 s ≈ 66 min, sem contar 429 e 500 (~10% de retries levam a algo perto de 75 min). Nada do nosso lado reduz isso abaixo do limite da plataforma; o que se controla é não desperdiçar vagas e não perder trabalho nesse intervalo.

O que mudaria:

- **Fila durável** (Redis/BullMQ ou SQS) no lugar da fila em memória, com ack por job, visibility timeout e **DLQ** para itens que esgotam os retries.
- **Persistência de estado** do run (Redis/Postgres): itens, status, resultados parciais e estado do callback, para sobreviver a restart e permitir retomada. Contador por run em vez de varrer `0..total` a cada item.
- **ACK somente após persistência rápida**, gravando em lote (pipeline do Redis ou insert em batch) para manter o SLA de 600 ms sob rajada.
- **Backpressure e rate limiter distribuído** (semáforo/lease em Redis) que respeite o limite global de 3 em voo mesmo com várias instâncias; workers só puxam da fila quando há vaga.
- **Escala horizontal com sharding por `run_id`**, para manter dedupe, cache e consolidação sob um único dono. Mais workers não aumentam o throughput, pois o limite é da plataforma; escala-se o ingest (`/process`) e a resiliência.
- **Callback em lotes/paginado:** 20.000 itens em uma requisição é frágil. Cada página é idempotente por run e tem retry independente.
- **Cache de enrich compartilhado** (Redis, com TTL) entre runs e instâncias, e deduplicação de SKUs repetidos para reduzir chamadas, a única forma real de baixar o tempo total. Se a plataforma oferecer endpoint em lote, usá-lo.
- **Observabilidade:** métricas (fila, em voo, taxa de 429/500, latência p50/p95/p99 do ACK e do enrich, itens/min, idade do item mais antigo), tracing por `run_id`/`seq` e alertas de SLA e DLQ.
- **Desligamento gracioso**, reprocessamento de jobs em voo ao reiniciar e TTL para o estado de runs concluídos.

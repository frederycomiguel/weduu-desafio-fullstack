# Weduu Webhook Service

Serviço webhook (Node, sem dependências) que recebe SKUs da plataforma em `POST /process`, dá ACK imediato (SLA 600 ms), enriquece cada SKU via `GET /enrich/:sku` (máx. 3 em voo) de forma assíncrona e envia o resultado consolidado em `POST /callback`.

## Requisitos

- Node.js >= 24
- Nenhuma dependência para instalar (`npm install` não é necessário)
- Para rodar contra a plataforma real: [ngrok](https://ngrok.com/)

## Testes locais (com mock da plataforma)

```bash
npm test
```

Sobe um mock da plataforma (register, burst, enrich com 429/500/latência, callback) e valida ACK, dedupe, limite de 3 em voo e o callback final.

Para rodar só o mock (porta 5000):

```bash
npm run mock
```

Demonstração local ponta a ponta com um comando (sobe o mock e o serviço, registra, pede um lote e imprime o relatório; aceita `TOTAL`, `DUP_RATE` e `ERROR_RATE`):

```bash
npm run demo
```

Relatórios:
- [`reports/melhor-execucao-real.md`](reports/melhor-execucao-real.md): melhor execução contra a plataforma real (100/100). Em 8 lotes reais o score ficou entre 97 e 100; o ACK varia com a latência do túnel ngrok, não com o processamento.
- [`reports/melhor-execucao.md`](reports/melhor-execucao.md): execução contra o mock local (gerado por `test/report.js`).

## Rodar contra a plataforma real (passo manual)

Estes passos dependem de conta ngrok e da plataforma; execute-os você mesmo.

```bash
# terminal 1: serviço
npm start

# terminal 2: túnel público
ngrok http 4000

# terminal 3: registrar usando a URL pública do ngrok (a plataforma chama /check)
WEBHOOK_URL=https://<id>.ngrok-free.app npm run register
```

O registro grava `.credentials.json`. Reinicie o serviço (`npm start`) para ele carregar as credenciais e então dispare o lote:

```bash
npm run burst
```

Acompanhe em `GET http://localhost:4000/runs/<run_id>` e `GET /health`.

Variáveis opcionais: `PORT` (4000), `PLATFORM_URL`, `WEBHOOK_URL`, `WEBHOOK_NAME`, `ENRICH_CONCURRENCY` (3), `ENRICH_MAX_RETRIES` (6), `CALLBACK_MAX_RETRIES` (5), `BACKOFF_BASE_MS` (200), `CREDENTIALS_FILE`.

## Estrutura

```
src/
  index.js            entrada (carrega credenciais, sobe o servidor)
  app.js              rotas HTTP (/check, /process, /burst, /health, /runs/:id) e orquestração
  queue.js            fila FIFO em memória com N workers
  run-store.js        estado por run: itens, dedupe, cache por SKU, contadores
  enrich-client.js    /enrich com semáforo global, retry/backoff e tratamento de 429
  platform-client.js  register, burst e callback (com retry)
  config.js, util.js, logger.js
scripts/              register.js, burst.js
test/                 e2e.test.js, helpers, report.js, mock-platform/
reports/              melhor-execucao-real.md (plataforma real) e melhor-execucao.md (mock), + .json
docs/DECISOES.md      decisões, trade-offs e escala para 20.000 SKUs
```

## Documentação

- [docs/DECISOES.md](docs/DECISOES.md): decisões arquiteturais, trade-offs e o que mudaria com 20.000 SKUs
- [reports/](reports/): relatórios das execuções (real e mock)

# Weduu Webhook Service

Serviço webhook em Node.js, sem dependências externas. Recebe SKUs da plataforma em `POST /process`, responde o ACK de imediato (SLA de 600 ms), consulta `GET /enrich/:sku` de forma assíncrona (no máximo 3 em voo) e envia o resultado consolidado em `POST /callback`.

Decisões de arquitetura, trade-offs e o cenário de 20.000 SKUs: [docs/DECISOES.md](docs/DECISOES.md).

## Como executar

Requisitos: Node.js >= 24. Não há `npm install`. O ngrok só é necessário para rodar contra a plataforma real.

```bash
npm test            # 21 testes, com uma plataforma simulada (~95 s)
npm run demo        # fluxo completo local: registra, pede um lote e imprime o relatório
npm run demo:real   # fluxo completo contra a plataforma Weduu (abre o ngrok sozinho)
```

O `demo` aceita `TOTAL`, `DUP_RATE` e `ERROR_RATE` para variar o cenário. O `demo:real` exige o ngrok instalado e autenticado, e a porta 4000 livre.

## Relatório da melhor execução

[reports/melhor-execucao-real.md](reports/melhor-execucao-real.md): execução na plataforma real, **100/100**, com os 20 itens corretos e ACK mediano de 382 ms. Em vários lotes reais o score ficou entre 97 e 100: o ACK medido inclui o túnel ngrok, e a variação vem da rede, não do processamento. O relatório contra o mock local está em [reports/melhor-execucao.md](reports/melhor-execucao.md).

## Execução manual contra a plataforma real

```bash
npm start                                              # terminal 1: serviço (porta 4000)
ngrok http 4000                                        # terminal 2: túnel público
WEBHOOK_URL=https://<id>.ngrok-free.app npm run register   # terminal 3: registra (a plataforma chama /check)
```

O registro grava `.credentials.json`. Reinicie o `npm start` para carregá-lo e dispare o lote com `npm run burst`. Acompanhe em `GET http://localhost:4000/runs/<run_id>`.

Variáveis opcionais: `PORT` (4000), `PLATFORM_URL`, `WEBHOOK_URL`, `WEBHOOK_NAME`, `ENRICH_CONCURRENCY` (3), `ENRICH_MAX_RETRIES` (6), `CALLBACK_MAX_RETRIES` (5), `BACKOFF_BASE_MS` (200), `CREDENTIALS_FILE`.

## Testar as rotas à mão (opcional)

- **Swagger UI:** com `npm start` rodando, abra http://localhost:4000/docs. Com o ngrok aberto, o fluxo real roda só por lá: `POST /register` (URL do ngrok), `POST /burst` e `GET /runs/{id}` (o relatório fica em `callback.report`).
- **Postman:** importe [docs/postman-collection.json](docs/postman-collection.json). A pasta "A. Fluxo automático" (com `npm start` e `ngrok http 4000` abertos) pega a URL do ngrok, registra, pede o lote, descobre um SKU real e testa `/enrich` e `/callback`. A pasta "B" testa as rotas do serviço (ACK, duplicata e validação). As rotas da plataforma só aparecem no Postman, porque o navegador bloqueia chamadas a elas (CORS).

## Estrutura

```
src/
  index.js            entrada (carrega credenciais, sobe o servidor)
  app.js              rotas HTTP e orquestração
  openapi.json        especificação servida em /openapi.json (Swagger UI)
  queue.js            fila FIFO em memória com N workers
  run-store.js        estado por run: itens, dedupe, cache por SKU, contadores
  enrich-client.js    /enrich com semáforo global, retry/backoff e tratamento de 429
  platform-client.js  register, burst e callback (com retry)
  config.js, util.js, logger.js
scripts/              register.js, burst.js, demo.js
test/                 e2e, unitários, mock da plataforma, report.js
reports/              relatórios das execuções (real e mock)
docs/                 DECISOES.md e coleção do Postman
```

# Receipt WhatsApp Bot

Pipeline incremental em Node.js para leitura de canhotos com arquitetura preparada para:

- aceitar imagens vindas de WhatsApp, app mobile, painel web, API e upload manual
- suportar multiplas empresas sem hardcode no core
- processar canhotos de forma assincrona via storage + fila + worker
- usar `Opção A` como motor principal de OCR e `Opção B` como resgate
- manter o pipeline legado convivendo durante a migracao

## Etapas implementadas

O projeto agora cobre duas camadas em paralelo:

1. Pipeline legado
   - preprocessamento, OCR local com Tesseract, heuristicas de template e classificacao atual
2. Pipeline novo
   - endpoint central de ingestao
   - perfis de `sourceProfile`, `companyProfile` e `documentProfile`
   - interfaces de storage, fila e state repository
   - drivers locais e cloud-ready
   - worker assincrono
   - orquestrador de providers com `Opção A -> fallback B -> legado`

## Arquitetura nova

Fluxo principal:

1. `POST /v1/receipts/ingest` recebe o canhoto em payload canonico
2. o sistema identifica `companyId`, `source` e `documentType`
3. a imagem vai para o `AssetStorage` ativo
4. um job e criado no `JobQueue` ativo
5. o worker consome o job
6. o worker executa `Opção A` primeiro
7. se faltar campo ou a confianca vier baixa, executa `Opção B`
8. se ainda assim nao fechar, pode cair no provider legado durante a migracao
9. o `ProcessingStateRepository` consolida status, tentativas e resultado final
10. o resultado final separa parsing, validacao, decisao e resposta operacional

Payload canonico interno:

```json
{
  "companyId": "mar-e-rio",
  "source": "whatsapp",
  "documentType": "delivery_receipt",
  "imageUrl": "https://...",
  "metadata": {
    "groupId": "...",
    "messageId": "...",
    "sender": "..."
  }
}
```

## Estrutura

```text
apps/receipt-whatsapp-bot/
  public/
    index.html
  src/
    config/
      env.js
      profiles/
        companies/
        documents/
        sources/
    services/
      api.service.js
      extraction/
        providers/
      infrastructure/
      ingestion/
      imagePreprocess.service.js
      maintenance/
      nfExtractor.service.js
      ocr.service.js
      processing/
      queue/
      receiptAnalysis.service.js
      receiptClassifier.service.js
      receiptDetector.service.js
      state/
      worker/
      whatsapp.service.js
    http/
      routes/
    tests/
      localImageRunner.js
      runUnitTests.js
      unit/
    utils/
      file.js
      logger.js
      matching.js
      regex.js
      textNormalization.js
    index.js
    maintenance.js
    worker.js
    server.js
  test-images/
  outputs/
  package.json
  README.md
  .env.example
```

## Dependencias escolhidas

- `dotenv`: configuracao simples por ambiente.
- `express`: API central de ingestao, debug e laboratorio visual local.
- `jimp`: preprocessamento de imagem em JavaScript puro, sem exigir binarios nativos.
- `multer`: upload em disco para ingestao e laboratorio local, evitando concentrar imagem em RAM.
- `sharp`: geracao rapida das versoes visuais de preprocessamento para comparacao lado a lado.
- `exif-parser`: leitura leve de EXIF para tentar corrigir orientacao.
- `tesseract.js`: OCR em Node.js, usado como motor base da leitura estruturada por orientacao, OCR global de apoio e OCR por regioes.
- `bullmq` + `ioredis`: fila profissional com Redis, retries, backoff, eventos e suporte a multiplos workers.
- `@aws-sdk/client-s3`: storage externo para objetos, preparado para buckets S3-compatibles.

Observacao:

- O projeto usa `langPath` apontando para a raiz do app, entao `eng.traineddata` e `por.traineddata` podem ser reaproveitados localmente.
- O OCR principal continua usando o pipeline atual em `Jimp`; `sharp` entrou para o laboratorio visual de preprocessamento.
- A arquitetura nova ja deixa o OCR desacoplado em providers, permitindo trocar o motor sem reescrever a regra de negocio.
- Fila, storage e persistencia de estado agora tambem estao desacoplados por driver, com alternancia por env.

## Infraestrutura atual

Interfaces ativas:

- `JobQueue`
- `AssetStorage`
- `ProcessingStateRepository`

Drivers disponiveis:

- fila: `file` ou `bullmq`
- storage: `local` ou `s3`
- estado: `file` ou `redis`

Modo de transicao recomendado:

- `RECEIPT_JOB_QUEUE_DRIVER=file`
- `RECEIPT_ASSET_STORAGE_DRIVER=local`
- `RECEIPT_PROCESSING_STATE_REPOSITORY_DRIVER=file`

Modo cloud-ready:

- `RECEIPT_JOB_QUEUE_DRIVER=bullmq`
- `RECEIPT_ASSET_STORAGE_DRIVER=s3`
- `RECEIPT_PROCESSING_STATE_REPOSITORY_DRIVER=redis`

Mesmo trocando esses drivers, o orchestrator de extracao, o decision service e o worker pattern permanecem os mesmos.

## Regras de negocio cobertas

Campos obrigatorios buscados na imagem:

- `DATA DE RECEBIMENTO`
- `RECEBEMOS DE MAR E RIO`
- `NF-e`

Extracao da NF:

- prioriza regioes provaveis da caixa da `NF-e`
- usa OCR global apenas como apoio contextual
- avalia candidatos numericos com contexto de `NF-e`, `Nota Fiscal`, `N°` e posicao na imagem
- nao escolhe a NF pelo maior numero encontrado

Classificacao final:

- `valid`: os 3 campos estruturais foram detectados, ou o fallback foi satisfeito (`DATA DE RECEBIMENTO` + `NF-e` + NF forte)
- `review`: ha estrutura parcial ou NF ambigua, mas sem confianca para aprovar
- `invalid`: a imagem nao tem estrutura suficiente de canhoto ou NF plausivel

Fallback por NF no banco:

- se `RECEBEMOS DE MAR E RIO` estiver coberto, o bot pode aprovar mesmo assim quando `DATA DE RECEBIMENTO`, `NF-e`, geometria e NF extraida estiverem fortes
- nesse caso, a NF lida e consultada na base da MAR E RIO
- se a NF existir no banco, o bot considera a origem do canhoto confirmada

Diagnostico de falha:

- o resultado final agora informa explicitamente em qual etapa falhou
- os checkpoints avaliados sao `Geometria do canhoto`, `Assinatura`, `DATA DE RECEBIMENTO`, `RECEBEMOS DE MAR E RIO`, `Bloco NF-e`, `Numero da NF` e `Conferencia da NF no banco`

Comportamento futuro no WhatsApp:

- responder no grupo apenas quando a leitura falhar ou a imagem precisar ser refeita
- se a NF for extraida corretamente, nao responder no grupo

## Como rodar localmente

### 1. Instalar dependencias

```bash
npm install
```

Requisito:

- Node.js 18 ou superior
- Se voce usa `nvm`, rode `nvm use 18` antes de executar os scripts do projeto

### 2. Configurar ambiente

```bash
cp .env.example .env
```

Variaveis principais:

- `TEST_IMAGES_DIR`: pasta com imagens para testes locais
- `OUTPUTS_DIR`: pasta de saida
- `RECEIPT_API_PORT`: porta da API central
- `RECEIPT_JOB_QUEUE_DRIVER`: `file` ou `bullmq`
- `RECEIPT_ASSET_STORAGE_DRIVER`: `local` ou `s3`
- `RECEIPT_PROCESSING_STATE_REPOSITORY_DRIVER`: `file` ou `redis`
- `RECEIPT_STORAGE_DIR`: raiz do storage local quando o driver e `local`
- `RECEIPT_QUEUE_DIR`: raiz da fila local quando o driver e `file`
- `RECEIPT_STATE_DIR`: raiz do state repository local quando o driver e `file`
- `RECEIPT_REDIS_URL`: conexao do Redis para BullMQ/state repository Redis
- `RECEIPT_QUEUE_NAME`: nome logico da fila
- `RECEIPT_QUEUE_MAX_ATTEMPTS`: tentativas maximas por job
- `RECEIPT_QUEUE_BACKOFF_MS`: backoff base para retries
- `RECEIPT_QUEUE_CONCURRENCY`: concorrencia do worker BullMQ
- `RECEIPT_S3_BUCKET`: bucket do storage externo
- `RECEIPT_S3_REGION`: regiao do bucket
- `RECEIPT_S3_ENDPOINT`: endpoint S3-compatible opcional
- `RECEIPT_S3_FORCE_PATH_STYLE`: compatibilidade com MinIO/R2/LocalStack
- `RECEIPT_S3_PUBLIC_BASE_URL`: URL publica base opcional
- `RECEIPT_MAINTENANCE_INTERVAL_MS`: janela da rotina de limpeza automatica
- `RECEIPT_COMPANY_INGEST_TOKENS`: mapa JSON de tokens por empresa
- `RECEIPT_DEFAULT_COMPANY_ID`: empresa padrao do endpoint central
- `RECEIPT_DEFAULT_SOURCE_ID`: origem padrao do endpoint central
- `RECEIPT_DEFAULT_DOCUMENT_TYPE`: documento padrao do endpoint central
- `RECEIPT_PROVIDER_GOOGLE_VISION_*`: configuracao do provider principal da `Opção A`
- `RECEIPT_PROVIDER_OPENAI_*`: configuracao do fallback `Opção B`
- `OCR_PROBE_LANG`: idioma leve para triagem inicial
- `OCR_PROBE_VARIANT_LIMIT`: quantas variantes entram na triagem inicial
- `OCR_FULL_LANG`: idioma do OCR completo
- `OCR_REGION_LANG`: idioma do OCR por regiao
- `OCR_LANG_PATH`: onde buscar os `.traineddata`
- `OCR_REGION_MIN_EDGE`: menor lado alvo para ampliar recortes pequenos da caixa da NF antes do OCR
- `OCR_NF_EXPECTED_LENGTHS`: tamanhos aceitos para a NF. No fluxo atual da MAR E RIO, use `7`
- `OCR_SUPPRESS_CONSOLE_NOISE`: remove o ruido verboso do Tesseract no terminal
- `RECEIPT_PROFILE_ID`: perfil ativo do canhoto. O projeto sai com `mar_e_rio`, mas a arquitetura agora permite adicionar outros perfis por empresa
- `RECEIPT_INVOICE_LOOKUP_MODE`: `auto`, `backend_db`, `mock` ou `disabled`
- `RECEIPT_INVOICE_LOOKUP_COMPANY_CODE`: empresa consultada no banco, por padrao `mar_e_rio`
- `RECEIPT_LOCAL_FAST_MODE`: ativa o fluxo rapido no `test:local`
- `RECEIPT_LOCAL_REPORT_ONLY`: imprime apenas o relatorio final no lote local
- `RECEIPT_LOCAL_MAX_IMAGES`: limita quantas imagens do lote serao processadas

Padrao atual:

- `por` para triagem, OCR completo e OCR regional, reaproveitando o mesmo worker e reduzindo custo de inicializacao.
- `OCR_PROBE_VARIANT_LIMIT=5` para manter a triagem mais curta sem perder as variantes mais valiosas.
- Se quiser priorizar outro comportamento, altere para `eng` ou `por+eng` no `.env`.
- `OCR_FULL_MAX_EDGE` e `OCR_REGION_MAX_EDGE` ja saem reduzidos por padrao para manter o lote local responsivo.
- `OCR_REGION_MIN_EDGE` amplia recortes pequenos da area da NF para melhorar a leitura em fotos comprimidas.
- `RECEIPT_LOCAL_FAST_MODE=true` deixa o `test:local` em modo rapido por padrao, reduzindo rotacoes, OCR de apoio e confirmacoes extras.
- Para cloud, use Redis gerido + bucket S3-compatível e deixe o filesystem apenas para `tmp`.

### 3. Adicionar imagens de teste

Coloque imagens reais em [test-images](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/test-images).

Exemplos:

- `test-images/fotoBoa.jpeg`
- `test-images/fotoRuim.jpeg`

### 4. Rodar testes unitarios

```bash
npm test
```

### 5. Rodar processamento local em lote

```bash
npm run test:local
```

### 6. Rodar interface visual local de debug

```bash
npm run debug:ui
```

A interface sobe por padrao em:

- `http://localhost:3388/debug-ui`

Ela permite:

- selecionar imagens ja existentes em `test-images/`
- enviar upload manual de um novo canhoto
- acompanhar o progresso por etapa
- visualizar imagens intermediarias, regioes destacadas e resultado final

### 7. Rodar laboratorio visual de preprocessamento

```bash
npm run dev
```

O laboratorio sobe por padrao em:

- `http://localhost:3000`

Ele permite:

- enviar uma imagem manualmente via upload
- visualizar lado a lado a imagem original redimensionada
- comparar as versoes em escala de cinza, contraste normalizado e binarizacao com nitidez
- validar rapidamente se o preprocessamento esta ajudando ou piorando a legibilidade antes do OCR completo

### 8. Rodar a API central de ingestao

```bash
npm run api
```

API padrao:

- `http://localhost:3390/health`
- `POST /v1/receipts/ingest`
- `POST /v1/sources/whatsapp/receipts`
- `GET /v1/receipts/jobs/:jobId`

### 9. Rodar o worker

```bash
npm run worker
```

Para consumir um unico job e sair:

```bash
npm run worker:once
```

### 10. Rodar manutencao manual

```bash
npm run maintenance:once
```

Essa rotina executa:

- limpeza de jobs finalizados no driver local
- limpeza de registros antigos no state repository
- limpeza de assets locais expirados
- limpeza de arquivos temporarios antigos

## Perfis configuraveis

O core novo separa:

- `sourceProfile`: origem da imagem
- `companyProfile`: empresa e politica operacional
- `documentProfile`: regras do documento

Hoje ja existem perfis base para:

- `whatsapp`
- `api`
- `manual_upload`
- `web_panel`
- `mobile_app`
- empresa `mar-e-rio`
- documento `delivery_receipt`

Para adicionar uma nova empresa:

1. crie um arquivo em `src/config/profiles/companies/`
2. habilite as origens aceitas
3. configure o binding do documento
4. sobrescreva aliases, thresholds e politicas operacionais quando necessario

Para adicionar uma nova origem:

1. crie um arquivo em `src/config/profiles/sources/`
2. defina os metadados esperados
3. conecte a origem a um adapter fino que converta para o payload canonico
4. encaminhe tudo para `POST /v1/receipts/ingest`

## Providers de extracao

Ordem atual de execucao por padrao:

1. `google_vision_document_text`
2. `openai_receipt_rescue`
3. `legacy_receipt_analysis`

Papel de cada um:

- `Opção A`: OCR principal com resposta estruturada e regioes
- `Opção B`: resgate multimodal quando o principal falhar ou vier fraco
- `Legado`: convivencia temporaria para migracao segura

## Fila e estado

Com `BullMQ + Redis`:

- o producer adiciona jobs com `attempts`, `backoff` e politica de remocao
- o worker consome sem polling manual
- o estado funcional do processamento continua indo para o `ProcessingStateRepository`
- o endpoint `GET /v1/receipts/jobs/:jobId` consulta esse repositório e, quando possivel, agrega metadado da fila

Com o driver `file`:

- a semantica antiga continua disponivel
- agora existe retry com backoff simples
- o filesystem deixa de ser a fonte unica de verdade, porque o estado do job tambem e persistido separadamente

## Storage de assets

Com `local`:

- a imagem fica em disco apenas como implementacao transitória
- o worker processa o proprio arquivo local

Com `s3`:

- a imagem original sai do disco local logo na ingestao
- o worker baixa temporariamente o objeto para processamento
- a nomenclatura segue `companyId/documentType/ano/mes/dia/...`
- a geracao de URL fica encapsulada no `AssetStorage`

## O que o runner local faz

Para cada imagem em `test-images/`, o runner:

1. gera variantes preprocessadas em `outputs/processed/<imagem>/variants/`
2. detecta a melhor orientacao com OCR estrutural
3. roda OCR regional nas partes mais relevantes do canhoto
4. detecta os campos obrigatorios com matching tolerante e peso por regiao
5. extrai a NF com heuristicas contextuais e posicionais
6. consulta a NF no banco quando a leitura conseguiu consolidar um numero
7. classifica a imagem como `valid`, `review` ou `invalid`
8. gera um JSON detalhado por imagem em `outputs/results/`
9. gera um resumo consolidado em `outputs/reports/local-run-summary.json`

No `test:local`, o comportamento padrao agora e:

- console silencioso, sem o ruido interno do Tesseract
- relatorio final enxuto
- primeira passada em `local_fast`, com `batch_fallback` automatico quando a NF nao fecha, nao existe no banco ou fica ambigua
- em caso de sucesso, mostra apenas `NF lida + tempo`
- em caso de falha ou `review`, mostra `em qual parte falhou + tempo`
- quando o nome do arquivo esta no formato `1234567.jpeg`, o runner compara a NF lida com esse valor e destaca leitura incorreta no relatorio final

Exemplo de saida do `npm run test:local`:

```text
Relatorio final dos canhotos
Total processado: 3
Validas: 2 | Revisao: 1 | Invalidas: 0
NFs lidas com sucesso: 2
NFs corretas pelo nome do arquivo: 2/3
Tempo medio por imagem: 8.4s

NFs lidas com sucesso
- foto-1.jpeg: NF 1710496 | tempo 6.8s
- foto-2.jpeg: NF 1710531 | tempo 7.1s | origem confirmada no banco

NFs lidas incorretamente
- 1710487.jpeg: NF lida 1710457 | esperado 1710487 | classificacao review | tempo 12.0s

Falhas sem NF
- foto-3.jpeg: review | falhou em: DATA DE RECEBIMENTO, Bloco NF-e | NF nao detectada | tempo 11.3s
```

## Desempenho

- o `test:local` agora roda em modo rapido por padrao
- o modo rapido reduz o numero de rotacoes, corta OCR global desnecessario, simplifica confirmacoes da NF e imprime apenas o relatorio final
- quando a passada rapida fica ambigua, o runner sobe automaticamente para `batch_fallback` so naquela imagem
- o Tesseract continua sendo o maior custo da pipeline; por isso o caminho local foi otimizado para diagnostico rapido, nao para debug visual detalhado
- cada resultado continua salvando `timings`, entao voce consegue medir `preprocess`, `orientation`, `nfExtraction` e `totalMs`
- quando precisar de mais profundidade visual, use `npm run debug:ui`

## Interface visual de debug

Cada sessao salva artefatos em `outputs/debug-sessions/<sessionId>/`, incluindo:

- copia da imagem de entrada
- variantes preprocessadas e artefatos de debug
- `analysis.json` com o resultado bruto do pipeline
- `session.json` com o payload consolidado da interface

Na tela voce consegue inspecionar:

- imagem original
- imagem rotacionada
- escala de cinza
- contraste ajustado
- binarizacao
- recortes focados no documento
- regioes principais analisadas, incluindo cabecalho e caixa da NF-e
- texto bruto e texto normalizado do melhor OCR
- status dos campos obrigatorios
- diagnostico por checkpoint de falha
- NF extraida, confianca e classificacao final

## Laboratorio visual de preprocessamento

O endpoint local `POST /api/process` recebe um arquivo no campo `receipt` e devolve 4 buffers em base64:

- `original`
- `grayscale`
- `contrast`
- `binary`

Essa rota usa `processImageForOcr` em [imagePreprocess.service.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/services/imagePreprocess.service.js), que:

1. corrige rotacao via EXIF
2. redimensiona a imagem para largura alvo de `1800px`
3. gera a versao em escala de cinza
4. gera a versao com contraste normalizado
5. gera a versao binaria com `threshold(128)` e `sharpen()`

O objetivo dessa tela nao e classificar o canhoto, e sim dar comparacao visual rapida do preprocessamento antes de entrar no OCR principal.

## Exemplo de saida por imagem

```json
{
  "fileName": "fotoBoa.jpeg",
  "status": "stage_10_completed",
  "classification": {
    "classification": "valid",
    "shouldReplyToWhatsapp": false
  },
  "requiredFields": {
    "dataRecebimento": { "found": true, "confidence": 0.84 },
    "issuerHeader": { "found": true, "confidence": 0.79 },
    "nfe": { "found": true, "confidence": 0.98 }
  },
  "nfExtraction": {
    "nf": "16171762",
    "confidence": 0.91,
    "method": "nf_context_number",
    "context": {
      "foundNfe": true,
      "foundNumeroMarker": true
    }
  },
  "invoiceLookup": {
    "found": true,
    "mode": "backend_db"
  },
  "diagnostics": {
    "approvalBasis": "nf_confirmada_no_banco",
    "summary": {
      "failedLabels": [],
      "invoiceConfirmedInDb": true
    }
  }
}
```

## Exemplo do resumo consolidado

```json
{
  "totalImages": 2,
  "validCount": 1,
  "reviewCount": 1,
  "invalidCount": 0,
  "items": [
    {
      "fileName": "fotoBoa.jpeg",
      "classification": "valid",
      "nf": "16171762",
      "invoiceConfirmedInDb": true,
      "approvalBasis": "nf_confirmada_no_banco"
    },
    {
      "fileName": "fotoRuim.jpeg",
      "classification": "review",
      "nf": null,
      "failedCheckpoints": [
        "DATA DE RECEBIMENTO",
        "Bloco NF-e"
      ]
    }
  ]
}
```

## Testes automatizados incluidos

Os testes unitarios cobrem:

- normalizacao de texto
- deteccao dos campos obrigatorios
- extracao da NF
- classificacao final da imagem
- validacao por NF existente no banco
- deteccao de assinatura na area central
- resolucao de perfis do pipeline novo
- parsing canonicamente desacoplado do provider
- fila local baseada em arquivos
- repositório de estado do processamento
- storage local desacoplado por driver

Arquivos:

- [textNormalization.test.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/tests/unit/textNormalization.test.js)
- [receiptDetector.test.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/tests/unit/receiptDetector.test.js)
- [nfExtractor.test.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/tests/unit/nfExtractor.test.js)
- [receiptClassifier.test.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/tests/unit/receiptClassifier.test.js)
- [profileResolver.test.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/tests/unit/profileResolver.test.js)
- [fileJobQueue.test.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/tests/unit/fileJobQueue.test.js)
- [documentFieldParser.test.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/tests/unit/documentFieldParser.test.js)
- [processingStateRepository.test.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/tests/unit/processingStateRepository.test.js)
- [receiptAssetStorage.test.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/tests/unit/receiptAssetStorage.test.js)

## Integracao com WhatsApp

O servico [whatsapp.service.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/services/whatsapp.service.js) ja deixa preparado:

- ponto de entrada para mensagem com imagem
- funcao para baixar midia via injecao de dependencias
- regra de resposta apenas quando a imagem nao puder ser confiavelmente analisada
- modo assincrono opcional via `RECEIPT_ASYNC_WHATSAPP_MODE=true`, que apenas enfileira a imagem no pipeline central

Ainda nao existe integracao real com WhatsApp Web nesta etapa.

## Integracao com API

O servico [api.service.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/services/api.service.js) ja expone:

- `findInvoiceByNumber`
- `updateInvoiceReceiptStatus`
- `createReceiptAlert`
- `syncAnalysisResult`

Hoje o servico suporta:

- `mock`, para desenvolvimento local puro
- `backend_db`, consultando diretamente a base do backend
- `auto`, tentando `backend_db` primeiro e caindo para `mock` se necessario

## Migracao segura do legado

O projeto nao trocou tudo de uma vez. A estrategia atual e:

1. manter o pipeline legado intacto
2. isolar o legado como `legacy_receipt_analysis`
3. colocar o pipeline novo na frente com providers configuraveis
4. isolar tambem fila, storage e estado atras de interfaces
5. permitir drivers locais e cloud por configuracao
6. permitir fallback para o legado por empresa e documento
7. migrar empresa por empresa sem quebrar o que ja funciona

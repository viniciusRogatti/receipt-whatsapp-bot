# Receipt WhatsApp Bot

Bot incremental em Node.js para leitura de canhotos enviados no WhatsApp, com foco em:

- validar se a imagem traz os campos minimos do canhoto
- extrair automaticamente o numero da NF-e
- classificar a imagem como `valid`, `review` ou `invalid`
- deixar pronta a integracao com WhatsApp e com a base da MAR E RIO

## Etapas implementadas

O projeto agora cobre as etapas 1 a 10 pedidas:

1. base do projeto, scripts, `.env`, logs e runner local
2. preprocessamento robusto e geracao de variantes
3. OCR completo da imagem inteira, comparando variantes
4. deteccao flexivel dos campos obrigatorios
5. extracao da NF por heuristicas e OCR por regiao
6. classificacao final da imagem
7. lote local com relatorio consolidado
8. camada pronta para entrada de mensagens do WhatsApp
9. camada pronta para integracao futura com a API
10. testes unitarios basicos e organizacao do codigo

## Estrutura

```text
apps/receipt-whatsapp-bot/
  src/
    config/
      env.js
    services/
      api.service.js
      imagePreprocess.service.js
      nfExtractor.service.js
      ocr.service.js
      receiptAnalysis.service.js
      receiptClassifier.service.js
      receiptDetector.service.js
      whatsapp.service.js
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
  test-images/
  outputs/
  package.json
  README.md
  .env.example
```

## Dependencias escolhidas

- `dotenv`: configuracao simples por ambiente.
- `jimp`: preprocessamento de imagem em JavaScript puro, sem exigir binarios nativos.
- `exif-parser`: leitura leve de EXIF para tentar corrigir orientacao.
- `tesseract.js`: OCR em Node.js, usado como motor base da leitura estruturada por orientacao, OCR global de apoio e OCR por regioes.

Observacao:

- O projeto usa `langPath` apontando para a raiz do app, entao `eng.traineddata` e `por.traineddata` podem ser reaproveitados localmente.
- Para uma fase futura de producao, ainda faz sentido avaliar `sharp` para preprocessamento de maior desempenho.

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
- `OCR_PROBE_LANG`: idioma leve para triagem inicial
- `OCR_PROBE_VARIANT_LIMIT`: quantas variantes entram na triagem inicial
- `OCR_FULL_LANG`: idioma do OCR completo
- `OCR_REGION_LANG`: idioma do OCR por regiao
- `OCR_LANG_PATH`: onde buscar os `.traineddata`
- `OCR_REGION_MIN_EDGE`: menor lado alvo para ampliar recortes pequenos da caixa da NF antes do OCR
- `OCR_NF_EXPECTED_LENGTHS`: tamanhos aceitos para a NF, por exemplo `7` ou `7,8`
- `OCR_SUPPRESS_CONSOLE_NOISE`: remove o ruido verboso do Tesseract no terminal
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
- em caso de sucesso, mostra apenas `NF lida + tempo`
- em caso de falha ou `review`, mostra `em qual parte falhou + tempo`

Exemplo de saida do `npm run test:local`:

```text
Relatorio final dos canhotos
Total processado: 3
Validas: 2 | Revisao: 1 | Invalidas: 0
NFs lidas com sucesso: 2
Tempo medio por imagem: 8.4s

NFs lidas com sucesso
- foto-1.jpeg: NF 1710496 | tempo 6.8s
- foto-2.jpeg: NF 1710531 | tempo 7.1s | origem confirmada no banco

Falhas ou revisao
- foto-3.jpeg: review | falhou em: DATA DE RECEBIMENTO, Bloco NF-e | NF nao detectada | tempo 11.3s
```

## Desempenho

- o `test:local` agora roda em modo rapido por padrao
- o modo rapido reduz o numero de rotacoes, corta OCR global desnecessario, simplifica confirmacoes da NF e imprime apenas o relatorio final
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
    "recebemosDeMarERio": { "found": true, "confidence": 0.79 },
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

Arquivos:

- [textNormalization.test.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/tests/unit/textNormalization.test.js)
- [receiptDetector.test.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/tests/unit/receiptDetector.test.js)
- [nfExtractor.test.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/tests/unit/nfExtractor.test.js)
- [receiptClassifier.test.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/tests/unit/receiptClassifier.test.js)

## Integracao futura com WhatsApp

O servico [whatsapp.service.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/services/whatsapp.service.js) ja deixa preparado:

- ponto de entrada para mensagem com imagem
- funcao para baixar midia via injecao de dependencias
- regra de resposta apenas quando a imagem nao puder ser confiavelmente analisada

Ainda nao existe integracao real com WhatsApp Web nesta etapa.

## Integracao futura com API

O servico [api.service.js](/home/vinicius/Coding/4-Projetos%20pessoais/kptransportes/apps/receipt-whatsapp-bot/src/services/api.service.js) ja expone:

- `findInvoiceByNumber`
- `updateInvoiceReceiptStatus`
- `createReceiptAlert`
- `syncAnalysisResult`

Hoje o servico suporta:

- `mock`, para desenvolvimento local puro
- `backend_db`, consultando diretamente a base do backend
- `auto`, tentando `backend_db` primeiro e caindo para `mock` se necessario

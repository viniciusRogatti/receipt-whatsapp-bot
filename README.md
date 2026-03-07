# Receipt WhatsApp Bot

Bot incremental em Node.js para leitura de canhotos enviados no WhatsApp, com foco em identificar automaticamente a NF-e a partir da foto e preparar a futura integracao com a API do sistema.

## Etapa atual

Implementado nesta etapa:

- estrutura base do projeto em Node.js
- runner local para percorrer imagens da pasta `test-images/`
- geracao de JSON por imagem em `outputs/results/`
- resumo consolidado em `outputs/reports/local-run-summary.json`
- configuracao minima de ambiente e logs
- pastas e modulos preparados para as proximas etapas

Ainda **nao** implementado nesta etapa:

- preprocessamento de imagem
- OCR
- deteccao de campos obrigatorios
- extracao da NF
- integracao com WhatsApp
- integracao com API

## Estrutura

```text
apps/receipt-whatsapp-bot/
  src/
    config/
      env.js
    services/
      imagePreprocess.service.js
      ocr.service.js
      receiptDetector.service.js
      nfExtractor.service.js
      whatsapp.service.js
      api.service.js
    utils/
      file.js
      logger.js
      regex.js
      textNormalization.js
    tests/
      localImageRunner.js
    index.js
  test-images/
  outputs/
  package.json
  README.md
  .env.example
```

## Dependencias escolhidas

Nesta primeira etapa o projeto usa apenas:

- `dotenv`: biblioteca estavel e amplamente usada para configuracao por variaveis de ambiente.

Bibliotecas planejadas para as proximas etapas:

- `sharp`: preprocessamento de imagem com boa performance e ecossistema maduro.
- `tesseract.js`: OCR popular em Node.js, adequado para iterar localmente antes de uma pipeline mais especializada.

Essas bibliotecas ainda nao foram adicionadas para manter a ETAPA 1 enxuta e isolada.

## Como rodar localmente

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar ambiente

Copie `.env.example` para `.env` se quiser personalizar caminhos ou nivel de log.

Exemplo:

```bash
cp .env.example .env
```

### 3. Adicionar imagens de teste

Coloque manualmente arquivos como `.jpg`, `.jpeg`, `.png`, `.webp`, `.tif` ou `.bmp` dentro de `test-images/`.

Exemplos:

- `test-images/fotoBoa.jpeg`
- `test-images/fotoRuim.jpeg`

### 4. Rodar o processamento local

```bash
npm run test:local
```

## Resultado esperado na ETAPA 1

Para cada imagem encontrada, o runner gera um JSON em `outputs/results/`.

Exemplo:

```json
{
  "fileName": "fotoBoa.jpeg",
  "filePath": "/caminho/absoluto/test-images/fotoBoa.jpeg",
  "processedAt": "2026-03-07T12:00:00.000Z",
  "status": "stage_1_pending_analysis"
}
```

Tambem e gerado um resumo consolidado:

- `outputs/reports/local-run-summary.json`

## Fluxo da ETAPA 1

1. Ler a pasta `test-images/`
2. Identificar arquivos de imagem suportados
3. Gerar um JSON por arquivo em `outputs/results/`
4. Registrar um resumo consolidado da execucao

## Proxima etapa preparada

ETAPA 2 sera a implementacao do preprocessamento robusto de imagem:

- escala de cinza
- contraste
- binarizacao
- nitidez
- redimensionamento
- multiplas versoes por imagem

O projeto ja esta organizado para encaixar isso em `src/services/imagePreprocess.service.js` e ampliar o runner local sem quebrar a base atual.

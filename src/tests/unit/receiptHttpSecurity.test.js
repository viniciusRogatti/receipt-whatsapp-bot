const assert = require('assert');
const env = require('../../config/env');
const createReceiptsRouter = require('../../http/routes/receipts.routes');
const { validateRemoteAssetUrl } = require('../../services/ingestion/receiptAssetSupport.service');

const createResponse = () => ({
  statusCode: 200,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return this;
  },
});

module.exports = () => [
  {
    name: 'receiptHttpSecurity rejeita requisicao sem credencial antes do upload',
    run: () => {
      const originalTokens = env.receiptCompanyIngestTokens;
      env.receiptCompanyIngestTokens = { 'mar-e-rio': ['segredo-de-teste'] };
      try {
        const response = createResponse();
        let nextCalled = false;
        createReceiptsRouter.authorizeReceiptApi({ headers: {} }, response, () => { nextCalled = true; });
        assert.strictEqual(response.statusCode, 401);
        assert.strictEqual(response.payload.error, 'INVALID_INGEST_CREDENTIALS');
        assert.strictEqual(nextCalled, false);
      } finally {
        env.receiptCompanyIngestTokens = originalTokens;
      }
    },
  },
  {
    name: 'receiptHttpSecurity vincula a empresa a credencial autenticada',
    run: () => {
      const originalTokens = env.receiptCompanyIngestTokens;
      env.receiptCompanyIngestTokens = { 'mar-e-rio': ['segredo-de-teste'] };
      try {
        const request = {
          headers: { authorization: 'Bearer segredo-de-teste' },
          body: { companyId: 'outra-empresa', source: 'api' },
        };
        const response = createResponse();
        let nextCalled = false;
        createReceiptsRouter.authorizeReceiptApi(request, response, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true);
        assert.strictEqual(request.receiptApiCompanyId, 'mar-e-rio');
        assert.strictEqual(createReceiptsRouter.__testables.buildPayloadFromRequest(request).companyId, 'mar-e-rio');
      } finally {
        env.receiptCompanyIngestTokens = originalTokens;
      }
    },
  },
  {
    name: 'receiptHttpSecurity bloqueia URL remota fora da allowlist',
    run: () => {
      assert.throws(
        () => validateRemoteAssetUrl('http://127.0.0.1/segredo', ['imagens.exemplo.com']),
        /nao autorizado/,
      );
      assert.throws(
        () => validateRemoteAssetUrl('https://outro.exemplo.com/foto.jpg', ['imagens.exemplo.com']),
        /nao autorizado/,
      );
      assert.strictEqual(
        validateRemoteAssetUrl('https://imagens.exemplo.com/foto.jpg', ['imagens.exemplo.com']),
        'https://imagens.exemplo.com/foto.jpg',
      );
    },
  },
  {
    name: 'receiptHttpSecurity registra autenticacao antes do multipart em todas as rotas',
    run: () => {
      const router = createReceiptsRouter();
      const protectedRoutes = router.stack.filter((layer) => layer.route);
      assert.strictEqual(protectedRoutes.length, 3);
      protectedRoutes.forEach((layer) => {
        assert.strictEqual(layer.route.stack[0].handle, createReceiptsRouter.authorizeReceiptApi);
      });
    },
  },
];

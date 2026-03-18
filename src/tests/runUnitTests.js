const path = require('path');
const logger = require('../utils/logger');
const { assertSupportedNode } = require('../utils/runtime');

const testModules = [
  require('./unit/textNormalization.test'),
  require('./unit/variantRelation.test'),
  require('./unit/receiptDetector.test'),
  require('./unit/nfExtractor.test'),
  require('./unit/receiptAnalysis.test'),
  require('./unit/receiptClassifier.test'),
  require('./unit/receiptValidation.test'),
  require('./unit/receiptTemplate.test'),
  require('./unit/imagePreprocess.test'),
  require('./unit/profileResolver.test'),
  require('./unit/backendSyncSupport.test'),
  require('./unit/backendSyncPayloadAdapter.test'),
  require('./unit/whatsappRuntimeSupport.test'),
  require('./unit/fileJobQueue.test'),
  require('./unit/documentFieldParser.test'),
  require('./unit/processingStateRepository.test'),
  require('./unit/receiptAssetStorage.test'),
];

async function main() {
  assertSupportedNode('npm test');

  const tests = [];
  testModules.forEach((moduleFactory) => {
    const exportedTests = typeof moduleFactory === 'function' ? moduleFactory() : moduleFactory;
    exportedTests.forEach((testCase) => tests.push(testCase));
  });

  let passed = 0;
  let failed = 0;

  for (const testCase of tests) {
    try {
      await Promise.resolve(testCase.run());
      passed += 1;
      console.log(`PASS ${testCase.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${testCase.name}`);
      console.error(`  ${error.message}`);
    }
  }

  logger.info('Testes unitarios finalizados.', {
    total: tests.length,
    passed,
    failed,
    cwd: path.resolve(__dirname, '..', '..'),
  });

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  logger.error('Falha ao executar testes unitarios.', {
    error: error.message,
  });
  process.exitCode = 1;
});

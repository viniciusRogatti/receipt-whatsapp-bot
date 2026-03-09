const MIN_SUPPORTED_NODE_MAJOR = 18;

const getCurrentNodeMajor = () => Number(String(process.versions.node || '0').split('.')[0] || 0);

const assertSupportedNode = (contextLabel = 'receipt-whatsapp-bot') => {
  const currentMajor = getCurrentNodeMajor();

  if (currentMajor >= MIN_SUPPORTED_NODE_MAJOR) {
    return;
  }

  throw new Error(
    `${contextLabel} requer Node ${MIN_SUPPORTED_NODE_MAJOR}+; ambiente atual: ${process.version}. `
    + 'Use "nvm use 18" antes de rodar este comando.',
  );
};

module.exports = {
  MIN_SUPPORTED_NODE_MAJOR,
  assertSupportedNode,
};

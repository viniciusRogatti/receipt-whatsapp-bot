// Critical tests must replace transports; NODE_ENV alone does not isolate production.
const deny = () => { throw new Error('Teste crítico tentou acessar rede real: substitua o transporte por mock.'); };
require('node:net').Socket.prototype.connect = deny;
require('node:tls').connect = deny;
global.fetch = deny;

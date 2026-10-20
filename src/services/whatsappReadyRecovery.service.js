// wwebjs 1.34.7 can lose a transient iframe while exposing its event bindings.
// Retry only this bounded setup step; never manufacture a ready event.
function installReadyRecovery(client, logger) {
  const attach = client.attachEventListeners.bind(client);
  client.attachEventListeners = async (...args) => {
    for(let attempt = 1; ; attempt++) {
      try { return await attach(...args); }
      catch(error) {
        const message = String(error?.message || error);
        logger.warn('Falha ao vincular eventos do WhatsApp.', { attempt, message: message.slice(0, 240) });
        const transient = /Target closed|Session closed|detached Frame|frame was detached|Cannot find context with specified id/i.test(message);
        if (!transient || attempt >= 3 || client.pupPage?.isClosed()) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  };
}
module.exports = { installReadyRecovery };

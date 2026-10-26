// WhatsApp Web may expose its serialized ID as $1. Keep the SDK's expected
// field without reconstructing IDs (group messages can include a participant).
const serializedId = (id) => {
  if (!id || typeof id !== 'object') return '';
  for (const value of [id._serialized, id.$1]) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
};

const normalizeId = (id) => {
  const value = serializedId(id);
  return value && !id._serialized ? { ...id, _serialized: value } : id;
};

function installMessageIdentityCompatibility(Message) {
  if (Message.prototype._kpIdentityCompatibility) return;
  const patch = Message.prototype._patch;
  Message.prototype._patch = function (data) {
    return patch.call(this, {
      ...data,
      id: normalizeId(data.id),
      from: normalizeId(data.from),
      to: normalizeId(data.to),
      author: normalizeId(data.author),
    });
  };
  Object.defineProperty(Message.prototype, '_kpIdentityCompatibility', { value: true });
}

module.exports = { serializedId, normalizeId, installMessageIdentityCompatibility };

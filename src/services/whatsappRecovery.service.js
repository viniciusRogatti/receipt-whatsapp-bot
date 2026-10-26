const { withDownloadedPhoto } = require('./whatsappMedia.service');
const { resolveWhatsappMessageId } = require('./whatsappRuntimeSupport.service');
const { parseWhatsappCaption } = require('../utils/whatsappCaption');

async function recoverPhoto({ message, group, policy, processReceipt, dryRun = false }) {
  const caption = String(message.body || '').trim();
  const parsed = parseWhatsappCaption(caption);
  if (!parsed.valid && !parsed.malformedNumber) return { ignored: true };
  const id = resolveWhatsappMessageId(message);
  if (!id || id.startsWith('whatsapp:')) throw new Error('Identificador original da foto indisponível.');
  if (message.from !== group.id) throw new Error('A foto não pertence ao grupo selecionado.');
  return withDownloadedPhoto(message, async (imagePath) => {
    if (dryRun) return { downloaded: true };
    return processReceipt({
      message: {
        id, imagePath, groupId: group.id, chatId: group.id,
        groupName: group.name || null,
        mediaId: message.id?.id || null,
        senderId: message.author || null,
        timestamp: Number(message.timestamp) * 1000,
        messageText: caption, caption, body: caption, hasPhoto: true,
        whatsappProcessingMode: policy.processingMode || 'caption_only',
        expectedCompanyCode: policy.companyCode,
        expectedCompanyId: policy.companyId || null,
        expectedCompanyName: policy.companyName || null,
      },
    });
  });
}

module.exports = { recoverPhoto };

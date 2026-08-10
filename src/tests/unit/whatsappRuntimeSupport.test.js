const assert = require('assert');
const {
  isGroupAllowed,
  parseTextCommand,
  resolveWhatsappGroupPolicy,
  resolveWhatsappMessageId,
  resolveMediaFileName,
} = require('../../services/whatsappRuntimeSupport.service');

module.exports = () => {
  return [
    {
      name: 'whatsappRuntimeSupport aceita grupo por id ou nome configurado',
      run: () => {
        assert.strictEqual(isGroupAllowed({
          groupId: '120363111@g.us',
          groupName: 'Comprovantes',
          allowedGroupIds: ['120363111@g.us'],
          allowedGroupNames: [],
        }), true);

        assert.strictEqual(isGroupAllowed({
          groupId: '120363222@g.us',
          groupName: 'Comprovantes',
          allowedGroupIds: [],
          allowedGroupNames: ['comprovantes'],
        }), true);

        assert.strictEqual(isGroupAllowed({
          groupId: '120363333@g.us',
          groupName: 'Outro Grupo',
          allowedGroupIds: ['120363111@g.us'],
          allowedGroupNames: ['comprovantes'],
        }), false);
      },
    },
    {
      name: 'whatsappRuntimeSupport interpreta comandos de texto com prefixo configuravel',
      run: () => {
        const command = parseTextCommand({
          body: '!recibo status agora',
          prefix: '!recibo',
        });

        assert.deepStrictEqual(command, {
          command: 'status',
          args: ['agora'],
        });
      },
    },
    {
      name: 'whatsappRuntimeSupport monta nome de arquivo de midia a partir do messageId',
      run: () => {
        const fileName = resolveMediaFileName({
          mimeType: 'image/webp',
          originalFileName: '',
          messageId: 'ABCD:123',
        });

        assert.strictEqual(fileName, 'ABCD_123.webp');
      },
    },
    {
      name: 'whatsappRuntimeSupport preserva o id serializado fornecido pelo WhatsApp',
      run: () => {
        assert.strictEqual(resolveWhatsappMessageId({
          id: { _serialized: 'false_5511999999999@g.us_ABC123' },
          from: '5511999999999@g.us',
        }), 'false_5511999999999@g.us_ABC123');
      },
    },
    {
      name: 'whatsappRuntimeSupport monta id estavel quando o MessageId nao expoe _serialized',
      run: () => {
        assert.strictEqual(resolveWhatsappMessageId({
          id: { fromMe: false, remote: '5511999999999@g.us', id: 'ABC123' },
          from: '5511999999999@g.us',
        }), 'whatsapp:5511999999999@g.us:ABC123');
      },
    },
    {
      name: 'whatsappRuntimeSupport usa o id interno da midia sem converter objeto em texto',
      run: () => {
        assert.strictEqual(resolveWhatsappMessageId({
          id: { fromMe: false },
          _data: { id: { id: 'MEDIA456' } },
          from: '5511999999999@g.us',
        }), 'whatsapp:5511999999999@g.us:MEDIA456');
        assert.notStrictEqual(resolveWhatsappMessageId({ id: {} }), '[object Object]');
      },
    },
    {
      name: 'whatsappRuntimeSupport diferencia fotos simultaneas e mantem repeticao idempotente',
      run: () => {
        const first = {
          id: { id: 'PHOTO-A' },
          from: '5511999999999@g.us',
        };
        const second = {
          id: { id: 'PHOTO-B' },
          from: '5511999999999@g.us',
        };

        assert.notStrictEqual(resolveWhatsappMessageId(first), resolveWhatsappMessageId(second));
        assert.strictEqual(resolveWhatsappMessageId(first), resolveWhatsappMessageId(first));
      },
    },
    {
      name: 'whatsappRuntimeSupport resolve politica por nome normalizado do grupo',
      run: () => {
        const policy = resolveWhatsappGroupPolicy({
          groupName: '  Canhotos   Pronto ',
          groupPolicies: {
            'canhotos pronto': {
              processingMode: 'caption_only',
              companyCode: 'pronto',
            },
          },
        });

        assert.deepStrictEqual(policy, {
          key: 'canhotos pronto',
          processingMode: 'caption_only',
          companyCode: 'pronto',
          companyId: null,
          companyName: null,
        });
      },
    },
  ];
};

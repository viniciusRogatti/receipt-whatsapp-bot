const assert = require('assert');
const {
  isGroupAllowed,
  parseTextCommand,
  resolveWhatsappGroupPolicy,
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

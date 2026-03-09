const assert = require('assert');
const {
  expandVariantIdsForDocumentFocus,
  getDocumentFocusVariantId,
} = require('../../utils/variantRelation');

module.exports = () => ([
  {
    name: 'variantRelation escolhe a variante focada equivalente para recorte da NF',
    run: async () => {
      assert.strictEqual(getDocumentFocusVariantId('rotate_left_grayscale'), 'rotate_left_document_focus');
      assert.strictEqual(getDocumentFocusVariantId('grayscale_contrast'), 'document_focus_grayscale');

      const result = expandVariantIdsForDocumentFocus({
        variantIds: ['rotate_left_grayscale'],
        availableVariantIds: [
          'rotate_left_grayscale',
          'rotate_left_document_focus',
          'rotate_right_grayscale',
        ],
      });

      assert.deepStrictEqual(result, [
        'rotate_left_grayscale',
        'rotate_left_document_focus',
      ]);
    },
  },
]);

const assert = require('assert');
const Jimp = require('jimp');
const imagePreprocessService = require('../../services/imagePreprocess.service');

const {
  classifyReceiptCapture,
  resolveOrientationCandidates,
} = imagePreprocessService.__testables;

module.exports = () => ([
  {
    name: 'imagePreprocess detecta strip recortado em retrato e restringe orientacoes',
    run: async () => {
      const image = new Jimp(307, 1599, Jimp.rgbaToInt(255, 255, 255, 255));
      const captureProfile = classifyReceiptCapture(image);
      const orientationIds = resolveOrientationCandidates(image, 'batch', captureProfile)
        .map((candidate) => candidate.id);

      assert.strictEqual(captureProfile.id, 'receipt_strip');
      assert.deepStrictEqual(orientationIds, ['rotate_right', 'rotate_left']);
    },
  },
  {
    name: 'imagePreprocess mantem orientacoes completas para foto comum',
    run: async () => {
      const image = new Jimp(900, 1600, Jimp.rgbaToInt(255, 255, 255, 255));
      const captureProfile = classifyReceiptCapture(image);
      const orientationIds = resolveOrientationCandidates(image, 'batch', captureProfile)
        .map((candidate) => candidate.id);

      assert.strictEqual(captureProfile.id, 'document_photo');
      assert.deepStrictEqual(
        orientationIds,
        ['upright', 'rotate_right', 'rotate_left', 'upside_down'],
      );
    },
  },
]);

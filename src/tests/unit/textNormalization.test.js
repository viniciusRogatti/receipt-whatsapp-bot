const assert = require('assert');
const {
  digitsOnly,
  normalizeOcrNoise,
  toSearchableText,
} = require('../../utils/textNormalization');

module.exports = () => ([
  {
    name: 'textNormalization remove excesso de espacos e ruido basico',
    run: () => {
      assert.strictEqual(
        normalizeOcrNoise('  NF-e   “16171762”  '),
        'NF-e "16171762"',
      );
    },
  },
  {
    name: 'textNormalization gera texto pesquisavel sem acentos',
    run: () => {
      assert.strictEqual(
        toSearchableText('SÉRIE 1 - RECEBEMOS DE MAR E RIO'),
        'serie 1 recebemos de mar e rio',
      );
    },
  },
  {
    name: 'textNormalization extrai apenas digitos',
    run: () => {
      assert.strictEqual(digitsOnly('N° 1617.1762'), '16171762');
    },
  },
  {
    name: 'textNormalization recupera colchete lido como ultimo digito da NF',
    run: () => {
      assert.strictEqual(
        normalizeOcrNoise('Nº 171056]'),
        'No 1710561',
      );
    },
  },
]);

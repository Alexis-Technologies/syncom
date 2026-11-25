'use strict';

const { describe } = require('node:test');
const assert = require('node:assert/strict');
// The two halves of the node crypto — the RSA pair of /encryption and the
// Ed25519 pair of /signing — under one name, as the suite reads them.
const cryptoMod = { ...require('../src/encryption/rsa.js'), ...require('../src/signing/ed25519.js') };
const fsi = require('../src/fsi.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { runCryptoKeysTests } = require('./suites/crypto-keys.js');

describe('Keys module', () => {
  runCryptoKeysTests(assert, cryptoMod, {
    fsi,
    getKeysBase: async (t) => {
      const tempDir = await createTemp();
      t.after(() => cleanupTemp(tempDir));
      return tempDir;
    },
  });
});

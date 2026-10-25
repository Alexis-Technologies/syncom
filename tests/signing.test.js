'use strict';

const test = require('node:test');
const assert = require('node:assert');
const signing = require('../src/signing/sign.js');
const cryptoMod = require('../src/signing/ed25519.js');
const { runSigningTests } = require('./suites/signing.js');

test('signing (node)', async (t) => {
  await runSigningTests(t, assert, signing, cryptoMod);
});

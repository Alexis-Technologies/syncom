'use strict';

const { describe } = require('node:test');
const assert = require('node:assert/strict');
const signing = require('../src/signing/sign.js');
const cryptoMod = require('../src/signing/ed25519.js');
const { runSigningTests } = require('./suites/signing.js');

describe('signing (node)', () => runSigningTests(assert, signing, cryptoMod));

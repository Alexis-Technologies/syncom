'use strict';

const test = require('node:test');
const fsi = require('../src/fsi.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { runFsiTests } = require('./suites/fsi.js');

test('fsi module', async (t) => {
  await runFsiTests(t, fsi, {
    getRoot: createTemp,
    afterEach: cleanupTemp,
  });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { fileExists } = require('../src/utils.js');
const syncom = require('../src/all/all.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');

test('Chain module', async (t) => {
  await t.test('calculateHash function', () => {
    const data = { test: 'data' };
    const hash1 = syncom.calculateHash(data);
    const hash2 = syncom.calculateHash(data);

    assert.strictEqual(typeof hash1, 'string');
    assert.strictEqual(hash1.length, 64);
    assert.strictEqual(hash1, hash2);
  });

  await t.test('Blockchain constructor and initialization', async () => {
    const tempDir = await createTemp();
    try {
      const blockchain = await new syncom.Blockchain(tempDir);

      assert.strictEqual(blockchain.path, tempDir);
      assert.strictEqual(typeof blockchain.tailHash, 'string');

      const chainFile = path.join(tempDir, '.blockchain.json');
      assert.strictEqual(await fileExists(chainFile), true);
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Blockchain addBlock and readBlock', async () => {
    const tempDir = await createTemp();
    try {
      const blockchain = await new syncom.Blockchain(tempDir);
      const testData = { message: 'Test block data' };

      const hash = await blockchain.addBlock(testData);
      assert.strictEqual(typeof hash, 'string');
      assert.strictEqual(hash.length, 64);

      const block = await blockchain.readBlock(hash);
      assert.notStrictEqual(block.prev, '0');
      assert.strictEqual(typeof block.timestamp, 'number');
      assert.deepStrictEqual(block.data, testData);
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Blockchain chain validation', async () => {
    const tempDir = await createTemp();
    try {
      const blockchain = await new syncom.Blockchain(tempDir);

      await blockchain.addBlock({ data: 'block1' });
      await blockchain.addBlock({ data: 'block2' });
      await blockchain.addBlock({ data: 'block3' });

      const isValid = await blockchain.validate();
      assert.strictEqual(isValid, true);

      const isValidLast = await blockchain.validate({ last: 2 });
      // An unknown starting hash is an invalid chain, not an exception.
      assert.strictEqual(await blockchain.validate({ from: 'deadbeef' }), false);
      assert.strictEqual(isValidLast, true);
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Blockchain writeBlock', async () => {
    const tempDir = await createTemp();
    try {
      const blockchain = await new syncom.Blockchain(tempDir);
      const timestamp = Date.now();
      const data = { test: 'data' };
      const testBlock = { prev: '0', timestamp, data };

      const hash = await blockchain.writeBlock(testBlock);
      assert.strictEqual(typeof hash, 'string');

      const blockFile = path.join(tempDir, `${hash}.json`);
      assert.strictEqual(await fileExists(blockFile), true);
    } finally {
      await cleanupTemp(tempDir);
    }
  });
});

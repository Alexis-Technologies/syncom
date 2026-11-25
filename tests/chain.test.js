'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fileExists } = require('../src/utils.js');
const syncom = require('../src/all/all.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');

describe('Chain module', () => {
  it('should hash data to the same 64-character string with the calculateHash function', () => {
    const data = { test: 'data' };
    const hash1 = syncom.calculateHash(data);
    const hash2 = syncom.calculateHash(data);

    assert.strictEqual(typeof hash1, 'string');
    assert.strictEqual(hash1.length, 64);
    assert.strictEqual(hash1, hash2);
  });

  it('should initialize a Blockchain in its constructor and write its chain file', async () => {
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

  it('should read back with readBlock the block a Blockchain adds with addBlock', async () => {
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

  it('should validate a Blockchain chain whole, by its last blocks, and from an unknown hash', async () => {
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

  it('should write a block file with Blockchain writeBlock', async () => {
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

'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const runFsiTests = (fsi, options = {}) => {
  const { getRoot, afterEach } = options;
  const joinPath = options.joinPath ?? ((r, ...p) => path.join(r, ...p));

  const finish = async (dir) => {
    if (afterEach) await afterEach(dir);
  };

  it('should write, read, check exists and remove a file', async () => {
    const dir = await getRoot();
    try {
      assert.strictEqual(await fsi.exists(dir, 'a.txt'), false);
      await fsi.write(dir, 'a.txt', 'hello');
      assert.strictEqual(await fsi.exists(dir, 'a.txt'), true);
      assert.strictEqual(await fsi.read(dir, 'a.txt'), 'hello');
      await fsi.remove(dir, 'a.txt');
      assert.strictEqual(await fsi.exists(dir, 'a.txt'), false);
    } finally {
      await finish(dir);
    }
  });

  it('should create nested directories on write', async () => {
    const root = await getRoot();
    try {
      const nested = joinPath(root, 'x', 'y');
      await fsi.write(nested, 'f.json', '{}');
      assert.strictEqual(await fsi.exists(nested, 'f.json'), true);
      assert.strictEqual(await fsi.read(nested, 'f.json'), '{}');
    } finally {
      await finish(root);
    }
  });

  it('should not throw on remove when the file is missing', async () => {
    const dir = await getRoot();
    try {
      await fsi.remove(dir, 'nope.txt');
      assert.strictEqual(await fsi.exists(dir, 'nope.txt'), false);
    } finally {
      await finish(dir);
    }
  });

  it('should list file names only, sorted, and an absent directory as empty', async () => {
    const root = await getRoot();
    try {
      assert.deepStrictEqual(await fsi.list(joinPath(root, 'never')), []);
      await fsi.write(root, 'b.json', '{}');
      await fsi.write(root, 'a.json', '{}');
      await fsi.write(joinPath(root, 'sub'), 'c.json', '{}');
      assert.deepStrictEqual(await fsi.list(root), ['a.json', 'b.json']);
      assert.deepStrictEqual(await fsi.list(joinPath(root, 'sub')), ['c.json']);
    } finally {
      await finish(root);
    }
  });

  // The optional append: what the op log's journal writes with.
  if (typeof fsi.append === 'function') {
    it('should make the file and its directory on append, add in call order and build on a write', async () => {
      const root = await getRoot();
      try {
        const nested = joinPath(root, 'j', 'k');
        await fsi.append(nested, 'a.jsonl', 'one\n');
        assert.strictEqual(await fsi.read(nested, 'a.jsonl'), 'one\n');
        await Promise.all(['two\n', 'three\n', 'four\n'].map((line) => fsi.append(nested, 'a.jsonl', line)));
        assert.strictEqual(await fsi.read(nested, 'a.jsonl'), 'one\ntwo\nthree\nfour\n');
        // A write replaces the file; the next append adds to what it wrote.
        await fsi.write(nested, 'a.jsonl', 'w\n');
        await fsi.append(nested, 'a.jsonl', 'x\n');
        assert.strictEqual(await fsi.read(nested, 'a.jsonl'), 'w\nx\n');
        // A removed file is gone; the next append begins it again.
        await fsi.remove(nested, 'a.jsonl');
        assert.strictEqual(await fsi.exists(nested, 'a.jsonl'), false);
        await fsi.append(nested, 'a.jsonl', 'y\n');
        assert.strictEqual(await fsi.read(nested, 'a.jsonl'), 'y\n');
        assert.deepStrictEqual(await fsi.list(nested), ['a.jsonl']);
      } finally {
        await finish(root);
      }
    });
  }

  it('should reject a read when the file is missing', async () => {
    const dir = await getRoot();
    try {
      await assert.rejects(
        () => fsi.read(dir, 'missing.txt'),
        (err) => {
          const isEnoent = err?.code === 'ENOENT';
          const isNotFound = err?.name === 'NotFoundError';
          const matches = isEnoent || isNotFound;
          return Boolean(err && matches);
        },
      );
    } finally {
      await finish(dir);
    }
  });
};

module.exports = { runFsiTests };

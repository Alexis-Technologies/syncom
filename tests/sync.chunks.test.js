'use strict';

// A blob's bytes over a link's stream (src/sync/chunks.js): written in pieces as the transport takes them, read to
// the size announced and no further. The writable and the readable here are hand-made — wrpc's shapes, each with
// the one behaviour its case needs; tests/attachments.test.js and tests/wrpc.integration.test.js run the same code
// over MemoryLink's streams and over wrpc's own.

const test = require('node:test');
const assert = require('node:assert');
const { Emitter } = require('../src/utils.js');
const { CHUNK_BYTES, streams, pump, collect } = require('../src/sync/chunks.js');

// A writable that records what it is handed; `accept(n)` says whether the n-th write is taken at once.
const writable = (accept = () => true) => {
  const stream = Object.assign(new Emitter(), {
    closed: false,
    written: [],
    ended: 0,
    terminated: 0,
    write(chunk) {
      stream.written.push(chunk.length);
      return accept(stream.written.length, stream);
    },
    end: () => void stream.ended++,
    terminate: () => void stream.terminated++,
  });
  return stream;
};

const bytesOf = (length) => {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i % 251;
  return bytes;
};

test('a blob over a stream', async (t) => {
  await t.test('pump writes pieces of CHUNK_BYTES, the last a short one, then ends the stream', async () => {
    const stream = writable();
    assert.strictEqual(await pump(stream, bytesOf(CHUNK_BYTES * 2 + 5)), true);
    assert.deepStrictEqual(stream.written, [CHUNK_BYTES, CHUNK_BYTES, 5]);
    assert.deepStrictEqual([stream.ended, stream.terminated], [1, 0]);
    // Exactly one piece; nothing at all.
    const one = writable();
    await pump(one, bytesOf(CHUNK_BYTES));
    assert.deepStrictEqual(one.written, [CHUNK_BYTES]);
    const none = writable();
    assert.strictEqual(await pump(none, new Uint8Array(0)), true);
    assert.deepStrictEqual([none.written.length, none.ended], [0, 1]);
  });

  await t.test('pump waits for drain when a piece is not taken at once, and goes on after it', async () => {
    const stream = writable((n) => n !== 2);
    const pumping = pump(stream, bytesOf(CHUNK_BYTES * 3));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(stream.written.length, 2, 'the third piece waits for the drain');
    assert.strictEqual(stream.ended, 0);
    await stream.emit('drain');
    assert.strictEqual(await pumping, true);
    assert.strictEqual(stream.written.length, 3);
    assert.strictEqual(stream.ended, 1);
  });

  await t.test(
    'pump stops for a closed transport — at the write, or behind the drain — and never ends it',
    async () => {
      // Closed by the write itself: no drain will follow, none is waited for.
      const atWrite = writable((n, stream) => {
        stream.closed = true;
        return false;
      });
      assert.strictEqual(await pump(atWrite, bytesOf(CHUNK_BYTES * 2)), false);
      assert.deepStrictEqual([atWrite.written.length, atWrite.ended, atWrite.terminated], [1, 0, 0]);
      // Full, then closed: the drain a closing transport lets a writer go with.
      const behind = writable(() => false);
      const pumping = pump(behind, bytesOf(CHUNK_BYTES * 2));
      await new Promise((resolve) => setImmediate(resolve));
      behind.closed = true;
      await behind.emit('drain');
      assert.strictEqual(await pumping, false);
      assert.deepStrictEqual([behind.written.length, behind.ended], [1, 0]);
    },
  );

  await t.test('pump terminates the stream once the other end has answered, the rest unsent', async () => {
    const stream = writable();
    let pieces = 0;
    // Answered after the second piece.
    assert.strictEqual(await pump(stream, bytesOf(CHUNK_BYTES * 4), () => pieces++ >= 2), false);
    assert.deepStrictEqual([stream.written.length, stream.ended, stream.terminated], [2, 0, 1]);
  });

  await t.test('collect reads the size announced and no further: short as it is, long as null', async () => {
    const source = async function* source(chunks, seen) {
      for (const chunk of chunks) {
        seen.push(chunk.length);
        yield chunk;
      }
    };
    const bytes = bytesOf(10);
    const parts = [bytes.subarray(0, 4), bytes.subarray(4, 10), bytes.subarray(0, 3)];
    // Exactly the size: the third chunk is never asked for — the end of the stream is not waited for.
    let seen = [];
    assert.deepStrictEqual(await collect(source(parts, seen), 10), bytes);
    assert.deepStrictEqual(seen, [4, 6]);
    // The stream ended short: what came, for the caller to refuse.
    assert.deepStrictEqual(await collect(source(parts.slice(0, 1), []), 10), bytes.subarray(0, 4));
    // More than announced.
    assert.strictEqual(await collect(source(parts, []), 7), null);
    // A link that hands text hands UTF-8.
    assert.deepStrictEqual(await collect(source(['ab', 'c'], []), 3), new TextEncoder().encode('abc'));
    // Nothing announced, nothing read.
    seen = [];
    assert.deepStrictEqual(await collect(source(parts, seen), 0), new Uint8Array(0));
    assert.deepStrictEqual(seen, []);
  });

  await t.test('streams() is a persistent, binary client that announces streams', () => {
    const createStream = () => {};
    assert.strictEqual(streams({ createStream }), true);
    assert.strictEqual(streams({ createStream, binary: true, persistent: true }), true);
    assert.strictEqual(streams({ createStream, binary: false }), false, 'a text-only transport');
    assert.strictEqual(streams({ createStream, persistent: false }), false, 'one request, one answer');
    assert.strictEqual(streams({ binary: true }), false);
    assert.strictEqual(streams(null), false);
    assert.strictEqual(streams(undefined), false);
  });
});

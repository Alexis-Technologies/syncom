'use strict';

// A blob's bytes over a link's stream (src/sync/chunks.js): written through the transport's own `writeAll` and ended
// once all of it went, read to the size announced and no further. The writable and the readable here are hand-made —
// wrpc's shapes, each with the one behaviour its case needs; tests/attachments.test.js and
// tests/wrpc.integration.test.js run the same code over MemoryLink's streams and over wrpc's own.

const test = require('node:test');
const assert = require('node:assert');
const { streams, sendAll, collect } = require('../src/sync/chunks.js');

// A writable whose `writeAll` records what it is handed and answers `all`: whether every byte went.
const writable = (all = true) => {
  const stream = {
    written: [],
    ended: 0,
    terminated: 0,
    writeAll: async (bytes) => {
      stream.written.push(bytes.length);
      return all;
    },
    end: () => void stream.ended++,
    terminate: () => void stream.terminated++,
  };
  return stream;
};

const bytesOf = (length) => {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i % 251;
  return bytes;
};

test('a blob over a stream', async (t) => {
  await t.test('sendAll hands every byte to writeAll and ends the stream once all of it went', async () => {
    const stream = writable();
    assert.strictEqual(await sendAll(stream, bytesOf(70_000)), true);
    assert.deepStrictEqual([stream.written, stream.ended, stream.terminated], [[70_000], 1, 0]);
    // Nothing at all is a stream of no bytes, ended.
    const none = writable();
    assert.strictEqual(await sendAll(none, new Uint8Array(0)), true);
    assert.deepStrictEqual([none.written, none.ended], [[0], 1]);
  });

  await t.test('sendAll leaves a stream the transport closed or its reader let go of as it is', async () => {
    const stream = writable(false);
    assert.strictEqual(await sendAll(stream, bytesOf(10)), false);
    assert.deepStrictEqual([stream.ended, stream.terminated], [0, 0]);
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
    const seen = [];
    assert.deepStrictEqual(await collect(source(parts, seen), 10), bytes);
    assert.deepStrictEqual(seen, [4, 6]);
    // The stream ended short: what came, for the caller to refuse.
    assert.deepStrictEqual(await collect(source(parts.slice(0, 1), []), 10), bytes.subarray(0, 4));
    // More than announced.
    assert.strictEqual(await collect(source(parts, []), 7), null);
    // A link that hands text hands UTF-8.
    assert.deepStrictEqual(await collect(source(['ab', 'c'], []), 3), new TextEncoder().encode('abc'));
    // A stream of no bytes is read to its end; one that sends a byte past nothing is long.
    assert.deepStrictEqual(await collect(source([], []), 0), new Uint8Array(0));
    assert.strictEqual(await collect(source(parts, []), 0), null);
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

'use strict';

// The testing subpath as an application's test would use it: the memory engine, a mesh from an adjacency list,
// settle(), the hazards of a link, withDatabase(). The repository's own tests run on the same code through
// tests/utils/mesh.js and tests/utils/memory-link.js, so what is checked here is the surface of its own.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/all/all.js');
const testing = require('../src/testing/testing.js');

const { createMesh, settle, waitUntil, sameVectors, prng, withDatabase, memoryEngine, MemoryLink } = testing;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('@alexify/syncom/testing', () => {
  it('should converge a mesh from an adjacency list over the memory engine; settle() takes the Map; close() closes every node', async () => {
    const engine = memoryEngine();
    const mesh = await createMesh(
      ['A', 'B', 'C'],
      [
        ['A', 'B'],
        ['C', 'B'],
      ],
      {
        createStorage: (name, options) =>
          createDatabase({ ...options, path: name, engine, lock: false, logger: false }),
      },
    );
    const a = mesh.get('A');
    const c = mesh.get('C');
    const id = await a.insert({ title: 'from A' });
    await settle(mesh.storages);
    assert.deepStrictEqual(await c.get(id), { title: 'from A' });
    assert.ok(sameVectors(mesh.storages));
    assert.ok(sameVectors([a, mesh.get('B'), c]));
    assert.ok(mesh.links.get('mem://B') instanceof MemoryLink);
    assert.strictEqual(mesh.servers.size, 1, 'one host server for B');
    assert.strictEqual(mesh.servers.get('B').links.size, 2, 'both dialers of B on its server');
    await mesh.close();
    await assert.rejects(() => a.insert({ title: 'after close' }), { code: 'ALX_ERR_CLOSED' });
  });

  it('should make createMesh() refuse a call without createStorage and a dial to a host that is not there', async () => {
    await assert.rejects(() => createMesh(['A'], [], {}), { name: 'ArgumentError' });
    const engine = memoryEngine();
    const mesh = await createMesh(['A'], [], {
      createStorage: (name, options) => createDatabase({ ...options, path: name, engine, lock: false, logger: false }),
    });
    assert.throws(() => mesh.connect({ url: 'mem://nobody' }), { name: 'ArgumentError', message: /no host nobody/ });
    await mesh.close();
  });

  it('should reject settle() past its timeout where a link drops every page; waitUntil() too', async () => {
    const engine = memoryEngine();
    const mesh = await createMesh(['A', 'B'], [['A', 'B']], {
      createStorage: (name, options) => createDatabase({ ...options, path: name, engine, lock: false, logger: false }),
      link: { drop: () => true },
    });
    await mesh.get('B').insert({ n: 1 });
    await assert.rejects(() => settle(mesh.storages, { timeout: 150, step: 5 }), { message: /did not settle/ });
    assert.strictEqual(mesh.links.get('mem://B').down, true, 'a dropped page took the link down');
    await assert.rejects(() => waitUntil(() => false, { timeout: 30, step: 5 }), { message: /not met/ });
    let polls = 0;
    await waitUntil(async () => ++polls === 3, { step: 1 });
    assert.strictEqual(polls, 3);
    await mesh.close();
  });

  it('should take the link down on a dropped page: nothing after it arrives, and a reconnect resumes from the last page delivered', async () => {
    // A feed of three tracked pages that resumes after the event id it is handed, as the host's does.
    const TRACKED = Symbol.for('wrpc.tracked');
    const unit = {
      changes: {
        async *handler(context, args, { lastEventId }) {
          const from = lastEventId === undefined ? 0 : Number(lastEventId.slice(1));
          for (let i = from + 1; i <= 3; i++) yield { [TRACKED]: true, id: `e${i}`, data: { n: i } };
        },
      },
    };
    let lose = true;
    const link = new MemoryLink(unit, { drop: (page) => lose && page.n === 2 });
    const closes = [];
    link.on('close', () => closes.push('link'));
    link.client.on('close', () => closes.push('client'));
    const delivered = [];
    let ended = false;
    const handle = link.subscribe(
      'syncom/changes',
      {},
      { onData: (data, id) => void delivered.push(id), onEnd: () => void (ended = true) },
    );
    await waitUntil(() => link.down);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepStrictEqual(delivered, ['e1'], 'the page after the dropped one never arrived');
    assert.strictEqual(handle.lastEventId, 'e1', 'the last page delivered, not the dropped one');
    assert.strictEqual(ended, false, 'cut, not ended');
    assert.deepStrictEqual(closes, ['client', 'link'], 'close announced, as a socket that died');
    await assert.rejects(() => link.call('syncom/changes', {}), { code: 503 });
    lose = false;
    await link.reconnect();
    await waitUntil(() => ended);
    assert.deepStrictEqual(delivered, ['e1', 'e2', 'e3'], 'resumed from e1: the dropped page comes again');
  });

  it('should converge after a page dropped, a write while the link is down, then a reconnect, with a fresh client or the same one', async () => {
    for (const freshClient of [true, false]) {
      const engine = memoryEngine();
      let lose = false;
      let lost = 0;
      const mesh = await createMesh(['server', 'laptop'], [['laptop', 'server']], {
        createStorage: (name, options) =>
          createDatabase({
            ...options,
            path: name,
            engine,
            lock: false,
            logger: false,
            schema: { entities: { Task: {} } },
          }),
        // The next page with ops is lost — once: the socket dies with it.
        link: {
          drop: (page) => {
            if (!lose || !(page?.ops?.length > 0)) return false;
            lose = false;
            lost++;
            return true;
          },
        },
      });
      await mesh.get('server').Task.insert({ title: 'first' });
      await settle(mesh.storages);
      const link = mesh.links.get('mem://server');
      lose = true;
      await mesh.get('server').Task.insert({ title: 'lost on the way' });
      await waitUntil(() => lost === 1);
      assert.strictEqual(link.down, true);
      await mesh.get('server').Task.insert({ title: 'written while the link is down' });
      await assert.rejects(() => settle(mesh.storages, { timeout: 100, step: 5 }), { message: /did not settle/ });
      await link.reconnect({ freshClient });
      await settle(mesh.storages);
      assert.strictEqual(await mesh.get('laptop').Task.select({}).count(), 3);
      assert.ok(sameVectors(mesh.storages));
      await mesh.close();
    }
  });

  it('should carry streams: the link is a binary transport — each end announces a stream the other reads, a full writer waits for drain, writeAll writes in pieces, a reader that lets go stops its writer; maxMessage takes the link down', async () => {
    const unit = { echo: { handler: async (context, args) => ({ size: args.text.length }) } };
    // Without the option: no stream on either end, as over a text-only transport.
    const plain = new MemoryLink(unit);
    assert.strictEqual(plain.client.binary, false);
    assert.strictEqual(plain.stream, undefined);
    assert.strictEqual(plain.createStream, undefined);

    const link = new MemoryLink(unit, { streams: true });
    assert.strictEqual(link.client.binary, true);
    const read = async (readable, take = Infinity) => {
      const chunks = [];
      for await (const chunk of readable) {
        chunks.push(chunk);
        if (chunks.length === take) break;
      }
      return chunks;
    };
    // Up: the link announces, the host's client reads — a copy of every chunk, in order, to the end.
    const up = link.createStream('upload', 3);
    const source = Uint8Array.of(1, 2, 3);
    assert.strictEqual(up.write(source), true);
    source[0] = 9;
    up.end();
    assert.strictEqual(up.write(source), false, 'ended');
    assert.deepStrictEqual(await read(link.client.getStream(up.id)), [Uint8Array.of(1, 2, 3)]);
    assert.throws(() => link.client.getStream(up.id), { message: /not initialized/ }, 'read once');
    // Down: the host's client announces, the link reads; a reader waiting hears a chunk written later.
    const down = link.client.createStream('download', 2);
    const reading = read(link.stream(down.id));
    await sleep(5);
    down.write(Uint8Array.of(4));
    down.write(Uint8Array.of(5));
    down.end();
    assert.deepStrictEqual(await reading, [Uint8Array.of(4), Uint8Array.of(5)]);
    // A writer's own terminate ends the reader with what was not read dropped.
    const cut = link.createStream('cut', 9);
    cut.write(Uint8Array.of(1));
    cut.terminate();
    assert.deepStrictEqual(await read(link.client.getStream(cut.id)), []);
    // Backpressure: a few chunks unread and `write` answers false; `drain` follows once the reader took some.
    const paced = link.createStream('paced', 100);
    let accepted = true;
    let written = 0;
    while (accepted) {
      accepted = paced.write(Uint8Array.of(written));
      written++;
    }
    assert.ok(written > 1 && written < 16, `a small window (${written})`);
    const drained = new Promise((resolve) => paced.once('drain', resolve));
    const readable = link.client.getStream(paced.id);
    const first = await read(readable, 2);
    assert.deepStrictEqual(first, [Uint8Array.of(0), Uint8Array.of(1)]);
    await drained;
    // The reader lets go and its writer hears it, as over wrpc 2.1: closed, `close` once, a 499, nothing more taken.
    let heard = 0;
    paced.once('close', () => heard++);
    readable.terminate();
    assert.strictEqual(paced.closed, true);
    assert.strictEqual(heard, 1);
    assert.strictEqual(paced.error.code, 499);
    assert.strictEqual(paced.write(Uint8Array.of(7)), false);
    assert.deepStrictEqual(await read(readable), []);
    // writeAll: pieces of 64 KiB, the last a short one, then the writer ends it.
    const whole = link.createStream('whole', 150_000);
    const reader = read(link.client.getStream(whole.id));
    assert.strictEqual(await whole.writeAll(new Uint8Array(150_000).fill(3)), true);
    whole.end();
    const sizes = [];
    for (const chunk of await reader) sizes.push(chunk.length);
    assert.deepStrictEqual(sizes, [65_536, 65_536, 18_928]);
    // A writeAll waiting for its drain is let go by a reader that lets go: false, the rest unsent.
    const stuck = link.createStream('stuck', 400_000);
    const writing = stuck.writeAll(new Uint8Array(400_000));
    link.client.getStream(stuck.id).terminate();
    assert.strictEqual(await writing, false);
    assert.strictEqual(stuck.error.code, 499);
    // A writer that sent everything is not told: there was nothing left to stop.
    const done = link.createStream('done', 1);
    done.write(Uint8Array.of(1));
    done.end();
    link.client.getStream(done.id).terminate();
    assert.deepStrictEqual([done.closed, done.error], [false, null]);
    // The socket goes: every writer is told and takes no more, every reader ends, a new stream is refused.
    const open = link.createStream('open', 10);
    const waiting = read(link.client.getStream(open.id));
    let closed = 0;
    open.once('close', () => closed++);
    link.disconnect();
    link.disconnect();
    assert.strictEqual(open.closed, true);
    assert.strictEqual(closed, 1);
    assert.strictEqual(open.write(Uint8Array.of(1)), false);
    assert.deepStrictEqual(await waiting, []);
    assert.throws(() => link.createStream('late', 1), { code: 503 });
    await link.reconnect();
    assert.strictEqual(link.createStream('again', 1).closed, false);

    // maxMessage: a call or a chunk past it closes the socket, as an engine does with a message too big.
    const narrow = new MemoryLink(unit, { streams: true, maxMessage: 100 });
    assert.deepStrictEqual(await narrow.call('test/echo', { text: 'short' }), { size: 5 });
    const chunked = narrow.createStream('chunks', 300);
    assert.strictEqual(chunked.write(new Uint8Array(100)), true);
    assert.strictEqual(chunked.write(new Uint8Array(101)), false);
    assert.strictEqual(narrow.down, true);
    assert.strictEqual(chunked.closed, true);
    await narrow.reconnect();
    await assert.rejects(narrow.call('test/echo', { text: 'x'.repeat(200) }), { code: 503 });
    assert.strictEqual(narrow.down, true);
    // A call the socket went under: neither its answer nor its refusal arrives.
    const slow = {
      echo: {
        handler: async (context, args) => {
          await sleep(10);
          if (args.fail) throw Object.assign(new Error('refused'), { code: 400 });
          return {};
        },
      },
    };
    for (const fail of [false, true]) {
      const cutOff = new MemoryLink(slow);
      const call = cutOff.call('test/echo', { fail });
      cutOff.disconnect();
      await assert.rejects(call, { code: 503 });
    }
    await assert.rejects(new MemoryLink(slow).call('test/echo', { fail: true }), { code: 400 });
  });

  it('should close the database with withDatabase() after fn, whatever fn does; prng() is deterministic', async () => {
    const engine = memoryEngine();
    const open = () => createDatabase({ engine, path: 'solo', lock: false, logger: false });
    let kept = null;
    const n = await withDatabase(open, async (db) => {
      kept = db;
      await db.insert({ n: 1 });
      return (await db.list()).length;
    });
    assert.strictEqual(n, 1);
    await assert.rejects(() => kept.insert({ n: 2 }), { code: 'ALX_ERR_CLOSED' });
    const opened = await open();
    await assert.rejects(
      () =>
        withDatabase(opened, () => {
          throw new Error('inside');
        }),
      { message: 'inside' },
    );
    await assert.rejects(() => opened.insert({ n: 2 }), { code: 'ALX_ERR_CLOSED' }, 'closed although fn threw');
    const first = prng(42);
    const second = prng(42);
    const a = [first(), first(), first()];
    const b = [second(), second(), second()];
    assert.deepStrictEqual(a, b);
    assert.ok(a.every((x) => x >= 0 && x < 1));
  });
});

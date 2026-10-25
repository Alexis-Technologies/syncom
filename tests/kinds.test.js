'use strict';

// The plugin registry: a kind this storage was not opened with is refused
// locally with PLUGIN_MISSING naming the subpath, a peer's op of it is
// refused as `reason: 'kind'` — logged and relayed, so a core-only hub
// between two text nodes still carries the text — and a snapshot block of
// it is left out; a fork runs the parent's plugins; node.json remembers the
// kinds a directory ran with.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../index.js');
const all = require('../src/all/all.js');
const { text } = require('../src/text/text.js');
const { tree } = require('../src/tree/tree.js');
const { createPlugins, missing } = require('../src/plugin.js');
const { branch } = require('../src/branch/branch.js');
const { createMesh, settle, waitUntil } = require('./utils/mesh.js');
const { memory } = require('../src/memory/memory.js');

const fsi = memory();
let n = 0;
const openLean = (options = {}) => core.open({ path: `kinds-${n++}`, fsi, logger: false, ...options });

test('createPlugins refuses what a module gets wrong, and names it', () => {
  const module_ = (over) => ({ name: 'x', kinds: { blob: 9 }, codes: { b: 'blob' }, types: ['splice'], ...over });
  assert.throws(() => createPlugins('text'), /plugins must be an array/);
  assert.throws(() => createPlugins([{}]), /not a plugin module/);
  assert.throws(() => createPlugins([text, text]), /given twice/);
  assert.throws(() => createPlugins([module_({ kinds: { blob: 2 } })]), /rank of 3 or more/);
  assert.throws(() => createPlugins([text, module_({ kinds: { text: 9 } })]), /already registered/);
  assert.throws(() => createPlugins([text, module_({ kinds: { blob: 3 } })]), /rank 3 of blob is taken/);
  assert.throws(() => createPlugins([text, module_({ codes: { t: 'blob' } })]), /block code 't' is taken/);
  assert.throws(() => createPlugins([module_({ codes: { b: 'other' } })]), /names no kind of its own/);
  assert.throws(() => createPlugins([module_({ types: ['embed'] })]), /not an op type of the protocol/);
  assert.throws(() => createPlugins([text, module_({ types: ['splice'] })]), /claimed twice/);
  assert.throws(() => createPlugins([module_({ requires: ['tree'] })]), /needs 'tree' registered before it/);
  const registry = createPlugins([text, tree]);
  assert.deepStrictEqual(registry.names, ['text', 'tree']);
  assert.deepStrictEqual(registry.rank, { register: 0, counter: 1, set: 2, list: 3, text: 4, tree: 5 });
  assert.strictEqual(registry.byType.splice, text);
  assert.strictEqual(registry.byCode.tree, tree);
  assert.strictEqual(Object.isFrozen(registry), true);
  const error = missing('splice()');
  assert.strictEqual(error.code, 'PLUGIN_MISSING');
  assert.match(
    error.message,
    /splice\(\) needs the text plugin: open\({ plugins: \[text\] }\) from '@alexify\/syncom\/text'/,
  );
});

test('a method of a plugin the storage was not opened with rejects with PLUGIN_MISSING', async (t) => {
  const storage = await openLean();
  t.after(() => storage.close());
  assert.deepStrictEqual([storage.plugins, storage.kinds], [[], []]);
  const id = await storage.insert({ title: 'x' });
  for (const [call, home] of [
    [() => storage.splice(id, 'body', 0, 0, 'hi'), 'text'],
    [() => storage.push(id, 'items', [1]), 'text'],
    [() => storage.updateText(id, 'body', 'hi'), 'text'],
    [() => storage.mark(id, 'body', 0, 1, 'b', true), 'text'],
    [() => storage.spans(id, 'body'), 'text'],
    [() => storage.cursor(id, 'body', 0), 'text'],
    [() => storage.treeMove(id, 'outline', 'n'), 'tree'],
    [() => storage.treeRemove(id, 'outline', 'n'), 'tree'],
  ]) {
    await assert.rejects(call, (error) => {
      assert.strictEqual(error.code, 'PLUGIN_MISSING');
      assert.match(error.message, new RegExp(`@alexify/syncom/${home}`));
      return true;
    });
  }
  // A live Record delegates to the same stubs.
  const record = await storage.record(id);
  await assert.rejects(() => record.splice('body', 0, 0, 'x'), { code: 'PLUGIN_MISSING' });
  // A patch of a plugin's action realizes nothing without the plugin.
  await assert.rejects(
    () => storage.applyPatches(id, [{ action: 'splice', field: 'body', index: 0, count: 0, content: 'x' }]),
    {
      code: 'PLUGIN_MISSING',
    },
  );
  await assert.rejects(() => storage.applyPatches(id, [{ action: 'treeMove', field: 'o', node: 'n', parent: null }]), {
    code: 'PLUGIN_MISSING',
  });
  // The registers, counters and sets of the core are there as ever.
  await storage.inc(id, 'hits', 2);
  await storage.add(id, 'tags', ['a']);
  assert.deepStrictEqual(await storage.get(id), { title: 'x', hits: 2, tags: ['a'] });
});

test('open({ plugins }) picks the kinds; the /all entry has every shipped one', async (t) => {
  const withText = await openLean({ plugins: [text] });
  t.after(() => withText.close());
  assert.deepStrictEqual([withText.plugins, withText.kinds], [['text'], ['text']]);
  const id = await withText.insert({});
  await withText.splice(id, 'body', 0, 0, 'hello');
  await withText.push(id, 'items', [1, 2]);
  assert.deepStrictEqual(await withText.get(id), { body: 'hello', items: [1, 2] });
  await assert.rejects(() => withText.treeMove(id, 'outline', 'n'), { code: 'PLUGIN_MISSING' });
  const everything = await all.open({ path: `kinds-${n++}`, fsi, logger: false });
  t.after(() => everything.close());
  assert.deepStrictEqual(everything.kinds, ['text', 'tree']);
  assert.deepStrictEqual(all.PLUGINS, [text, tree, all.signing, all.chain, all.encryption]);
  assert.deepStrictEqual(everything.plugins, ['text', 'tree', 'signing', 'chain', 'encryption']);
  const other = await everything.insert({});
  await everything.treeMove(other, 'outline', 'r');
  assert.deepStrictEqual(await everything.get(other), { outline: [{ id: 'r', children: [] }] });
  // Giving a shipped plugin again is giving it once.
  const twice = await all.open({ path: `kinds-${n++}`, fsi, logger: false, plugins: [text] });
  t.after(() => twice.close());
  assert.deepStrictEqual(twice.kinds, ['text', 'tree']);
});

test('the core alone folds a plugin op as a refusal of its kind, and drops its block from a peer meta', () => {
  const splice = {
    origin: 'A',
    seq: 1,
    ts: 1,
    type: 'splice',
    id: 'r',
    key: 'body',
    value: { at: '^', content: 'ab' },
  };
  const lean = core.applyOp(null, splice);
  assert.deepStrictEqual(lean.rejected, [{ field: 'body', reason: 'kind', kind: 'text' }]);
  assert.strictEqual(lean.changed, false);
  const full = all.applyOp(null, splice);
  assert.deepStrictEqual([full.rejected, full.entry.data.body], [[], 'ab']);
  // The same through the limits: the registry rides on them.
  const registry = createPlugins([text]);
  assert.strictEqual(core.applyOp(null, splice, { plugins: registry }).entry.data.body, 'ab');
  const merge = { origin: 'B', seq: 1, ts: 5, type: 'merge', id: 'r', data: full.entry.data, meta: full.entry.meta };
  const joined = core.applyOp(null, merge);
  assert.deepStrictEqual(joined.rejected, [{ field: 'body', reason: 'kind', kind: 't' }]);
  assert.deepStrictEqual(joined.entry.data, {});
  assert.deepStrictEqual(all.applyOp(null, merge).entry.data, { body: 'ab' });
  assert.deepStrictEqual(core.mergeEntry(full.entry, null, { plugins: registry }).data, { body: 'ab' });
});

test('a core-only hub between two text nodes logs and relays the text it cannot hold', async (t) => {
  // A dials B, C dials B: B is the hub, opened without the text kind.
  const createStorage = async (t2, name, options) => {
    const plugins = name === 'B' ? [] : [text];
    const storage = await core.open({ path: `hub-${name}-${n++}`, fsi, logger: false, plugins, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  };
  const mesh = await createMesh(
    t,
    ['A', 'B', 'C'],
    [
      ['A', 'B'],
      ['C', 'B'],
    ],
    createStorage,
  );
  const a = mesh.get('A');
  const b = mesh.get('B');
  const c = mesh.get('C');
  const refused = [];
  b.on('error', (error) => refused.push(error));
  const id = await a.insert({ title: 'doc' });
  await a.splice(id, 'body', 0, 0, 'hello');
  await settle([a, b, c]);
  // The hub refused the splice as a kind it lacks — and relayed it.
  assert.ok(
    refused.some((e) => e.code === 'OP_REFUSED' && e.rejected?.[0]?.reason === 'kind'),
    'OP_REFUSED{kind} at the hub',
  );
  assert.deepStrictEqual(await b.get(id), { title: 'doc' }, 'the hub holds the record without the text');
  assert.deepStrictEqual(await c.get(id), { title: 'doc', body: 'hello' }, 'the text reaches the far node');
  // The hub's log holds the op for the peers behind it.
  assert.ok(
    b.log.entriesOf(id).some((entry) => entry.op.type === 'splice'),
    'the splice is in the hub log',
  );
  // A snapshot of the hub lacks the field: a peer must not bootstrap the text from it.
  const page = await b.snapshot();
  const record = page.records.find((r) => r.id === id);
  assert.strictEqual(record.meta.blocks.body, undefined);
});

test('a node does not bootstrap from a host that cannot hold one of its kinds: KINDS_MISMATCH', async (t) => {
  // The host A runs the core alone and compacts; B, with the text kind, must
  // bootstrap to catch up — and refuses to, since a snapshot of A would lack
  // every text field and the adopted vector would hide the ops behind them.
  const createStorage = async (t2, name, options) => {
    const plugins = name === 'A' ? [] : [text];
    const storage = await core.open({ path: `mismatch-${name}-${n++}`, fsi, logger: false, plugins, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  };
  const options = { sync: { log: { rollAfter: 2 }, retention: { ops: 4 } } };
  const mesh = await createMesh(t, ['A', 'B'], [], createStorage, options);
  const a = mesh.get('A');
  const id = await a.insert({ n: 0 });
  for (let i = 0; i < 12; i++) await a.inc(id, 'hits', 1);
  assert.ok(a.log.floor > 1, 'history was compacted');
  const b = mesh.get('B');
  const errors = [];
  b.sync.on('error', (error) => errors.push(error));
  const events = [];
  b.sync.on('bootstrap', (event) => events.push(event));
  await b.sync.addNode({ url: 'mem://A' });
  // The vectors never meet (that is the point), so this waits for the report, then a beat for anything that would follow it.
  await waitUntil(() => errors.some((error) => error.code === 'KINDS_MISMATCH'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const mismatch = errors.find((error) => error.code === 'KINDS_MISMATCH');
  assert.ok(mismatch, 'KINDS_MISMATCH is reported on the dialing side');
  assert.deepStrictEqual(mismatch.missing, ['text']);
  assert.strictEqual(mismatch.url, 'mem://A');
  assert.strictEqual(events.length, 0, 'nothing was bootstrapped');
  assert.strictEqual(await b.get(id), null, 'and nothing of the host came over');
});

test('a fork runs the parent plugins; node.json remembers the kinds a directory ran with', async (t) => {
  const parent = await openLean({ plugins: [text], sync: { autoStart: false } });
  t.after(() => parent.close().catch(() => {}));
  const id = await parent.insert({});
  await parent.splice(id, 'body', 0, 0, 'abc');
  const fork = await branch(parent, { path: `kinds-fork-${n++}` });
  t.after(() => fork.close().catch(() => {}));
  assert.deepStrictEqual(fork.kinds, ['text']);
  assert.deepStrictEqual(await fork.get(id), { body: 'abc' });
  await fork.splice(id, 'body', 3, 0, 'd');
  assert.deepStrictEqual(await fork.get(id), { body: 'abcd' });
  // The directory remembers: a reopen without the kind is refused, with more kinds is fine.
  const path = `kinds-${n++}`;
  const first = await core.open({ path, fsi, logger: false, plugins: [text] });
  await first.close();
  assert.deepStrictEqual(JSON.parse(fsi.dump()[`${path}/node.json`]).plugins, ['text']);
  await assert.rejects(() => core.open({ path, fsi, logger: false }), { code: 'PLUGIN_MISSING' });
  const more = await core.open({ path, fsi, logger: false, plugins: [text, tree] });
  assert.deepStrictEqual(more.kinds, ['text', 'tree']);
  await more.close();
  assert.deepStrictEqual(JSON.parse(fsi.dump()[`${path}/node.json`]).plugins, ['text', 'tree']);
});

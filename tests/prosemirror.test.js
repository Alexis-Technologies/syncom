'use strict';

// The ProseMirror adapter (src/prosemirror/prosemirror.js) over real
// prosemirror-* modules (devDependencies; skipped without them) and a view
// that is its state and a dispatch — no DOM (PM-1).

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { createUndo } = require('../src/undo/undo.js');
const { createPresence } = require('../src/presence/presence.js');
const { createMesh, settle, waitUntil, prng } = require('./utils/mesh.js');

const load = () => {
  try {
    return {
      model: require('prosemirror-model'),
      state: require('prosemirror-state'),
      transform: require('prosemirror-transform'),
      view: require('prosemirror-view'),
      basic: require('prosemirror-schema-basic'),
      list: require('prosemirror-schema-list'),
    };
  } catch {
    return null;
  }
};
const pm = load();
const skip = pm === null ? 'prosemirror-* is not installed' : false;
const PM = require('../src/prosemirror/prosemirror.js');

const schemaOf = () =>
  new pm.model.Schema({
    nodes: pm.list.addListNodes(pm.basic.schema.spec.nodes, 'paragraph block*', 'block'),
    marks: pm.basic.schema.spec.marks,
  });

// What an EditorView is to the adapter: its state, and a dispatch that applies at once.
const viewOf = (schema, plugins) => ({
  state: pm.state.EditorState.create({ schema, plugins }),
  dispatch(tr) {
    this.state = this.state.apply(tr);
  },
});

const open = async (t, name, options = {}) => {
  const storage = await syncom.open({ path: `/${name}`, fsi: memory(), logger: false, defer: 0, ...options });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

// Where the text `word` starts in the document, plus `offset`.
const posOf = (doc, word, offset = 0) => {
  let at = null;
  doc.descendants((node, pos) => {
    if (at === null && node.isText && node.text.includes(word)) at = pos + node.text.indexOf(word) + offset;
  });
  return at;
};

// A random edit as a user makes one: typing, deleting, Enter, a mark, a list.
const randomEdit = (view, random, tag) => {
  const { state } = view;
  const positions = [];
  state.doc.descendants((node, pos) => {
    if (node.isTextblock) for (let i = 0; i <= node.content.size; i++) positions.push(pos + 1 + i);
  });
  const at = positions[Math.floor(random() * positions.length)];
  const roll = random();
  const tr = state.tr;
  if (roll < 0.45) tr.insertText(`${tag}${Math.floor(random() * 10)}`, at);
  else if (roll < 0.65) {
    const end = Math.min(at + 1 + Math.floor(random() * 3), state.doc.resolve(at).end());
    if (end > at) tr.delete(at, end);
  } else if (roll < 0.75) tr.split(at);
  else if (roll < 0.9) {
    const end = Math.min(at + 2, state.doc.resolve(at).end());
    if (end > at) tr.addMark(at, end, state.schema.marks.strong.create());
  } else {
    const $at = state.doc.resolve(at);
    const range = $at.blockRange();
    const wrapping = range && pm.transform.findWrapping(range, state.schema.nodes.bullet_list);
    if (wrapping) tr.wrap(range, wrapping);
  }
  if (tr.docChanged) view.dispatch(tr);
};

test('ProseMirror', { skip }, async (t) => {
  await t.test('a document is one text with block markers, and reads back as the same document', async () => {
    const schema = schemaOf();
    const { strong, link } = schema.marks;
    const doc = schema.node('doc', null, [
      schema.node('heading', { level: 2 }, [schema.text('Title')]),
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('one')]),
          schema.node('paragraph', null, [schema.text('and more')]),
        ]),
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('two', [strong.create()])]),
          schema.node('ordered_list', { order: 3 }, [
            schema.node('list_item', null, [schema.node('paragraph', null, [schema.text('nested')])]),
          ]),
        ]),
      ]),
      schema.node('horizontal_rule'),
      schema.node('paragraph', null, [
        schema.text('a link', [link.create({ href: 'https://example.com' })]),
        schema.node('hard_break'),
        schema.node('image', { src: 'a.png' }),
      ]),
    ]);
    const spans = PM.docToSpans(doc);
    assert.ok(PM.spansToDoc(spans, schema).eq(doc), 'the same document');
    assert.deepStrictEqual(spans.slice(0, 4), [
      { type: 'block', value: { type: 'heading', parents: [], attrs: { level: 2 }, isEmbed: false } },
      { type: 'text', text: 'Title', marks: {} },
      { type: 'block', value: { type: 'bullet_list', parents: [], attrs: {}, isEmbed: false } },
      { type: 'block', value: { type: 'list_item', parents: ['bullet_list'], attrs: {}, isEmbed: false } },
    ]);
    // Positions and text indices agree inside every textblock.
    const at = posOf(doc, 'nested', 3);
    assert.strictEqual(PM.posOfIndex(doc, PM.indexOfPos(doc, at)), at);
    assert.strictEqual(PM.indexOfPos(doc, 0), 1, 'a position before the first textblock reads as its start');
    assert.strictEqual(PM.posOfIndex(doc, 10_000), doc.content.size - 1, 'past the end: the last textblock’s end');
    // Text outside a textblock is wrapped in the schema's default; a parent not open is opened; the unknown left out.
    const loose = PM.spansToDoc(
      [
        { type: 'text', text: 'loose', marks: { strong: true, nope: true } },
        { type: 'block', value: { type: 'paragraph', parents: ['blockquote'], attrs: {}, isEmbed: false } },
        { type: 'text', text: 'quoted', marks: {} },
        { type: 'block', value: { type: 'mystery', parents: [], attrs: {}, isEmbed: false } },
        { type: 'embed', value: { type: 'mystery', parents: [], attrs: {}, isEmbed: true }, marks: {} },
        { type: 'embed', value: { type: 'image', parents: [], attrs: {}, isEmbed: true }, marks: {} },
        { type: 'text', text: 'after', marks: { link: { nope: 1 } } },
      ],
      schema,
    );
    assert.deepStrictEqual(loose.toJSON(), {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'loose', marks: [{ type: 'strong' }] }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
      ],
    });
    assert.ok(PM.spansToDoc([], schema).eq(schema.topNodeType.createAndFill()));
  });

  await t.test(
    'two editors on two nodes stay the same as the field through typing, Enter, marks and lists',
    async (t2) => {
      const schema = schemaOf();
      const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], open);
      const [sa, sb] = ['A', 'B'].map((name) => mesh.get(name));
      const id = await sa.insert({ title: 'doc' });
      await settle([sa, sb]);
      const a = PM.createProseMirror(sa, id, 'body', pm);
      const b = PM.createProseMirror(sb, id, 'body', pm);
      const va = viewOf(schema, [a.plugin]);
      const vb = viewOf(schema, [b.plugin]);
      t2.after(() => a.stop());
      t2.after(() => b.stop());
      await Promise.all([a.attach(va).ready, b.attach(vb).ready]);
      assert.strictEqual(a.binding.source, a.source);
      const same = async () => {
        const doc = PM.spansToDoc(await sa.spans(id, 'body'), schema);
        return (
          doc.eq(va.state.doc) && doc.eq(vb.state.doc) && doc.eq(PM.spansToDoc(await sb.spans(id, 'body'), schema))
        );
      };
      for (const seed of [1, 2, 3, 4]) {
        const random = prng(seed);
        for (let i = 0; i < 40; i++) {
          randomEdit(random() < 0.5 ? va : vb, random, random() < 0.5 ? 'a' : 'b');
          if (random() < 0.3) await tick();
        }
        await Promise.all([a.binding.flush(), b.binding.flush()]);
        await settle([sa, sb]);
        await waitUntil(same);
      }
      // A caret moves with a peer's insert before it, and stays before one at it. The field's
      // indices go through what the field lacks of the document: it fits with the next edit.
      const at = posOf(va.state.doc, 'a', 0) ?? 1;
      va.dispatch(va.state.tr.setSelection(pm.state.TextSelection.create(va.state.doc, at)));
      const index = a.indexOf(at);
      await sb.splice(id, 'body', index - 1, 0, 'xyz');
      await sb.splice(id, 'body', index + 3, 0, 'Q');
      await settle([sa, sb]);
      await waitUntil(() => va.state.doc.textContent.includes('Q'));
      assert.strictEqual(a.indexOf(va.state.selection.head), index + 3);
      assert.strictEqual(a.posOf(index + 3), va.state.selection.head);
      assert.throws(() => a.attach(va), TypeError, 'once');
      assert.throws(() => PM.createProseMirror(sa, id, 'body', {}), TypeError);
      const c = PM.createProseMirror(sa, id, 'body', pm);
      assert.throws(() => c.attach({}), TypeError);
      assert.throws(() => c.attach(viewOf(schema, [])), TypeError, 'a state without the plugin');
    },
  );

  await t.test(
    'a peer’s change is never answered with an edit: editors over a field the schema cannot hold stay quiet until they edit',
    async (t2) => {
      const schema = schemaOf();
      const mesh = await createMesh(
        t2,
        ['A', 'B', 'C'],
        [
          ['A', 'B'],
          ['B', 'C'],
          ['A', 'C'],
        ],
        open,
      );
      const [sa, sb, sc] = ['A', 'B', 'C'].map((name) => mesh.get(name));
      const id = await sc.insert({ title: 'doc' });
      await settle([sa, sb, sc]);
      const a = PM.createProseMirror(sa, id, 'body', pm);
      const b = PM.createProseMirror(sb, id, 'body', pm);
      const va = viewOf(schema, [a.plugin]);
      const vb = viewOf(schema, [b.plugin]);
      t2.after(() => a.stop());
      t2.after(() => b.stop());
      await Promise.all([a.attach(va).ready, b.attach(vb).ready]);
      const own = () => [sa.vector[sa.nodeId] ?? 0, sb.vector[sb.nodeId] ?? 0];
      const quiet = own();
      // A node with no editor writes what neither schema holds: text in no block, an item in no list.
      await sc.updateText(id, 'body', 'loose');
      await sc.splitBlock(id, 'body', 5, { type: 'list_item', parents: ['bullet_list'], attrs: {} });
      await sc.splice(id, 'body', 6, 0, 'item');
      await settle([sa, sb, sc]);
      const read = async () => PM.spansToDoc(await sc.spans(id, 'body'), schema);
      await waitUntil(async () => (await read()).eq(va.state.doc) && (await read()).eq(vb.state.doc));
      for (let i = 0; i < 5; i++) await tick();
      await settle([sa, sb, sc]);
      assert.deepStrictEqual(own(), quiet, 'neither editor answered with an edit');
      assert.strictEqual(va.state.doc.childCount, 2, 'a paragraph and a list');
      // Both edit at once: each edit carries what the field lacked, and then all is quiet.
      va.dispatch(va.state.tr.insertText('A', 1));
      vb.dispatch(vb.state.tr.insertText('B', vb.state.doc.content.size - 3));
      await Promise.all([a.binding.flush(), b.binding.flush()]);
      await settle([sa, sb, sc]);
      await waitUntil(async () => (await read()).eq(va.state.doc) && (await read()).eq(vb.state.doc));
      const after = own();
      assert.ok(after[0] > quiet[0] && after[1] > quiet[1], 'each sent its edit');
      for (let i = 0; i < 5; i++) await tick();
      await settle([sa, sb, sc]);
      assert.deepStrictEqual(own(), after, 'nothing answered the edits');
      assert.ok(va.state.doc.textContent.includes('A') && va.state.doc.textContent.includes('B'));
    },
  );

  await t.test(
    'a field the schema cannot hold reads as the schema has it, says so, and fits with the editor’s next edit',
    async (t2) => {
      const schema = schemaOf();
      const storage = await open(t2, 'fit');
      const id = await storage.insert({});
      await storage.updateText(id, 'body', 'plain text, no block');
      const unfit = [];
      const pmb = PM.createProseMirror(storage, id, 'body', pm, { onUnfit: (delta) => unfit.push(delta) });
      assert.throws(() => pmb.indexOf(1), { name: 'TypeError', message: 'indexOf(): attach() first' });
      assert.throws(() => pmb.posOf(0), { name: 'TypeError', message: 'posOf(): attach() first' });
      const view = viewOf(schema, [pmb.plugin]);
      t2.after(() => pmb.stop());
      const written = storage.vector[storage.nodeId];
      await pmb.attach(view).ready;
      await pmb.binding.flush();
      assert.strictEqual(storage.vector[storage.nodeId], written, 'opening the editor writes nothing');
      assert.strictEqual(unfit.length, 1, 'what the schema cannot hold is said');
      assert.ok(unfit[0].length > 0);
      assert.strictEqual(view.state.doc.textContent, 'plain text, no block');
      assert.deepStrictEqual((await storage.spans(id, 'body'))[0].type, 'text', 'the field as it was');
      // Position 1 is the default paragraph's start: index 1 of the document, index 0 of the field.
      assert.strictEqual(PM.indexOfPos(view.state.doc, 1), 1);
      assert.strictEqual(pmb.indexOf(1), 0);
      assert.strictEqual(pmb.posOf(0), 1);
      assert.strictEqual(pmb.posOf(5), 6);
      // The next edit carries the paragraph the field lacked.
      view.dispatch(view.state.tr.insertText('!', view.state.doc.content.size - 1));
      await pmb.binding.flush();
      const spans = await storage.spans(id, 'body');
      assert.deepStrictEqual(spans[0].value.type, 'paragraph', 'the default textblock laid in the field');
      assert.ok(PM.spansToDoc(spans, schema).eq(view.state.doc));
      assert.strictEqual(view.state.doc.textContent, 'plain text, no block!');
      assert.strictEqual(pmb.indexOf(1), 1, 'fitted: the indices agree');
      // A reset: the field written whole reloads the editor.
      await storage.set(id, {});
      await waitUntil(() => view.state.doc.eq(schema.topNodeType.createAndFill()));
    },
  );

  await t.test(
    'undo and redo are the storage’s commands; a presence room’s cursors are decorations and this editor’s selection is published',
    async (t2) => {
      const schema = schemaOf();
      const storage = await open(t2, 'undo');
      const id = await storage.insert({});
      const pmb = PM.createProseMirror(storage, id, 'body', pm);
      const manager = createUndo(storage, { trackedSources: [pmb.source], records: [id], mergeInterval: 0 });
      t2.after(() => manager.destroy?.());
      const { undo, redo } = pmb.commands(manager);
      const presence = createPresence(storage, { timeout: 5000 });
      t2.after(() => presence.destroy());
      const cursors = pmb.cursorPlugin(presence, { render: () => null });
      const view = viewOf(schema, [pmb.plugin, cursors]);
      t2.after(() => pmb.stop());
      await pmb.attach(view).ready;
      // The cursor plugin's view, as an EditorView would run it.
      const plugged = cursors.spec.view(view);
      t2.after(() => plugged.destroy());
      const typed = (text) => {
        const before = view.state;
        view.dispatch(view.state.tr.insertText(text, view.state.doc.content.size - 1));
        plugged.update(view, before);
      };
      typed('hello');
      await pmb.binding.flush();
      typed(' world');
      await pmb.binding.flush();
      assert.strictEqual(view.state.doc.textContent, 'hello world');
      assert.strictEqual(undo(view.state), true, 'can');
      undo(view.state, view.dispatch.bind(view));
      await waitUntil(() => view.state.doc.textContent === 'hello');
      redo(view.state, view.dispatch.bind(view));
      await waitUntil(() => view.state.doc.textContent === 'hello world');
      assert.strictEqual(redo(view.state), false, 'nothing to redo');
      // This editor's selection reached the room as tokens.
      await waitUntil(() => presence.local?.cursor !== undefined);
      assert.strictEqual(presence.local.cursor.field, 'body');
      // Another node's cursor, over a range: a caret and a highlight.
      // Index 0 is the paragraph's marker: `hello` is indices 1 to 6, positions 1 to 6.
      const tokens = {
        id,
        field: 'body',
        anchor: await storage.cursor(id, 'body', 1),
        head: await storage.cursor(id, 'body', 6),
      };
      await presence.apply({ p: 1, scope: '*', s: [['other', 1, Date.now(), { cursor: tokens }]] });
      await waitUntil(() => cursors.getState(view.state).find().length === 2);
      const [first, second] = cursors.getState(view.state).find();
      assert.deepStrictEqual(
        [first.from, second.to].sort((x, y) => x - y),
        [1, 6],
      );
      assert.throws(() => pmb.commands({}), TypeError);
      assert.throws(
        () => PM.createProseMirror(storage, id, 'body', { ...pm, view: undefined }).cursorPlugin(presence),
        TypeError,
      );
    },
  );
});

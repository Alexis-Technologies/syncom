'use strict';

// The CodeMirror adapter (src/codemirror/codemirror.js) over real
// @codemirror/* modules (devDependencies; skipped without them) and a view
// that is its state and a dispatch — no DOM (CM-1).

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { createUndo } = require('../src/undo/undo.js');
const { createPresence } = require('../src/presence/presence.js');
const { createMesh, settle, waitUntil, prng } = require('./utils/mesh.js');

const load = () => {
  try {
    return { state: require('@codemirror/state'), view: require('@codemirror/view') };
  } catch {
    return null;
  }
};
const cm = load();
const skip = cm === null ? '@codemirror/* is not installed' : false;
const CM = require('../src/codemirror/codemirror.js');

// What an EditorView is to the adapter: its state, and a dispatch that applies at once.
const viewOf = (extensions) => ({
  state: cm.state.EditorState.create({ doc: '', extensions }),
  dispatch(...specs) {
    this.state = this.state.update(...specs).state;
  },
});

const open = async (t, name, options = {}) => {
  const storage = await syncom.open({ path: `/${name}`, fsi: memory(), logger: false, defer: 0, ...options });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

// A random edit as a user makes one: one or more ranges replaced at once.
const randomEdit = (view, random, tag) => {
  const length = view.state.doc.length;
  const changes = [];
  let at = 0;
  for (let i = 0; i < 1 + Math.floor(random() * 3) && at <= length; i++) {
    const from = at + Math.floor(random() * (length - at + 1));
    const to = Math.min(length, from + Math.floor(random() * 3));
    const insert = random() < 0.7 ? `${tag}${Math.floor(random() * 10)}` : random() < 0.5 ? '\n' : '';
    changes.push({ from, to, insert });
    at = to + 1;
  }
  view.dispatch({ changes, selection: { anchor: Math.min(changes[0].from, length) } });
};

test('CodeMirror', { skip }, async (t) => {
  await t.test('a ChangeSet reads as a delta over the document before it, and a delta as changes again', () => {
    const state = cm.state.EditorState.create({ doc: 'hello world' });
    const tr = state.update({
      changes: [
        { from: 1, to: 3 },
        { from: 6, insert: 'big ' },
        { from: 11, insert: '!' },
      ],
    });
    const delta = CM.deltaOfChanges(tr.changes);
    assert.deepStrictEqual(delta, [
      { retain: 1 },
      { delete: 2 },
      { retain: 3 },
      { insert: 'big ' },
      { retain: 5 },
      { insert: '!' },
    ]);
    const back = state.update({ changes: CM.changesOfDelta(delta) }).state.doc.toString();
    assert.deepStrictEqual([back, tr.newDoc.toString()], ['hlo big world!', 'hlo big world!']);
    assert.deepStrictEqual(CM.changesOfDelta([{ retain: 1 }, { insert: { embed: null } }]), [{ from: 1, insert: '￼' }]);
  });

  await t.test(
    'two editors on two nodes stay the same as the field through edits of several ranges at once',
    async (t2) => {
      const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], open);
      const [sa, sb] = ['A', 'B'].map((name) => mesh.get(name));
      const id = await sa.insert({});
      await sa.updateText(id, 'body', 'line one\r\nline two');
      await settle([sa, sb]);
      const a = CM.createCodeMirror(sa, id, 'body', cm);
      const b = CM.createCodeMirror(sb, id, 'body', cm);
      const va = viewOf([a.extension]);
      const vb = viewOf([b.extension]);
      t2.after(() => a.stop());
      t2.after(() => b.stop());
      await Promise.all([a.attach(va).ready, b.attach(vb).ready]);
      await Promise.all([a.binding.flush(), b.binding.flush()]);
      await settle([sa, sb]);
      // CodeMirror reads `\r\n` as a line break: the field comes to hold what the editors show.
      await waitUntil(
        async () =>
          (await sa.get(id)).body === 'line one\nline two' && vb.state.doc.toString() === 'line one\nline two',
      );
      const same = async () => {
        const text = (await sa.get(id)).body;
        return text === (await sb.get(id)).body && va.state.doc.toString() === text && vb.state.doc.toString() === text;
      };
      for (const seed of [1, 2, 3, 4]) {
        const random = prng(seed);
        for (let i = 0; i < 50; i++) {
          randomEdit(random() < 0.5 ? va : vb, random, random() < 0.5 ? 'a' : 'b');
          if (random() < 0.3) await tick();
        }
        await Promise.all([a.binding.flush(), b.binding.flush()]);
        await settle([sa, sb]);
        await waitUntil(same);
      }
      // A peer's insert before the caret moves it; the editor's own history holds none of it.
      va.dispatch({ selection: { anchor: 4 } });
      await sb.splice(id, 'body', 0, 0, 'xyz');
      await settle([sa, sb]);
      await waitUntil(() => va.state.doc.toString().startsWith('xyz'));
      assert.strictEqual(va.state.selection.main.head, 7);
      assert.throws(() => a.attach(va), TypeError, 'once');
      assert.throws(() => CM.createCodeMirror(sa, id, 'body', {}), TypeError);
      const c = CM.createCodeMirror(sa, id, 'body', cm);
      assert.throws(() => c.attach({}), TypeError);
      assert.throws(() => c.attach(viewOf([])), TypeError, 'a state without the extension');
    },
  );

  await t.test(
    'undo and redo are the storage’s commands; a presence room’s cursors are decorations and this editor’s selection is published',
    async (t2) => {
      const storage = await open(t2, 'undo');
      const id = await storage.insert({});
      const cmb = CM.createCodeMirror(storage, id, 'body', cm);
      const manager = createUndo(storage, { trackedSources: [cmb.source], records: [id], mergeInterval: 0 });
      const { undo, redo, keys } = cmb.commands(manager);
      assert.deepStrictEqual(
        keys.map((key) => key.key),
        ['Mod-z', 'Mod-y'],
      );
      const presence = createPresence(storage, { timeout: 5000 });
      t2.after(() => presence.destroy());
      const cursors = cmb.cursors(presence);
      t2.after(() => cursors.stop());
      const view = viewOf([cmb.extension, cursors.extension]);
      t2.after(() => cmb.stop());
      await cmb.attach(view).ready;
      view.dispatch({ changes: { from: 0, insert: 'hello' } });
      await cmb.binding.flush();
      view.dispatch({ changes: { from: 5, insert: ' world' }, selection: { anchor: 11 } });
      await cmb.binding.flush();
      assert.strictEqual(undo(view), true, 'can');
      await waitUntil(() => view.state.doc.toString() === 'hello');
      redo(view);
      await waitUntil(() => view.state.doc.toString() === 'hello world');
      assert.strictEqual(redo(view), false, 'nothing to redo');
      // This editor's selection reached the room as tokens.
      await waitUntil(() => presence.local?.cursor !== undefined);
      assert.strictEqual(presence.local.cursor.field, 'body');
      // Another node's cursor, over a range: a caret and a highlight.
      const tokens = {
        id,
        field: 'body',
        anchor: await storage.cursor(id, 'body', 0),
        head: await storage.cursor(id, 'body', 5),
      };
      await presence.apply({ p: 1, scope: '*', s: [['other', 1, Date.now(), { cursor: tokens }]] });
      const decorated = () => {
        const found = [];
        for (const provided of view.state.facet(cm.view.EditorView.decorations)) {
          const set = typeof provided === 'function' ? provided(view) : provided;
          set.between(0, view.state.doc.length, (from, to) => void found.push([from, to]));
        }
        return found;
      };
      await waitUntil(() => decorated().length === 2);
      assert.deepStrictEqual(decorated(), [
        [0, 5],
        [5, 5],
      ]);
      assert.throws(() => cmb.commands({}), TypeError);
      assert.throws(() => CM.createCodeMirror(storage, id, 'body', { state: cm.state }).cursors(presence), TypeError);
    },
  );
});

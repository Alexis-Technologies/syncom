// The Editors page (docs/guide/editors.md) shows the regions of this file. The editors run without a DOM: an
// EditorView is, to an adapter, its `state` and a `dispatch` that applies at once, which is what the stand-in
// views below are. docs/examples/editors-browser.mjs shows the same adapters over real EditorViews.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase, memoryEngine } from '@alexify/syncom/all';

const db = await createDatabase({ engine: memoryEngine(), schema: { entities: { Task: {} } } });
const { id } = await db.Task.insert({ title: 'Release notes' });
await db.updateText(id, 'notes', 'Hello');

// #region binding
import { createTextBinding, compose } from '@alexify/syncom/editor';

// A tiny editor: its document is a delta, and it reports its own edits as deltas.
let contents = [];
const listeners = new Set();
const adapter = {
  setContents: (ops) => (contents = compose([], ops)), // the document replaced whole
  updateContents: (delta) => (contents = compose(contents, delta)), // another writer's change
  onChange: (listener) => {
    listeners.add(listener); // the editor's own edits, reported to the binding
    return () => listeners.delete(listener);
  },
};
const typeInEditor = (delta) => {
  contents = compose(contents, delta);
  for (const listener of listeners) listener(delta);
};

const binding = createTextBinding(db, id, 'notes', adapter);
await binding.ready; // the editor holds the field: [ { insert: 'Hello' } ]
typeInEditor([{ retain: 5 }, { insert: ' world' }]); // the user types
await binding.flush(); // logged: the field reads 'Hello world'
await db.splice(id, 'notes', 0, 0, '> '); // another writer...
// ...reaches the editor as a delta: contents is [ { insert: '> Hello world' } ]
binding.stop();
// #endregion binding
assert.equal((await db.Task.get(id)).notes, '> Hello world');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.deepEqual(contents, [{ insert: '> Hello world' }]);

// #region prosemirror
import * as model from 'prosemirror-model';
import * as state from 'prosemirror-state';
import * as transform from 'prosemirror-transform';
import { schema } from 'prosemirror-schema-basic';
import { createProseMirror } from '@alexify/syncom/prosemirror';
import { createUndo } from '@alexify/syncom/undo';

const pm = createProseMirror(db, id, 'body', { model, state, transform });
const view = {
  // in the browser, an EditorView (see below); here, its state and a dispatch
  state: state.EditorState.create({ schema, plugins: [pm.plugin] }),
  dispatch(tr) {
    this.state = this.state.apply(tr);
  },
};
await pm.attach(view).ready;

const undo = createUndo(db, { trackedSources: [pm.source], records: [id] });
const commands = pm.commands(undo); // { undo, redo }: ProseMirror commands over syncom's undo

view.dispatch(view.state.tr.insertText('Shipped on Monday', 1));
await pm.binding.flush();
console.log(await db.blocks(id, 'body'));
// [ { index: 0, type: 'paragraph', parents: [], attrs: {},
//     spans: [ { type: 'text', text: 'Shipped on Monday', marks: {} } ] } ]
// #endregion prosemirror
assert.deepEqual(await db.blocks(id, 'body'), [
  {
    index: 0,
    type: 'paragraph',
    parents: [],
    attrs: {},
    spans: [{ type: 'text', text: 'Shipped on Monday', marks: {} }],
  },
]);
view.dispatch(view.state.tr.insertText('!', view.state.doc.content.size - 1));
await pm.binding.flush();
assert.equal(view.state.doc.textContent, 'Shipped on Monday!');
assert.equal(commands.undo(view.state, view.dispatch), true);
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(view.state.doc.textContent, '', 'the undo took the step back: both edits, within 500 ms of each other');
pm.stop();
undo.stop();

// #region codemirror
import * as cmState from '@codemirror/state';
import { createCodeMirror } from '@alexify/syncom/codemirror';

const cm = createCodeMirror(db, id, 'script', { state: cmState });
const code = {
  state: cmState.EditorState.create({ doc: '', extensions: [cm.extension] }),
  dispatch(...specs) {
    this.state = this.state.update(...specs).state;
  },
};
await cm.attach(code).ready;
code.dispatch({ changes: { from: 0, insert: 'deploy --env=prod\n' } });
await cm.binding.flush();
await db.splice(id, 'script', 0, 0, '# release\n'); // another writer
// code.state.doc reads '# release\ndeploy --env=prod\n'
// #endregion codemirror
assert.equal((await db.Task.get(id)).script, '# release\ndeploy --env=prod\n');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(code.state.doc.toString(), '# release\ndeploy --env=prod\n');
cm.stop();

// #region selection
import { selectionToTokens, tokensToSelection, transformIndex } from '@alexify/syncom/editor';

const tokens = await selectionToTokens(db, id, 'notes', { anchor: 2, head: 7 }); // 'Hello' selected
await db.splice(id, 'notes', 0, 0, 'Oh, '); // edits land around it
console.log(await tokensToSelection(db, tokens)); // { anchor: 6, head: 11 }: still 'Hello'
console.log(transformIndex(3, [{ retain: 3 }, { insert: 'ab' }])); // 5: an index through a delta, at once
// #endregion selection
assert.deepEqual(await tokensToSelection(db, tokens), { anchor: 6, head: 11 });
assert.equal(transformIndex(3, [{ retain: 3 }, { insert: 'ab' }]), 5);
assert.equal(transformIndex(3, [{ retain: 3 }, { insert: 'ab' }], true), 3);

// #region presence
import { createPresence } from '@alexify/syncom/presence';
import { presenceCursors } from '@alexify/syncom/editor';

const presence = createPresence(db); // db.sync.presence(presence) carries it to the peers
await presence.set({ name: 'ada', cursor: tokens });
console.log(await presenceCursors(presence, db, id, 'notes'));
// [ { node: '…', state: { name: 'ada', cursor: { … } }, anchor: 6, head: 11 } ]
// #endregion presence
const cursors = await presenceCursors(presence, db, id, 'notes');
assert.equal(cursors.length, 1);
assert.equal(cursors[0].anchor, 6);
await presence.destroy();

// #region blocks
import { diffBlocks } from '@alexify/syncom/editor';

await db.updateText(id, 'outline', 'Title\nFirst paragraph.');
await db.splitBlock(id, 'outline', 0, { type: 'heading', attrs: { level: 1 } });
await db.splitBlock(id, 'outline', 7, { type: 'paragraph' });

const before = await db.blocks(id, 'outline');
const text = (await db.Task.get(id)).outline; // what the delta is made over
const after = structuredClone(before);
after[0].attrs = { level: 2 }; // the heading becomes a level 2
after[1].spans = [{ type: 'text', text: 'First paragraph, edited.', marks: {} }];
await db.applyDelta(id, 'outline', diffBlocks(before, after), { expect: text });
// #endregion blocks
const blocks = await db.blocks(id, 'outline');
assert.deepEqual(blocks[0].attrs, { level: 2 });
assert.deepEqual(blocks[1].spans, [{ type: 'text', text: 'First paragraph, edited.', marks: {} }]);
await db.close();

// #region converge
import { createMesh, settle } from '@alexify/syncom/testing';

const mesh = await createMesh(['laptop', 'phone'], [['phone', 'laptop']], {
  createStorage: (name, options) => createDatabase({ ...options, engine: memoryEngine() }),
});
const [laptop, phone] = [mesh.get('laptop'), mesh.get('phone')];
const doc = await laptop.insert({ title: 'Pairing' });
await laptop.updateText(doc, 'code', 'run()\n');
await settle(mesh.storages);

const editorOn = async (node) => {
  const binding = createCodeMirror(node, doc, 'code', { state: cmState });
  const view = {
    state: cmState.EditorState.create({ doc: '', extensions: [binding.extension] }),
    dispatch(...specs) {
      this.state = this.state.update(...specs).state;
    },
  };
  await binding.attach(view).ready;
  return { binding, view };
};
const left = await editorOn(laptop);
const right = await editorOn(phone);
left.view.dispatch({ changes: { from: 0, insert: 'setup()\n' } }); // both type at once
right.view.dispatch({ changes: { from: 6, insert: 'check()\n' } });
await Promise.all([left.binding.binding.flush(), right.binding.binding.flush()]);
await settle(mesh.storages);
// both editors read 'setup()\nrun()\ncheck()\n'
// #endregion converge
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(left.view.state.doc.toString(), 'setup()\nrun()\ncheck()\n');
assert.equal(right.view.state.doc.toString(), 'setup()\nrun()\ncheck()\n');
assert.equal((await phone.get(doc)).code, 'setup()\nrun()\ncheck()\n');
left.binding.stop();
right.binding.stop();
await mesh.close();

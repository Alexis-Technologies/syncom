// docs-examples: browser-only (an EditorView and Quill need a DOM; docs/examples/editors.mjs runs the same adapters in Node)
// The Editors page (docs/guide/editors.md) shows the regions of this file.
import { createDatabase } from '@alexify/syncom/all';
import { createPresence } from '@alexify/syncom/presence';

const db = await createDatabase({ path: 'notes', schema: { entities: { Task: {} } } });
const { id } = await db.Task.insert({ title: 'Release notes' });
const presence = createPresence(db);
db.sync.presence(presence);
const element = document.querySelector('#editor');

// #region quill
import Quill from 'quill';
import { createTextBinding } from '@alexify/syncom/editor';

const quill = new Quill(element, { theme: 'snow' });
const binding = createTextBinding(db, id, 'notes', {
  setContents: (ops) => quill.setContents(ops, 'silent'),
  updateContents: (delta) => quill.updateContents(delta, 'silent'),
  onChange: (listener) => {
    const handler = (delta, _old, source) => source === 'user' && listener(delta.ops);
    quill.on('text-change', handler);
    return () => quill.off('text-change', handler);
  },
});
await binding.ready;
// #endregion quill
binding.stop();

// #region prosemirror
import * as model from 'prosemirror-model';
import * as state from 'prosemirror-state';
import * as transform from 'prosemirror-transform';
import * as view from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { schema } from 'prosemirror-schema-basic';
import { createProseMirror } from '@alexify/syncom/prosemirror';
import { createUndo } from '@alexify/syncom/undo';

const pm = createProseMirror(db, id, 'body', { model, state, transform, view });
const undo = createUndo(db, { trackedSources: [pm.source], records: [id] });
const { undo: undoCommand, redo: redoCommand } = pm.commands(undo);

const editor = new view.EditorView(element, {
  state: state.EditorState.create({
    schema,
    plugins: [
      pm.plugin,
      pm.cursorPlugin(presence), // the room's carets and selections, and this editor's published
      keymap({ 'Mod-z': undoCommand, 'Mod-Shift-z': redoCommand }),
    ],
  }),
});
await pm.attach(editor).ready;
// #endregion prosemirror
pm.stop();
editor.destroy();

// #region codemirror
import * as cmState from '@codemirror/state';
import * as cmView from '@codemirror/view';
import { createCodeMirror } from '@alexify/syncom/codemirror';

const cm = createCodeMirror(db, id, 'script', { state: cmState, view: cmView });
const { keys } = cm.commands(createUndo(db, { trackedSources: [cm.source], records: [id] }));
const cursors = cm.cursors(presence);

const code = new cmView.EditorView({
  parent: element,
  state: cmState.EditorState.create({
    doc: '',
    extensions: [cm.extension, cursors.extension, cmView.keymap.of(keys)],
  }),
});
await cm.attach(code).ready;
// #endregion codemirror
cm.stop();
cursors.stop();
code.destroy();
await db.close();

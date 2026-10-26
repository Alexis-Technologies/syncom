import { expectError, expectType } from 'tsd';
import * as model from 'prosemirror-model';
import * as state from 'prosemirror-state';
import * as transform from 'prosemirror-transform';
import * as view from 'prosemirror-view';
import { createProseMirror, docToSpans, spansToDoc, indexOfPos, posOfIndex } from '../src/prosemirror/prosemirror.js';
import type { ProseMirrorBinding } from '../src/prosemirror/prosemirror.js';
import type { Storage, TextSpan } from '../src/all/all.js';
import type { TextBinding } from '../src/editor/editor.js';
import { createUndo } from '../src/undo/undo.js';
import { createPresence } from '../src/presence/presence.js';

declare const storage: Storage;
declare const schema: model.Schema;
declare const doc: model.Node;

const pm = createProseMirror(storage, 'id', 'body', { model, state, transform, view }, { onReset: () => {} });
expectType<ProseMirrorBinding>(pm);
expectType<state.Plugin>(pm.plugin);
const editorState = state.EditorState.create({
  schema,
  plugins: [pm.plugin, pm.cursorPlugin(createPresence(storage))],
});
const target = {
  state: editorState,
  dispatch(tr: state.Transaction) {
    this.state = this.state.apply(tr);
  },
};
expectType<TextBinding>(pm.attach(target));
expectType<TextBinding | null>(pm.binding);
const { undo, redo } = pm.commands(createUndo(storage, { trackedSources: [pm.source] }));
expectType<state.Command>(undo);
expectType<boolean>(redo(editorState));
expectType<TextSpan[]>(docToSpans(doc));
expectType<model.Node>(spansToDoc(docToSpans(doc), schema));
expectType<number>(indexOfPos(doc, 3));
expectType<number>(posOfIndex(doc, 3));
expectError(createProseMirror(storage, 'id', 'body', { model }));
expectError(pm.attach({}));

import { expectError, expectType } from 'tsd';
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import { createCodeMirror, deltaOfChanges, changesOfDelta } from '../src/codemirror/codemirror.js';
import type { CodeMirrorBinding } from '../src/codemirror/codemirror.js';
import type { Storage, DeltaOp } from '../src/all/all.js';
import type { TextBinding } from '../src/editor/editor.js';
import { createUndo } from '../src/undo/undo.js';
import { createPresence } from '../src/presence/presence.js';

declare const storage: Storage;

const cmb = createCodeMirror(storage, 'id', 'body', { state, view }, { onError: (error) => error.message });
expectType<CodeMirrorBinding>(cmb);
const cursors = cmb.cursors(createPresence(storage), { className: 'mine' });
const editor = new view.EditorView({
  state: state.EditorState.create({ doc: '', extensions: [cmb.extension, cursors.extension] }),
});
expectType<TextBinding>(cmb.attach(editor));
expectType<TextBinding | null>(cmb.binding);
const { undo, redo, keys } = cmb.commands(createUndo(storage, { trackedSources: [cmb.source] }));
expectType<boolean>(undo(editor));
expectType<view.Command>(redo);
view.keymap.of(keys);
const changes = state.ChangeSet.of([{ from: 0, insert: 'x' }], 0);
expectType<DeltaOp[]>(deltaOfChanges(changes));
expectType<state.ChangeSpec[]>(changesOfDelta([{ retain: 1 }]));
expectError(createCodeMirror(storage, 'id', 'body', {}));
expectError(cmb.attach({}));

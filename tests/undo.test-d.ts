import { expectError, expectType } from 'tsd';
import type { Storage } from '../index.js';
import { createUndo, UndoManager } from '../undo.js';

declare const storage: Storage;
const undo = createUndo(storage, { mergeInterval: 300, limit: 50, exclude: (op) => op.id === 'x', actor: 'ada' });
expectType<UndoManager>(undo);
expectType<boolean>(undo.canUndo);
expectType<{ undo: number; redo: number }>(undo.size);
expectType<Promise<{ applied: number; skipped: number }>>(undo.undo({ force: true }));
expectType<Promise<{ applied: number; skipped: number }>>(undo.redo());
expectType<void>(undo.mark());
undo.on('pop', ({ direction, applied }) => {
  expectType<'undo' | 'redo'>(direction);
  expectType<number>(applied);
});
expectError(createUndo(storage, { limit: 'many' }));

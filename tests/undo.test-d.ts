import { expectError, expectType } from 'tsd';
import type { Storage } from '../index.js';
import { createUndo, UndoManager } from '../src/undo/undo.js';
import type { UndoStep } from '../src/undo/undo.js';

declare const storage: Storage;
const undo = createUndo(storage, { mergeInterval: 300, limit: 50, exclude: (op) => op.id === 'x', actor: 'ada' });
expectType<UndoManager>(undo);
expectType<boolean>(undo.canUndo);
expectType<{ undo: number; redo: number }>(undo.size);
expectType<Promise<{ applied: number; skipped: number }>>(undo.undo({ force: true }));
expectType<Promise<{ applied: number; skipped: number }>>(undo.redo());
expectType<void>(undo.mark());
undo.on('pop', ({ direction, applied, step }) => {
  expectType<'undo' | 'redo'>(direction);
  expectType<number>(applied);
  expectType<UndoStep>(step);
  expectType<Record<string, unknown>>(step.meta);
});
const scoped = createUndo(storage, {
  trackedSources: ['editor'],
  records: (id) => id.startsWith('doc'),
  paths: ['body'],
  onPush: ({ step }) => {
    step.meta.selection = [0, 1];
  },
  onPop: ({ step, direction }) => {
    expectType<'undo' | 'redo'>(direction);
    expectType<string[]>(step.records);
  },
});
expectType<Promise<number>>(scoped.group(async () => 1));
expectType<void>(scoped.groupStart());
expectType<void>(scoped.groupEnd());
expectType<UndoStep[]>(scoped.steps.undo);
expectError(createUndo(storage, { paths: 'body' }));
expectError(createUndo(storage, { limit: 'many' }));
expectType<number>(undo.listenerCount('change'));

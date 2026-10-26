import { expectError, expectType } from 'tsd';
import {
  createTextBinding,
  compose,
  transform,
  transformIndex,
  applyToText,
  spansToDelta,
  deltaToSpans,
  spansToBlocks,
  blocksToSpans,
  diffSpans,
  diffBlocks,
  selectionToTokens,
  tokensToSelection,
  presenceCursors,
  EMBED,
} from '../src/editor/editor.js';
import type {
  TextBinding,
  EditorAdapter,
  SelectionTokens,
  PresenceCursor,
  DeltaOp,
  TextSpan,
  TextBlock,
} from '../src/editor/editor.js';
import type { Storage } from '../src/all/all.js';
import { createPresence } from '../src/presence/presence.js';

declare const storage: Storage;
declare const adapter: EditorAdapter;
declare const spans: TextSpan[];
declare const blocks: TextBlock[];

expectType<'￼'>(EMBED);
const binding = createTextBinding(storage, 'id', 'body', adapter, {
  source: 'editor',
  onReset: () => {},
  onError: (e) => e.message,
});
expectType<TextBinding>(binding);
expectType<Promise<void>>(binding.ready);
expectType<string>(binding.shadow);
expectType<boolean>(binding.pending);
expectType<Promise<void>>(binding.flush());
expectType<void>(binding.stop());
expectError(createTextBinding(storage, 'id', 'body', {}));
expectType<DeltaOp[]>(compose([{ insert: 'a' }], [{ retain: 1, attributes: { bold: true } }]));
expectType<DeltaOp[]>(transform([{ insert: 'a' }], [{ delete: 1 }], true));
expectType<number>(transformIndex(3, [{ insert: 'ab' }]));
expectType<string>(applyToText('abc', [{ delete: 1 }]));
expectType<DeltaOp[]>(spansToDelta(spans));
expectType<TextSpan[]>(deltaToSpans([{ insert: { embed: null } }]));
expectType<TextBlock[]>(spansToBlocks(spans));
expectType<TextSpan[]>(blocksToSpans(blocks));
expectType<DeltaOp[]>(diffSpans(spans, spans));
expectType<DeltaOp[]>(diffBlocks(blocks, blocks));
expectType<Promise<SelectionTokens | null>>(selectionToTokens(storage, 'id', 'body', { anchor: 1, head: 3 }));
selectionToTokens(storage, 'id', 'body', { anchor: 1 }).then((tokens) => {
  if (tokens !== null) expectType<Promise<{ anchor: number; head: number } | null>>(tokensToSelection(storage, tokens));
});
expectType<Promise<PresenceCursor[]>>(
  presenceCursors(createPresence(storage), storage, 'id', 'body', { key: 'caret' }),
);
// An adapter is the three functions.
const quillLike: EditorAdapter = {
  setContents: (ops) => expectType<DeltaOp[]>(ops),
  updateContents: (delta) => expectType<DeltaOp[]>(delta),
  onChange: (listener) => {
    listener([{ insert: 'x' }]);
    return () => {};
  },
};
createTextBinding(storage, 'id', 'body', quillLike);

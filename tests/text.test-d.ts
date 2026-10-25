import { expectAssignable, expectType } from 'tsd';
import { text } from '../src/text/text.js';
import type {
  Plugin,
  TextMethods,
  SequenceBlock,
  TextSpan,
  BlockMarker,
  TextBlock,
  CursorPosition,
  DeltaOp,
} from '../src/text/text.js';
import { open } from '../index.js';

expectType<Plugin<TextMethods>>(text);
const storage = await open({ plugins: [text] });
expectType<Promise<void>>(storage.splice('id', 'body', 0, 0, 'hi'));
expectType<Promise<TextSpan[] | null>>(storage.spans('id', 'body'));
expectType<Promise<string | null>>(storage.elementAt('id', 'items', 0));
expectType<Promise<string[]>>(storage.elements('id', 'items'));
expectType<Promise<void>>(storage.insertEmbed('id', 'body', 0, { type: 'image', attrs: { src: 'a.png' } }));
expectType<Promise<void>>(storage.splitBlock('id', 'body', 0, { type: 'paragraph', parents: ['list'] }));
expectType<Promise<void>>(storage.joinBlock('id', 'body', 0));
expectType<Promise<void>>(storage.updateBlock('id', 'body', 0, { type: 'heading', attrs: { level: 2 } }));
expectType<Promise<BlockMarker | null>>(storage.block('id', 'body', 0));
expectType<Promise<TextBlock[] | null>>(storage.blocks('id', 'body'));
expectAssignable<TextSpan>({ type: 'text', text: 'a', marks: {} });
expectAssignable<TextSpan>({ type: 'block', value: { type: 'p', parents: [], attrs: {}, isEmbed: false } });
expectAssignable<TextSpan>({ type: 'embed', value: null, marks: {} });
expectType<Promise<CursorPosition | null>>(storage.position('id', 'body', '^'));
expectType<Promise<(CursorPosition | null)[]>>(storage.positions('id', 'body', ['^', '$']));
expectType<DeltaOp[] | null>(storage.toDelta([], 'body'));
expectType<Promise<{ origin: string; ts: number } | null>>(storage.editorOf('id', 'body', 0));
expectType<Promise<number>>(
  storage.applyDelta('id', 'body', [{ insert: 'x' }, { retain: 1, attributes: { bold: true } }]),
);
expectType<Promise<string>>(storage.insert({}));
expectAssignable<SequenceBlock>({ k: 'l', ts: 0, runs: {} });

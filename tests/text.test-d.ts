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
  TextHandle,
  TextHandleMethods,
} from '../src/text/text.js';
import { open } from '../index.js';

expectType<Plugin<TextMethods & TextHandleMethods>>(text);
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
expectType<Promise<{ ops: number; revision: number }>>(
  storage.applyDelta('id', 'body', [{ insert: 'x' }, { retain: 1, attributes: { bold: true } }]),
);
expectType<Promise<{ ops: number; revision: number }>>(
  storage.applyDelta('id', 'body', [{ insert: 'x' }], { expect: '', revision: 3 }),
);
expectType<Promise<number>>(storage.revision('id', 'body'));
expectType<Promise<string>>(storage.insert({}));
expectAssignable<SequenceBlock>({ k: 'l', ts: 0, runs: {} });

const handle = await storage.openText('id', 'body', { window: 0, actor: 'ada' });
expectType<TextHandle>(handle);
expectType<void>(handle.insert(0, 'hi', { bold: true }));
expectType<void>(handle.delete(0, 1));
expectType<void>(handle.format(0, 1, { bold: null }));
expectType<void>(handle.applyDelta([{ insert: 'x' }]));
expectType<string>(handle.toString());
expectType<number>(handle.length);
expectType<boolean>(handle.pending);
expectType<Promise<void>>(handle.flushed);
expectType<() => void>(handle.observe((delta, event) => void [delta, event.local, event.reset]));
expectType<Promise<void>>(handle.flush());

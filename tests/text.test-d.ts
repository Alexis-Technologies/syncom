import { expectAssignable, expectType } from 'tsd';
import { text } from '../src/text/text.js';
import type { Plugin, TextMethods, SequenceBlock, TextSpan } from '../src/text/text.js';
import { open } from '../index.js';

expectType<Plugin<TextMethods>>(text);
const storage = await open({ plugins: [text] });
expectType<Promise<void>>(storage.splice('id', 'body', 0, 0, 'hi'));
expectType<Promise<TextSpan[] | null>>(storage.spans('id', 'body'));
expectType<Promise<string>>(storage.insert({}));
expectAssignable<SequenceBlock>({ k: 'l', ts: 0, runs: {} });

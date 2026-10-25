import { expectAssignable, expectError, expectType } from 'tsd';
import * as syncom from '../src/all/all.js';
import type { StorageOptions } from '../src/all/all.js';
import { memory } from '../src/memory/memory.js';

// Everything in one import: the core's surface plus the text and tree methods.
const storage = await syncom.open({ path: 'x' });
expectType<Promise<string>>(storage.insert({ a: 1 }));
expectType<string>(storage.nodeId);
expectType<Promise<void>>(storage.inc('id', 'hits', 1));
expectType<Promise<void>>(storage.splice('id', 'body', 0, 0, 'hi', { actor: 'u2' }));
expectType<Promise<void>>(storage.splice('id', 'items', 1, 2));
expectType<Promise<void>>(storage.push('id', 'items', [1, { a: 2 }]));
expectError(storage.splice('id', 'body', 'x', 0, 'hi'));
expectError(storage.push('id', 'body', 5));
expectType<Promise<void>>(storage.setAt('id', 'items', 0, { done: true }));
expectType<Promise<number>>(storage.updateText('id', 'body', 'hello', { actor: 'u2' }));
expectError(storage.updateText('id', 'body', 5));
expectType<Promise<string | null>>(storage.mark('id', 'body', 0, 5, 'bold', true, { expand: 'after' }));
expectType<Promise<string | null>>(storage.mark('id', 'body', 0, 5, 'comment', { by: 'ada' }, { many: true }));
expectType<Promise<void>>(storage.unmark('id', 'body', 0, 5, 'bold'));
expectType<Promise<void>>(storage.unmarkById('id', 'body', '1:a'));
expectError(storage.unmark('id', 'body', '1:a'));
expectType<Promise<syncom.TextSpan[] | null>>(storage.spans('id', 'body'));
expectError(storage.mark('id', 'body', 0, 5, 'bold', true, { expand: 'sideways' }));
expectType<Promise<string | null>>(storage.cursor('id', 'body', 3, { side: 'after' }));
expectType<Promise<number | null>>(storage.index('id', 'body', '<1:0:a'));
expectError(storage.cursor('id', 'body', 3, { side: 'left' }));
expectType<Promise<void>>(storage.move('id', 'items', 0, 2, { actor: 'u2' }));
expectError(storage.setAt('id', 'items', 'x', 1));
expectError(storage.move('id', 'items', 0));
expectType<Promise<void>>(storage.treeMove('id', 'outline', 'n1'));
expectType<Promise<void>>(storage.treeMove('id', 'outline', 'n2', 'n1', { after: 'n3', actor: 'u2' }));
expectType<Promise<void>>(storage.treeRemove('id', 'outline', 'n2'));
expectError(storage.treeMove('id', 'outline', 5));
expectError(storage.treeMove('id', 'outline', 'n2', 'n1', { after: 3 }));

// A schema's collections ride along, and so does a caller's own plugin.
const typed = await syncom.open({ schema: { entities: { Post: {} } } });
expectType<syncom.SyncomCollection>(typed.Post);
declare const somePlugin: syncom.Plugin<{ fly(): Promise<void> }>;
const flown = await syncom.open({ plugins: [somePlugin] });
expectType<Promise<void>>(flown.fly());
expectType<Promise<void>>(flown.splice('id', 'body', 0, 0, 'x'));

// The plugins and the registry-bound folds.
expectType<syncom.Plugin<syncom.TextMethods>>(syncom.text);
expectType<syncom.Plugin<syncom.TreeMethods>>(syncom.tree);
expectType<
  readonly [
    syncom.Plugin<syncom.TextMethods>,
    syncom.Plugin<syncom.TreeMethods>,
    syncom.Plugin,
    syncom.Plugin,
    syncom.Plugin,
    syncom.Plugin<syncom.SyncApi>,
    syncom.Plugin,
    syncom.Plugin,
    syncom.Plugin,
    syncom.Plugin,
  ]
>(syncom.PLUGINS);
expectType<syncom.Plugin>(syncom.versions);
expectType<syncom.Plugin>(syncom.query);
expectType<syncom.Plugin>(syncom.telemetry);
expectType<syncom.SyncomTelemetryWriter>(syncom.createTelemetry({ api: {} }));
expectType<syncom.Plugin>(syncom.schema);
expectType<syncom.SyncManager>(storage.sync);
expectType<syncom.Plugin<syncom.SyncApi>>(syncom.sync);
expectType<syncom.Plugin>(syncom.signing);
expectType<syncom.Plugin>(syncom.chain);
expectType<syncom.Plugin>(syncom.encryption);
expectType<string>(syncom.calculateHash({ a: 1 }));
expectType<Promise<syncom.Blockchain>>(new syncom.Blockchain('base'));
expectType<syncom.Fsi>(syncom.atRest(memory(), { key: new Uint8Array(32) }));
declare const entry: syncom.Entry;
expectType<syncom.ApplyResult>(
  syncom.applyOp(entry, {
    origin: 'a',
    seq: 1,
    ts: 1,
    type: 'splice',
    id: 'r',
    key: 'body',
    value: { at: '^', content: 'x' },
  }),
);
expectType<syncom.Entry | null>(syncom.mergeEntry(entry, entry));
expectAssignable<StorageOptions>({ plugins: [syncom.text] });
expectType<syncom.StorageConstructor>(syncom.Storage);
// A typed collection through the bundle's `open()`.
interface Task {
  title: string;
  done: boolean;
}
const shaped: syncom.Schema<{ Task: Task }> = { entities: { Task: {} } };
const tasks = await syncom.open({ schema: shaped });
expectType<Promise<Task | null>>(tasks.Task.get('id'));
expectType<Promise<syncom.SyncomRecord<Task>>>(tasks.Task.insert({ title: 'x', done: false }));
expectType<Promise<void>>(tasks.splice('id', 'body', 0, 0, 'hi'));

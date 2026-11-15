// The Logger page (docs/guide/logger.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

// #region default
const board = await createDatabase({ path: 'board', schema: { entities: { Task: {} } } }); // logger: console, the default
// { event: 'log.epoch.new', epoch: 'mwh…', reason: 'no index', entries: 0 }   a brand-new log, at debug
// { event: 'catalog.rebuild', reason: 'no catalog' }                          nothing to read yet, at debug
// #endregion default
await board.close();

// #region pino
import pino from 'pino';

const logger = pino({ level: 'info', base: { service: 'board' } });
const app = await createDatabase({ path: 'board', logger, schema: { version: 2, entities: { Task: {} } } });
// {"level":30,"time":…,"service":"board","event":"schema.upgrade","from":1,"to":2}
// #endregion pino
await app.close();

// A logger that keeps what it is told, for the assertions below.
const seen = [];
const keep = (level) => (entry) => seen.push({ level, ...entry });
const capture = { debug: keep('debug'), info: keep('info'), warn: keep('warn'), error: keep('error') };
const v3 = await createDatabase({ path: 'board', logger: capture, schema: { version: 3, entities: { Task: {} } } });
await v3.close();
assert.deepEqual(
  seen.find((entry) => entry.event === 'schema.upgrade'),
  { level: 'info', event: 'schema.upgrade', from: 2, to: 3 },
);

// #region levels
const quiet = await createDatabase({
  path: 'quiet',
  logger: { warn: console.warn, error: console.error }, // a level the logger lacks is skipped
});
// #endregion levels
await quiet.close();

// #region silent
const silent = await createDatabase({ path: 'silent', logger: false });
// #endregion silent
await silent.close();

// #region route
const alerts = [];
const routed = {
  debug() {},
  info: (entry) => console.info(entry),
  warn: (entry) => console.warn(entry),
  error(entry) {
    console.error(entry);
    if (entry.event === 'storage.unpersisted' || entry.event === 'log.append.failed') alerts.push(entry);
  },
};

const tasks = await createDatabase({ path: 'tasks', logger: routed, schema: { entities: { Task: {} } } });
tasks.on('change', () => {
  throw new Error('the listener has a bug');
});
await tasks.Task.insert({ title: 'Ship it' });
// { event: 'listener.error', name: 'change', err: Error: the listener has a bug … }   at warn: the write went through
// #endregion route
await new Promise((resolve) => setTimeout(resolve, 20));
await tasks.close();
assert.deepEqual(alerts, []);

const warned = [];
const watch = await createDatabase({
  path: 'watch',
  logger: { warn: (entry) => warned.push(entry) },
  schema: { entities: { Task: {} } },
});
watch.on('change', () => {
  throw new Error('the listener has a bug');
});
await watch.Task.insert({ title: 'Ship it' });
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(warned[0].event, 'listener.error');
assert.equal(warned[0].name, 'change');
assert.equal(await watch.Task.count({}), 1);
await watch.close();

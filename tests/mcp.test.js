'use strict';

// The agent tools (src/mcp/mcp.js): a set per collection, every argument checked against the tool's inputSchema
// before anything runs, readOnly without writers, changes by event id (MCP-1).

const test = require('node:test');
const assert = require('node:assert');
const { createDatabase } = require('../src/all/all.js');
const { memoryEngine } = require('../src/memory/memory.js');
const { createTools, checkArgs, MAX_LIMIT } = require('../src/mcp/mcp.js');

const open = async (t, options = {}) => {
  const db = await createDatabase({
    path: 'mcp',
    engine: memoryEngine(),
    lock: false,
    logger: false,
    schema: { entities: { Task: { index: ['done'] }, Note: {} } },
    ...options,
  });
  t.after(() => db.close().catch(() => {}));
  return db;
};
const named = (tools) => {
  const out = {};
  for (const tool of tools) out[tool.name] = tool;
  return out;
};

test('@alexify/syncom/mcp', async (t) => {
  await t.test(
    'a set of tools per collection, query/count/get/changes/wait_changes and the three writers; readOnly exposes no writer; collections names some',
    async (t2) => {
      const db = await open(t2);
      const tools = createTools(db);
      assert.deepStrictEqual(
        tools.map((tool) => tool.name),
        [
          'Task_query',
          'Task_count',
          'Task_get',
          'Task_changes',
          'Task_wait_changes',
          'Task_insert',
          'Task_upsert',
          'Task_delete',
          'Note_query',
          'Note_count',
          'Note_get',
          'Note_changes',
          'Note_wait_changes',
          'Note_insert',
          'Note_upsert',
          'Note_delete',
        ],
      );
      for (const tool of tools) {
        assert.strictEqual(typeof tool.description, 'string');
        assert.strictEqual(tool.inputSchema.type, 'object');
        assert.strictEqual(tool.inputSchema.additionalProperties, false);
        assert.ok(Object.isFrozen(tool));
      }
      const readOnly = createTools(db, { readOnly: true, collections: ['Note'] });
      assert.deepStrictEqual(
        readOnly.map((tool) => tool.name),
        ['Note_query', 'Note_count', 'Note_get', 'Note_changes', 'Note_wait_changes'],
      );
      assert.throws(() => createTools(db, { collections: ['Nope'] }), {
        name: 'TypeError',
        message: /no collection Nope/,
      });
      assert.throws(() => createTools(db, { collections: 'Task' }), { name: 'TypeError' });
      assert.throws(() => createTools(db, { limit: 0 }), { name: 'TypeError' });
      assert.throws(() => createTools(db, { limit: MAX_LIMIT + 1 }), { name: 'TypeError' });
      assert.throws(() => createTools(null), { name: 'TypeError' });
      assert.throws(() => createTools({}), { name: 'TypeError' });
    },
  );

  await t.test(
    'the writers write, the readers read: insert, upsert by the id given or the data’s, get, query ordered and windowed, count, delete',
    async (t2) => {
      const db = await open(t2);
      const tools = named(createTools(db, { collections: ['Task'], limit: 10 }));
      const { id: a } = await tools.Task_insert.execute({ data: { title: 'a', done: false } });
      const { id: b } = await tools.Task_insert.execute({ data: { title: 'b', done: true } });
      assert.deepStrictEqual(await tools.Task_upsert.execute({ id: 'task-c', data: { title: 'c', done: false } }), {
        id: 'task-c',
      });
      assert.deepStrictEqual(await tools.Task_get.execute({ id: 'task-c' }), {
        record: { title: 'c', done: false, $type: 'Task' },
      });
      assert.deepStrictEqual(await tools.Task_get.execute({ id: 'task-none' }), { record: null });
      assert.deepStrictEqual(await tools.Task_count.execute({ query: { done: false } }), { count: 2 });
      assert.deepStrictEqual(await tools.Task_count.execute(), { count: 3 });
      const { rows } = await tools.Task_query.execute({ query: { done: false }, order: ['-title'] });
      assert.deepStrictEqual(
        rows.map((row) => row.title),
        ['c', 'a'],
      );
      const page = await tools.Task_query.execute({ order: ['title'], limit: 1, offset: 1 });
      assert.deepStrictEqual(
        page.rows.map((row) => row.title),
        ['b'],
      );
      assert.deepStrictEqual(await tools.Task_delete.execute({ id: b }), { id: b, deleted: true });
      assert.deepStrictEqual(await tools.Task_delete.execute({ id: b }), { id: b, deleted: false }, 'deleted already');
      assert.deepStrictEqual(await tools.Task_delete.execute({ id: 'task-none' }), { id: 'task-none', deleted: false });
      assert.deepStrictEqual(await tools.Task_count.execute(), { count: 2 });
      assert.strictEqual(a.length > 0, true);
      // The id field of the data names the record for upsert without an id.
      const dbNamed = await open(t2, { path: 'named', schema: { entities: { User: { id: { fields: ['code'] } } } } });
      const users = named(createTools(dbNamed));
      const { id } = await users.User_upsert.execute({ data: { code: 'u42', name: 'X' } });
      assert.strictEqual(id, 'u42');
      assert.deepStrictEqual(await users.User_get.execute({ id }), {
        record: { code: 'u42', name: 'X', $type: 'User' },
      });
    },
  );

  await t.test(
    'sealed records are left out of query, count and get unless createTools(db, { sealed: true })',
    async (t2) => {
      const db = await open(t2);
      const plain = await db.insert({ $type: 'Task', title: 'plain', done: false });
      const sealed = await db.insert({ $type: 'Task', title: 'SEALED', done: false }, { encrypted: true });
      const tools = named(createTools(db, { collections: ['Task'] }));
      assert.deepStrictEqual(
        (await tools.Task_query.execute()).rows.map((row) => row.id),
        [plain],
      );
      assert.deepStrictEqual((await tools.Task_query.execute({ query: { title: 'SEALED' } })).rows, []);
      assert.deepStrictEqual(await tools.Task_count.execute(), { count: 1 });
      assert.deepStrictEqual(await tools.Task_count.execute({ query: { done: false } }), { count: 1 });
      assert.deepStrictEqual(await tools.Task_get.execute({ id: sealed }), { record: null });
      assert.deepStrictEqual(await tools.Task_get.execute({ id: plain }), {
        record: { title: 'plain', done: false, $type: 'Task' },
      });
      // Asked for: the agent is a reader at the key holder.
      const asked = named(createTools(db, { collections: ['Task'], sealed: true }));
      assert.strictEqual((await asked.Task_query.execute()).rows.length, 2);
      assert.deepStrictEqual(await asked.Task_count.execute(), { count: 2 });
      assert.deepStrictEqual(await asked.Task_get.execute({ id: sealed }), {
        record: { title: 'SEALED', done: false, $type: 'Task' },
      });
      assert.throws(() => createTools(db, { sealed: 1 }), { name: 'TypeError' });
    },
  );

  await t.test(
    'every argument is checked against the tool’s inputSchema before anything runs: a wrong type, a member not named, a required one missing, a window past the cap',
    async (t2) => {
      const db = await open(t2);
      const tools = named(createTools(db, { collections: ['Task'], limit: 10 }));
      await assert.rejects(tools.Task_get.execute({}), { name: 'TypeError', message: /args\.id is required/ });
      await assert.rejects(tools.Task_get.execute({ id: 7 }), {
        name: 'TypeError',
        message: /args\.id: string expected, number given/,
      });
      await assert.rejects(tools.Task_get.execute({ id: 'a', extra: 1 }), {
        name: 'TypeError',
        message: /args\.extra is not a member/,
      });
      await assert.rejects(tools.Task_query.execute({ limit: 11 }), {
        name: 'TypeError',
        message: /args\.limit: 10 at most/,
      });
      await assert.rejects(tools.Task_query.execute({ limit: 1.5 }), {
        name: 'TypeError',
        message: /integer expected/,
      });
      await assert.rejects(tools.Task_query.execute({ offset: -1 }), { name: 'TypeError', message: /0 at least/ });
      await assert.rejects(tools.Task_query.execute({ order: ['title', 2] }), {
        name: 'TypeError',
        message: /args\.order\[1\]: string expected/,
      });
      await assert.rejects(tools.Task_query.execute({ query: [] }), {
        name: 'TypeError',
        message: /args\.query: object expected, array given/,
      });
      await assert.rejects(tools.Task_query.execute({ query: null }), { name: 'TypeError', message: /null given/ });
      await assert.rejects(tools.Task_insert.execute({ data: 'x' }), { name: 'TypeError' });
      await assert.rejects(tools.Task_wait_changes.execute({ timeout: 10 }), {
        name: 'TypeError',
        message: /since is required/,
      });
      await assert.rejects(tools.Task_wait_changes.execute({ since: '1.0', timeout: 1e9 }), {
        name: 'TypeError',
        message: /at most/,
      });
      await assert.rejects(tools.Task_query.execute('nope'), { name: 'TypeError', message: /args: object expected/ });
      assert.strictEqual(
        await tools.Task_count.execute({ query: { done: { $exists: false } } }).then((r) => r.count),
        0,
      );
      // checkArgs on its own: enum.
      assert.throws(() => checkArgs({ type: 'string', enum: ['a', 'b'] }, 'c'), { message: /one of a, b expected/ });
      checkArgs({ type: 'string', enum: ['a', 'b'] }, 'a');
      checkArgs({ type: 'object', properties: { n: { type: 'number' } } }, { n: 1.5, other: true });
      // The collection's own refusals come through as they are, with their code: a Note is not a Task.
      const note = await db.Note.insert({ text: 'n' });
      await assert.rejects(tools.Task_delete.execute({ id: note.id }), { code: 'NOT_FOUND' });
    },
  );

  await t.test(
    'changes: the eventId to start from, the collection’s records changed since one, null where the log cannot resume; wait_changes resolves on a change or at its timeout',
    async (t2) => {
      const db = await open(t2);
      const tools = named(createTools(db));
      const start = await tools.Task_changes.execute();
      assert.deepStrictEqual(start.changes, []);
      assert.strictEqual(typeof start.eventId, 'string');
      assert.deepStrictEqual(await tools.Task_changes.execute({ since: start.eventId }), {
        eventId: start.eventId,
        changes: [],
        more: false,
      });
      const { id: a } = await tools.Task_insert.execute({ data: { title: 'a', done: false } });
      const { id: n } = await tools.Note_insert.execute({ data: { text: 'not a task' } });
      await db.Task.update(a, { done: true });
      const after = await tools.Task_changes.execute({ since: start.eventId });
      assert.deepStrictEqual(after.changes, [{ id: a, deleted: false }], 'the task once; the note is Note’s');
      assert.notStrictEqual(after.eventId, start.eventId);
      assert.deepStrictEqual((await tools.Note_changes.execute({ since: start.eventId })).changes, [
        { id: n, deleted: false },
      ]);
      await tools.Task_delete.execute({ id: a });
      assert.deepStrictEqual((await tools.Task_changes.execute({ since: after.eventId })).changes, [
        { id: a, deleted: true },
      ]);
      assert.deepStrictEqual(
        (await tools.Task_changes.execute({ since: '999.1' })).changes,
        null,
        'another epoch: not resumable',
      );
      // wait_changes: at once where there is something, on the change otherwise, at the timeout with nothing.
      const now = await tools.Task_changes.execute();
      const waiting = tools.Task_wait_changes.execute({ since: now.eventId, timeout: 5000 });
      setTimeout(() => void db.Task.insert({ title: 'late', done: false }), 20);
      const heard = await waiting;
      assert.strictEqual(heard.changes.length, 1);
      assert.deepStrictEqual(
        await tools.Task_wait_changes.execute({ since: now.eventId, timeout: 10 }),
        heard,
        'at once: there is something',
      );
      const quiet = await tools.Task_wait_changes.execute({ since: heard.eventId, timeout: 30 });
      assert.deepStrictEqual(quiet, { eventId: heard.eventId, changes: [], more: false });
      assert.deepStrictEqual((await tools.Task_wait_changes.execute({ since: '999.1', timeout: 10 })).changes, null);
    },
  );

  await t.test('$regex is refused at the door unless createTools({ regex: true })', async (t2) => {
    const db = await open(t2);
    await db.Task.insert({ title: 'aaaaaaaaaaaaaaaaaaaaaaaaaaa!', done: false });
    const tools = named(createTools(db, { collections: ['Task'] }));
    // A pattern that backtracks for seconds: refused before anything runs, in no time.
    const started = Date.now();
    for (const query of [
      { title: { $regex: '^(a+)+$' } },
      { $or: [{ done: true }, { title: { $regex: 'x' } }] },
      { $and: [{ $not: { title: { $regex: 'x' } } }] },
      { nested: { deep: { $regex: 'x', $options: 'i' } } },
    ]) {
      await assert.rejects(tools.Task_query.execute({ query }), {
        name: 'TypeError',
        message: /args\.query.*\$regex is not allowed: createTools\(\{ regex: true \}\)/,
      });
      await assert.rejects(tools.Task_count.execute({ query }), { name: 'TypeError', message: /\$regex/ });
    }
    assert.ok(Date.now() - started < 500, 'refused at the door, never evaluated');
    assert.strictEqual((await tools.Task_count.execute({ query: { done: false } })).count, 1, 'other queries run');
    // Allowed by the application: the pattern runs.
    const allowed = named(createTools(db, { collections: ['Task'], regex: true }));
    assert.strictEqual((await allowed.Task_count.execute({ query: { title: { $regex: '^a+!$' } } })).count, 1);
    assert.throws(() => createTools(db, { regex: 'yes' }), { name: 'TypeError', message: /regex/ });
  });

  await t.test('checkArgs refuses constructor, toString and __proto__ as members not named', async (t2) => {
    const db = await open(t2);
    const tools = named(createTools(db, { collections: ['Task'] }));
    for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const args = JSON.parse(`{"id":"a","${key}":{"polluted":true}}`);
      await assert.rejects(tools.Task_get.execute(args), {
        name: 'TypeError',
        message: new RegExp(`args\\.${key} is not a member`),
      });
      assert.throws(() => checkArgs({ type: 'object', properties: { n: {} }, additionalProperties: false }, args), {
        message: /is not a member/,
      });
    }
    assert.strictEqual(Object.prototype.polluted, undefined);
    // A schema that names such a member takes it, as its own.
    checkArgs({ type: 'object', properties: { constructor: { type: 'string' } } }, { constructor: 'x' });
  });

  await t.test(
    'changes answers at most limit records and the eventId to continue from, more while there are; wait_changes the same',
    async (t2) => {
      const db = await open(t2);
      const tools = named(createTools(db, { collections: ['Task'], limit: 10 }));
      const start = await tools.Task_changes.execute();
      assert.strictEqual(start.more, false);
      const ids = [];
      for (let i = 0; i < 25; i++) ids.push((await db.Task.insert({ title: `t${i}`, done: false })).id);
      await db.Note.insert({ text: 'not a task' });
      // Paged: ten, ten, five — every id once, in the log's order, `more` until the end.
      const seen = [];
      let page = await tools.Task_changes.execute({ since: start.eventId, limit: 10 });
      while (true) {
        for (const change of page.changes) seen.push(change.id);
        if (!page.more) break;
        assert.strictEqual(page.changes.length, 10);
        page = await tools.Task_changes.execute({ since: page.eventId, limit: 10 });
      }
      assert.deepStrictEqual(seen, ids);
      assert.strictEqual(page.eventId, db.log.lastEventId);
      // The options' limit caps a page; the default page is that limit.
      await assert.rejects(tools.Task_changes.execute({ since: start.eventId, limit: 11 }), {
        name: 'TypeError',
        message: /args\.limit: 10 at most/,
      });
      const whole = await tools.Task_changes.execute({ since: start.eventId });
      assert.strictEqual(whole.changes.length, 10);
      assert.strictEqual(whole.more, true);
      // A record changed twice is one change; the page's eventId resumes after the last record answered.
      await db.Task.update(ids[0], { done: true });
      const after = await tools.Task_changes.execute({ since: page.eventId, limit: 10 });
      assert.deepStrictEqual(after, {
        eventId: db.log.lastEventId,
        changes: [{ id: ids[0], deleted: false }],
        more: false,
      });
      // wait_changes pages the same way.
      const waited = await tools.Task_wait_changes.execute({ since: start.eventId, limit: 3, timeout: 10 });
      assert.strictEqual(waited.changes.length, 3);
      assert.strictEqual(waited.more, true);
    },
  );

  await t.test(
    'every tool carries annotations — the readers readOnlyHint, the writers destructiveHint as they are — and tools names the verbs made',
    async (t2) => {
      const db = await open(t2);
      const tools = createTools(db, { collections: ['Task'] });
      const hints = {};
      for (const tool of tools) {
        assert.strictEqual(tool.annotations.title, tool.name);
        assert.strictEqual(tool.annotations.openWorldHint, false);
        const { readOnlyHint, destructiveHint, idempotentHint } = tool.annotations;
        hints[tool.name.slice('Task_'.length)] = [readOnlyHint, destructiveHint, idempotentHint];
      }
      assert.deepStrictEqual(hints, {
        query: [true, false, true],
        count: [true, false, true],
        get: [true, false, true],
        changes: [true, false, true],
        wait_changes: [true, false, true],
        insert: [false, false, false],
        upsert: [false, true, true],
        delete: [false, true, true],
      });
      // `tools` names the verbs to make; `readOnly` still leaves the writers out of them.
      const some = createTools(db, { collections: ['Task'], tools: ['query', 'get', 'delete'] });
      assert.deepStrictEqual(
        some.map((tool) => tool.name),
        ['Task_query', 'Task_get', 'Task_delete'],
      );
      const readers = createTools(db, { collections: ['Task'], tools: ['query', 'delete'], readOnly: true });
      assert.deepStrictEqual(
        readers.map((tool) => tool.name),
        ['Task_query'],
      );
      assert.throws(() => createTools(db, { tools: ['drop'] }), { name: 'TypeError', message: /no tool drop/ });
      assert.throws(() => createTools(db, { tools: 'query' }), { name: 'TypeError', message: /array of verbs/ });
      assert.throws(() => createTools(db, { readOnly: 1 }), { name: 'TypeError', message: /readOnly/ });
    },
  );
});

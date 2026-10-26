'use strict';

// A plugin of the application's: its methods are the storage's, as they are a
// transaction's, and a name that would shadow the storage is refused.

const test = require('node:test');
const assert = require('node:assert');
const { open } = require('../src/index.js');
const { memory } = require('../src/memory/memory.js');

test('a third-party plugin’s methods are on the storage and on a transaction; a name of the storage’s is refused', async (t) => {
  const greeter = {
    name: 'greeter',
    setup: () => ({}),
    methods: {
      greet: async (core, id, word) => {
        await core.commit('set', id, { data: { said: word } });
        return `${word}, ${id}`;
      },
    },
  };
  const storage = await open({ fsi: memory(), lock: false, logger: false, defer: 0, plugins: [greeter] });
  t.after(() => storage.close());
  const id = await storage.insert({ n: 1 });
  assert.strictEqual(typeof storage.greet, 'function');
  assert.strictEqual(await storage.greet(id, 'hello'), `hello, ${id}`);
  assert.strictEqual((await storage.get(id)).said, 'hello');
  assert.strictEqual(Object.keys(storage).includes('greet'), false, 'not an enumerable field');
  await storage.transact(async (tx) => {
    assert.strictEqual(await tx.greet(id, 'again'), `again, ${id}`);
  });
  assert.strictEqual((await storage.get(id)).said, 'again');
  for (const name of ['insert', 'then', 'sync']) {
    const clash = { name: `clash-${name}`, setup: () => ({}), methods: { [name]: async () => null } };
    await assert.rejects(
      open({ fsi: memory(), lock: false, logger: false, plugins: [clash] }),
      (error) => error instanceof TypeError && error.message.includes(`${name}()`),
      name,
    );
  }
});

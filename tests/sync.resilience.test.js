'use strict';

// What a dialer does with a page it cannot apply: the stream breaks and
// resumes from the last saved cursor, the page comes again, and after three
// failures in a row the peer is stuck — never a page silently stepped over.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('..');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { createMesh, settle, waitUntil } = require('./utils/mesh.js');

const createStorage = async (t, name, options = {}) => {
  const dir = await createTemp();
  t.after(() => cleanupTemp(dir));
  const storage = await syncom.open({ path: dir, logger: false, ...options });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

test('A page that fails is a break in the stream', async (t) => {
  await t.test('the page is retried from the saved cursor; nothing behind it moves the cursor', async (t2) => {
    let poison = null;
    let failures = 0;
    const mesh = await createMesh(t2, ['H', 'D'], [['D', 'H']], createStorage, {
      nodes: {
        D: {
          hooks: {
            beforeApply: ({ op }) => {
              if (op.id === poison && failures < 1) {
                failures++;
                throw new Error('not yet');
              }
            },
          },
        },
      },
    });
    const [h, d] = ['H', 'D'].map((name) => mesh.get(name));
    const errors = [];
    d.sync.on('error', (error) => errors.push(error));
    await waitUntil(() => d.sync.peers()[0]?.subscribed);
    const before = await h.insert({ n: 0 });
    await settle([h, d]);
    const saved = d.sync.peers()[0].cursor;
    poison = 'poison';
    await h.set(poison, { n: 1 });
    const after = await h.insert({ n: 2 });
    await settle([h, d]);
    assert.deepStrictEqual(await d.get(poison), { n: 1 }, 'the failed page came again and landed');
    assert.deepStrictEqual(await d.get(after), { n: 2 });
    assert.deepStrictEqual(await d.get(before), { n: 0 });
    assert.strictEqual(failures, 1);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'PAGE_FAILED');
    assert.strictEqual(errors[0].cursor, saved, 'the cursor of the last page that landed');
    assert.strictEqual(errors[0].attempt, 1);
    assert.strictEqual(errors[0].url, 'mem://H');
    assert.strictEqual(errors[0].cause.name, 'HookError');
    const [peer] = d.sync.peers();
    assert.strictEqual(peer.stuck, false);
    assert.strictEqual(peer.subscribed, true);
    assert.deepStrictEqual(d.vector, h.vector, 'no gap was left behind');
  });

  await t.test('three failures in a row leave the peer stuck, with the cursor where it was', async (t2) => {
    let broken = true;
    const mesh = await createMesh(t2, ['H', 'D'], [['D', 'H']], createStorage, {
      nodes: {
        D: {
          hooks: {
            beforeApply: ({ op }) => {
              if (broken && op.id === 'bad') throw new Error('always');
            },
          },
        },
      },
    });
    const [h, d] = ['H', 'D'].map((name) => mesh.get(name));
    const errors = [];
    d.sync.on('error', (error) => errors.push(error));
    await waitUntil(() => d.sync.peers()[0]?.subscribed);
    const first = await h.insert({ n: 1 });
    await settle([h, d]);
    const saved = d.sync.peers()[0].cursor;
    await h.set('bad', { n: 2 });
    const later = await h.insert({ n: 3 });
    await waitUntil(() => d.sync.peers()[0].stuck);
    assert.deepStrictEqual(
      errors.map((error) => [error.code, error.attempt]),
      [
        ['PAGE_FAILED', 1],
        ['PAGE_FAILED', 2],
        ['STUCK', 3],
      ],
    );
    const [peer] = d.sync.peers();
    assert.strictEqual(peer.subscribed, false, 'the feed is closed');
    assert.strictEqual(peer.cursor, saved, 'the cursor did not move past the page');
    assert.strictEqual(await d.get('bad'), null);
    assert.strictEqual(await d.get(later), null, 'nothing behind the page was taken');
    assert.deepStrictEqual(await d.get(first), { n: 1 });
    // The application fixes the cause and re-dials: the stream resumes from the cursor.
    broken = false;
    await d.sync.enableNode('mem://H', false);
    await d.sync.enableNode('mem://H', true);
    await settle([h, d]);
    assert.deepStrictEqual(await d.get('bad'), { n: 2 });
    assert.deepStrictEqual(await d.get(later), { n: 3 });
    assert.strictEqual(d.sync.peers()[0].stuck, false);
    assert.deepStrictEqual(d.vector, h.vector);
  });
});

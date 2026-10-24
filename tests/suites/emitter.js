'use strict';

// Shared by tests/utils.test.js and tests/utils.browser.test.js — the Emitter
// is byte-identical in both halves, so the contract is asserted once.
const runEmitterTests = async (t, assert, Emitter) => {
  await t.test('emit forwards every argument to every listener', async () => {
    const emitter = new Emitter();
    const seen = [];
    emitter.on('update', (data, delta) => void seen.push([data, delta]));
    emitter.on('update', (data, delta) => void seen.push([delta, data]));
    await emitter.emit('update', { a: 1 }, { b: 2 });
    assert.deepStrictEqual(seen, [
      [{ a: 1 }, { b: 2 }],
      [{ b: 2 }, { a: 1 }],
    ]);
  });

  await t.test('emit awaits async listeners', async () => {
    const emitter = new Emitter();
    let done = false;
    emitter.on('x', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      done = true;
    });
    await emitter.emit('x');
    assert.strictEqual(done, true);
  });

  await t.test('emit on an unknown event resolves', async () => {
    const emitter = new Emitter();
    assert.strictEqual(await emitter.emit('nobody'), undefined);
  });

  await t.test('emit of unhandled error throws', () => {
    const emitter = new Emitter();
    assert.throws(() => emitter.emit('error', new Error('boom')), /Unhandled error/);
  });

  await t.test('once fires a single time and is swept', async () => {
    const emitter = new Emitter();
    let calls = 0;
    emitter.once('tick', () => void calls++);
    await emitter.emit('tick');
    await emitter.emit('tick');
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(emitter.eventNames(), []);
  });

  await t.test('once alongside on keeps the persistent listener', async () => {
    const emitter = new Emitter();
    const calls = [];
    emitter.on('tick', () => void calls.push('on'));
    emitter.once('tick', () => void calls.push('once'));
    await emitter.emit('tick');
    await emitter.emit('tick');
    assert.deepStrictEqual(calls, ['on', 'once', 'on']);
    assert.strictEqual(emitter.listenerCount('tick'), 1);
  });

  await t.test('off removes one listener, or the whole event', async () => {
    const emitter = new Emitter();
    const listener = () => {};
    emitter.on('a', listener);
    emitter.off('a', listener);
    assert.strictEqual(emitter.listenerCount('a'), 0);
    emitter.off('a', () => {});
    emitter.on('b', listener);
    emitter.off('b');
    assert.deepStrictEqual(emitter.listeners('b'), []);
    emitter.off('missing');
  });

  await t.test('clear drops one event or all of them', () => {
    const emitter = new Emitter();
    emitter.on('a', () => {});
    emitter.on('b', () => {});
    emitter.clear('a');
    assert.deepStrictEqual(emitter.eventNames(), ['b']);
    emitter.clear();
    assert.deepStrictEqual(emitter.eventNames(), []);
  });

  await t.test('duplicate listeners are rejected', () => {
    const emitter = new Emitter();
    const listener = () => {};
    emitter.on('a', listener);
    assert.throws(() => emitter.on('a', listener), /Duplicate listeners/);
  });

  await t.test('maxListeners is enforced', () => {
    const emitter = new Emitter({ maxListeners: 2 });
    emitter.on('a', () => {});
    emitter.on('a', () => {});
    const third = () => {};
    assert.throws(() => emitter.on('a', third), /MaxListenersExceededWarning/);
    assert.strictEqual(emitter.listenerCount('a'), 2, 'the refused listener is not kept');
    emitter.off('a', [...emitter.listeners('a')][0]);
    emitter.on('a', third);
    assert.strictEqual(emitter.listenerCount('a'), 2);
  });

  await t.test('listeners and listenerCount require an event name', () => {
    const emitter = new Emitter();
    assert.throws(() => emitter.listeners(), /Expected eventName/);
    assert.throws(() => emitter.listenerCount(), /Expected eventName/);
    assert.strictEqual(emitter.listenerCount('nothing'), 0);
  });

  await t.test('toPromise resolves on the next emit', async () => {
    const emitter = new Emitter();
    const promise = emitter.toPromise('ready');
    await emitter.emit('ready', 42);
    assert.strictEqual(await promise, 42);
  });
};

module.exports = { runEmitterTests };

'use strict';

// Shared by tests/utils.test.js and tests/utils.browser.test.js — the Emitter
// is byte-identical in both halves, so the contract is asserted once.
const runEmitterTests = async (t, assert, Emitter) => {
  await t.test('a once listener added during an emit is not swept by it: it fires on the next emit', async () => {
    const emitter = new Emitter();
    const calls = [];
    emitter.once('tick', () => {
      calls.push('first');
      emitter.once('tick', () => calls.push('second'));
    });
    await emitter.emit('tick');
    assert.deepStrictEqual(calls, ['first']);
    await emitter.emit('tick');
    assert.deepStrictEqual(calls, ['first', 'second']);
    assert.strictEqual(emitter.listenerCount('tick'), 0);
    // The contained emit the same way.
    const other = new Emitter();
    const seen = [];
    other.once('tock', () => {
      seen.push(1);
      other.once('tock', () => seen.push(2));
    });
    other.dispatch('tock', [], () => {});
    other.dispatch('tock', [], () => {});
    assert.deepStrictEqual(seen, [1, 2]);
  });

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

  await t.test('dispatch calls every listener at once and hands each failure to onError', async () => {
    const emitter = new Emitter();
    const seen = [];
    const failures = [];
    emitter.on('x', (a, b) => void seen.push(['first', a, b]));
    emitter.on('x', () => {
      throw new Error('thrown');
    });
    emitter.on('x', async () => {
      throw new Error('rejected');
    });
    emitter.once('x', (a) => void seen.push(['once', a]));
    emitter.dispatch('x', [1, 2], (error) => void failures.push(error.message));
    // Called before dispatch returns, in order; the rejection lands a tick later.
    assert.deepStrictEqual(seen, [
      ['first', 1, 2],
      ['once', 1],
    ]);
    assert.deepStrictEqual(failures, ['thrown']);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(failures, ['thrown', 'rejected']);
    assert.strictEqual(emitter.listenerCount('x'), 3, 'the once listener left after its call');
    emitter.dispatch('nobody', [], () => assert.fail('no listener, no call'));
  });

  await t.test('a listener added or taken off during an emit counts from the next one', async () => {
    const emitter = new Emitter();
    const seen = [];
    const late = () => void seen.push('late');
    const second = () => void seen.push('second');
    let changed = false;
    emitter.on('x', () => {
      seen.push('first');
      if (changed) return;
      changed = true;
      emitter.off('x', second);
      emitter.on('x', late);
    });
    emitter.on('x', second);
    emitter.dispatch('x', [], assert.fail);
    assert.deepStrictEqual(seen, ['first', 'second']);
    seen.length = 0;
    await emitter.emit('x');
    assert.deepStrictEqual(seen, ['first', 'late']);
  });

  await t.test('toPromise resolves on the next emit', async () => {
    const emitter = new Emitter();
    const promise = emitter.toPromise('ready');
    await emitter.emit('ready', 42);
    assert.strictEqual(await promise, 42);
  });
};

module.exports = { runEmitterTests };

'use strict';

// Layered backends (@alexify/syncom/layered): `layered([top, …, bottom],
// options)` is one fsi over several — a memory layer over the disk, the disk
// over a remote store — that reads as a multi-level cache and writes to every
// layer in list order.
//
// - `read`: the first layer that has the file answers, top down; with `fill`
//   (the default) the content is copied into every layer above it, so the
//   next read is a hit at the top.
// - `exists`: the first layer that has it. `list`: the union of every
//   layer's names, sorted.
// - `write`, `remove`: every layer, top to bottom. Under `write: 'through'`
//   (the default) the call resolves when the last layer has the file —
//   durability is the bottom's. Under `write: 'back'` it resolves when the
//   FIRST layer has it, and the lower layers are written from a queue, one
//   call at a time, at most `queue` calls waiting (the next write waits for
//   room); `flush()` awaits the queue and reports a call of it that failed,
//   `close()` flushes and closes the layers that close. What the queue holds
//   is lost with the process: the window is the queue.
// - `create` (exclusive, the lock's): refused with EEXIST when ANY layer has
//   the file, else written to every layer at once — a lock on the disk is a
//   lock, whatever the memory above it holds.
// - `sync`: every layer that has one, so `durable` reaches the disk.
// - `append`: when every layer has one, every layer in order, as a write. A
//   file only a lower layer holds is copied up first, so the top never
//   holds the tail of a file without its head.
//
// Under 'back' a queued write or removal has not reached the lower layers
// yet, so an operation that would consult them — a read that misses the
// top, `exists`, `list`, `create`, `sync` — first drains the queue: nothing
// stale is ever read from below, and a read that hits the top never waits.
// Requires the backend contract only.

const { checkFsi } = require('../backend.js');

const exists = (key) => Object.assign(new Error(`EEXIST: file already exists, ${key}`), { code: 'EEXIST' });

/**
 * One backend over several: a read is the first hit, top down (filled
 * upward); a write lands on every layer in order, through or from a queue.
 */
const layered = (layers, options = {}) => {
  if (!Array.isArray(layers) || layers.length === 0) {
    throw new TypeError('layered() takes an array of one backend or more');
  }
  const stack = layers.map((layer, i) => checkFsi(layer, `layered() layer ${i}`));
  if (options === null || typeof options !== 'object') throw new TypeError('layered() takes an options object');
  const { write = 'through', fill = true, queue = 1024 } = options;
  if (write !== 'through' && write !== 'back') throw new TypeError("layered(): write must be 'through' or 'back'");
  if (typeof fill !== 'boolean') throw new TypeError('layered(): fill must be a boolean');
  if (!Number.isInteger(queue) || queue < 1) throw new TypeError('layered(): queue must be a positive integer');
  const back = write === 'back';
  const [top, ...lower] = stack;

  // The write-back queue: one call runs at a time, in order; `waiting` is
  // what has not started, and a caller past the bound waits for room. A call
  // that failed is kept for the next drain to report, once.
  let chain = Promise.resolve();
  let waiting = 0;
  let pending = 0;
  let failure = null;
  const room = [];
  const enqueue = async (task) => {
    // Past the bound: wait for a queued call to start (the task wakes one waiter).
    while (true) {
      if (waiting < queue) break;
      await new Promise((resolve) => room.push(resolve));
    }
    waiting++;
    pending++;
    chain = chain.then(async () => {
      waiting--;
      room.shift()?.();
      try {
        await task();
      } catch (error) {
        failure ??= error;
      } finally {
        pending--;
      }
    });
  };
  const drain = async () => {
    if (!back) return;
    await chain;
    if (failure !== null) {
      const error = failure;
      failure = null;
      throw error;
    }
  };
  const everyLower = async (call) => {
    for (const layer of lower) await call(layer);
  };
  // The top first; the rest through, or from the queue.
  const spread = async (call) => {
    await call(top);
    if (back) await enqueue(() => everyLower(call));
    else await everyLower(call);
  };
  const fillUp = async (index, dir, name, content) => {
    for (let i = index - 1; i >= 0; i--) await stack[i].write(dir, name, content);
  };

  const wrapped = {
    layers: Object.freeze([...stack]),
    /** Calls queued or running under `write: 'back'`. */
    get pending() {
      return pending;
    },
    async read(dir, name) {
      if (await top.exists(dir, name)) return top.read(dir, name);
      await drain();
      for (let i = 1; i < stack.length; i++) {
        if (!(await stack[i].exists(dir, name))) continue;
        const content = await stack[i].read(dir, name);
        if (fill) await fillUp(i, dir, name, content);
        return content;
      }
      // Absent everywhere: the bottom raises its own not-found error.
      return stack[stack.length - 1].read(dir, name);
    },
    async write(dir, name, content, writeOptions) {
      await spread((layer) => layer.write(dir, name, content, writeOptions));
    },
    async exists(dir, name) {
      if (await top.exists(dir, name)) return true;
      await drain();
      for (const layer of lower) if (await layer.exists(dir, name)) return true;
      return false;
    },
    async remove(dir, name) {
      await spread((layer) => layer.remove(dir, name));
    },
    async list(dir) {
      await drain();
      const names = new Set();
      for (const layer of stack) for (const name of await layer.list(dir)) names.add(name);
      return [...names].sort();
    },
    async create(dir, name, content) {
      await drain();
      for (const layer of stack) if (await layer.exists(dir, name)) throw exists(`${dir}/${name}`);
      for (const layer of stack) {
        if (typeof layer.create === 'function') await layer.create(dir, name, content);
        else await layer.write(dir, name, content);
      }
    },
    /** Awaits what the write-back queue holds; rejects with the first call of it that failed. */
    async flush() {
      await drain();
    },
    /** Flushes, then closes every layer that has a `close()`. */
    async close() {
      await drain();
      for (const layer of stack) if (typeof layer.close === 'function') await layer.close();
    },
  };
  if (stack.some((layer) => typeof layer.sync === 'function')) {
    wrapped.sync = async (dir, name) => {
      await drain();
      for (const layer of stack) if (typeof layer.sync === 'function') await layer.sync(dir, name);
    };
  }
  if (stack.every((layer) => typeof layer.append === 'function')) {
    wrapped.append = async (dir, name, content) => {
      // A file the top lacks may be below it: its head goes up first.
      if (!(await top.exists(dir, name))) {
        await drain();
        for (let i = 1; i < stack.length; i++) {
          if (!(await stack[i].exists(dir, name))) continue;
          await fillUp(i, dir, name, await stack[i].read(dir, name));
          break;
        }
      }
      await spread((layer) => layer.append(dir, name, content));
    };
  }
  return wrapped;
};

module.exports = { layered };

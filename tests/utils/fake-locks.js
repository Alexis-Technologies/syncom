'use strict';

// Web Locks in memory: `request(name, { mode, ifAvailable }, callback)` holds
// `name` for as long as the callback's promise is pending and hands it to the
// next in line; `ifAvailable` answers the callback `null` instead of waiting.
// One process, so two instances in one test contend as two tabs would.

const createFakeLocks = () => {
  const held = new Map();
  const queues = new Map();
  const grant = (name) => {
    const queue = queues.get(name);
    if (queue === undefined || queue.length === 0) return;
    const next = queue.shift();
    held.set(name, next);
    next.run();
  };
  const locks = {
    held: (name) => held.has(name),
    waiting: (name) => queues.get(name)?.length ?? 0,
    request(name, options, callback) {
      if (typeof options === 'function') [options, callback] = [{}, options];
      return new Promise((resolve, reject) => {
        const entry = {
          run: async () => {
            try {
              resolve(await callback({ name, mode: 'exclusive' }));
            } catch (error) {
              reject(error);
            } finally {
              held.delete(name);
              grant(name);
            }
          },
        };
        if (held.has(name)) {
          if (options?.ifAvailable) return void Promise.resolve(callback(null)).then(resolve, reject);
          let queue = queues.get(name);
          if (queue === undefined) queues.set(name, (queue = []));
          queue.push(entry);
          return;
        }
        held.set(name, entry);
        entry.run();
      });
    },
  };
  return locks;
};

module.exports = { createFakeLocks };

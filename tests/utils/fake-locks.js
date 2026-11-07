'use strict';

// Web Locks in memory: `request(name, { mode, ifAvailable, steal }, callback)`
// holds `name` for as long as the callback's promise is pending and hands it
// to the next in line; `ifAvailable` answers the callback `null` instead of
// waiting; `steal` takes the lock from its holder, whose request rejects
// with an AbortError as the platform's does. One process, so two instances
// in one test contend as two tabs would.

const aborted = () => Object.assign(new Error('The lock was stolen'), { name: 'AbortError' });

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
          stolen: false,
          reject,
          run: async () => {
            try {
              const value = await callback({ name, mode: 'exclusive' });
              if (!entry.stolen) resolve(value);
            } catch (error) {
              if (!entry.stolen) reject(error);
            } finally {
              if (!entry.stolen) {
                held.delete(name);
                grant(name);
              }
            }
          },
        };
        if (held.has(name)) {
          if (options?.ifAvailable) return void Promise.resolve(callback(null)).then(resolve, reject);
          if (options?.steal) {
            const holder = held.get(name);
            holder.stolen = true;
            holder.reject(aborted());
            held.set(name, entry);
            entry.run();
            return;
          }
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

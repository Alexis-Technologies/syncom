'use strict';

// A Supabase client in memory: one table of rows keyed by a primary key,
// the query builder the adapter speaks — `from(table).select().gt().order()
// .limit()`, `.eq().maybeSingle()`, `insert().select()`, `update().eq().eq()
// .select()` — each awaited into `{ data, error }`, and Realtime's
// `channel().on('postgres_changes').subscribe()` told of every write.

const clone = (value) => JSON.parse(JSON.stringify(value));

const createFakeSupabase = ({ primaryKey = 'id' } = {}) => {
  const tables = new Map();
  const channels = new Set();
  // The "database's" clock for the modified column: text that sorts as it was written.
  let ticks = 0;
  const stamp = () => `${String(Date.now()).padStart(15, '0')}-${String(++ticks).padStart(6, '0')}`;
  const rows = (table) => {
    let held = tables.get(table);
    if (held === undefined) tables.set(table, (held = new Map()));
    return held;
  };
  const changed = (table) => {
    for (const channel of channels) if (channel.table === table) channel.fire();
  };
  const builder = (table) => {
    const state = { op: 'select', filters: [], order: null, limit: null, values: null, single: false };
    const matches = (row) =>
      state.filters.every(([kind, column, value]) => (kind === 'eq' ? row[column] === value : row[column] > value));
    const run = () => {
      const held = rows(table);
      if (state.op === 'insert') {
        const out = [];
        for (const values of state.values) {
          if (held.has(values[primaryKey])) {
            return {
              data: null,
              error: { code: '23505', message: `duplicate key value violates unique constraint "${table}_pkey"` },
            };
          }
          held.set(values[primaryKey], clone(values));
          out.push(clone(values));
        }
        changed(table);
        return { data: out, error: null };
      }
      if (state.op === 'update') {
        const out = [];
        for (const [key, row] of held) {
          if (!matches(row)) continue;
          const next = { ...row, ...clone(state.values) };
          held.set(key, next);
          out.push(clone(next));
        }
        if (out.length > 0) changed(table);
        return { data: out, error: null };
      }
      let out = [];
      for (const row of held.values()) if (matches(row)) out.push(clone(row));
      if (state.order !== null) {
        const { column, ascending } = state.order;
        out.sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (ascending ? 1 : -1));
      }
      if (state.limit !== null) out = out.slice(0, state.limit);
      if (state.single) return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    };
    const api = {
      select() {
        return api;
      },
      insert(values) {
        state.op = 'insert';
        state.values = Array.isArray(values) ? values : [values];
        return api;
      },
      update(values) {
        state.op = 'update';
        state.values = values;
        return api;
      },
      eq(column, value) {
        state.filters.push(['eq', column, value]);
        return api;
      },
      gt(column, value) {
        state.filters.push(['gt', column, value]);
        return api;
      },
      order(column, { ascending = true } = {}) {
        state.order = { column, ascending };
        return api;
      },
      limit(n) {
        state.limit = n;
        return api;
      },
      maybeSingle() {
        state.single = true;
        return api;
      },
      then(resolve, reject) {
        return Promise.resolve().then(run).then(resolve, reject);
      },
    };
    return api;
  };
  const client = {
    from: (table) => builder(table),
    channel(name) {
      const channel = {
        name,
        table: null,
        handler: null,
        on(_event, { table }, handler) {
          channel.table = table;
          channel.handler = handler;
          return channel;
        },
        status: null,
        subscribe(status = null) {
          channels.add(channel);
          channel.status = status;
          status?.('SUBSCRIBED');
          return channel;
        },
        unsubscribe() {
          channels.delete(channel);
          channel.status?.('CLOSED');
        },
        fire() {
          channel.handler?.({ eventType: 'UPDATE' });
        },
      };
      return channel;
    },
    removeChannel(channel) {
      channels.delete(channel);
      channel.status?.('CLOSED');
    },
    /** Every channel told of a status (`CHANNEL_ERROR`, `TIMED_OUT`): what Realtime does when the socket drops. */
    failChannels(status = 'CHANNEL_ERROR') {
      for (const channel of [...channels]) channel.status?.(status);
    },
    /** A write on the table itself: another client's. `modified` is set by the "database" (a trigger). */
    write(table, values, { modifiedColumn = 'updated_at', deletedColumn = 'deleted', deleted = false } = {}) {
      const held = rows(table);
      const row = { ...clone(values), [deletedColumn]: deleted, [modifiedColumn]: stamp() };
      held.set(values[primaryKey], row);
      changed(table);
      return clone(row);
    },
    read(table, id) {
      const row = rows(table).get(id);
      return row === undefined ? null : clone(row);
    },
    channels,
    tables,
    stamp,
  };
  return client;
};

module.exports = { createFakeSupabase };

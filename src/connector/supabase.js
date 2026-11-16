'use strict';

// The Supabase adapter (@alexify/syncom/connector/supabase): the handlers
// `replicate()` takes, over one table reached through the injected client
// (`@supabase/supabase-js`, or anything with its `from().select()…` shape).
// The table has a primary key column (`id`), a `deleted` boolean and a
// `modified` text column the database sets on every write (an `updated_at`
// with a trigger, or the adapter's own stamp): a pull is the rows `modified`
// after the checkpoint, in that order; a push is an `update` matched on the
// primary key and the `modified` this adapter last saw (PostgREST's
// compare-and-set: no row matched is a conflict), or an `insert` for a row
// never seen (a duplicate key is a conflict); a conflict is answered as the
// row stands; an error of the database's with a code (a constraint, a type)
// is that row's `{ id, error }`; a probe (`assumed` undefined) is the row
// read back, nothing written. The stream is Realtime's `postgres_changes` on
// the table, every change a `RESYNC`, the channel's error, timeout or close
// an `END`. With `lookback` ms a pull run starts that far before its
// checkpoint — a row that became visible late, a transaction that committed
// after a newer stamp was pulled, is pulled after all (lookback.js; the
// modified column must read as a date). Requires lookback.js only.

const { checkLookback, lookbackPull } = require('./lookback.js');

const OVER = new Set(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']);

/**
 * `{ pull, push }` for `replicate()`. `client.from(table)` is the table;
 * `primaryKey` (`id`), `modifiedColumn` (`updated_at`) and `deletedColumn`
 * (`deleted`) name the columns; `channel` (`syncom:<table>`) the Realtime
 * channel, `stream: false` for none; `lookback` the milliseconds a pull run
 * starts before its checkpoint (0: none).
 */
const supabase = ({
  client,
  table,
  primaryKey = 'id',
  modifiedColumn = 'updated_at',
  deletedColumn = 'deleted',
  schema = 'public',
  channel = null,
  stream = true,
  lookback = 0,
  now = () => new Date().toISOString(),
} = {}) => {
  if (client === null || typeof client !== 'object' || typeof client.from !== 'function') {
    throw new TypeError('supabase(): client must be a Supabase client (from)');
  }
  if (typeof table !== 'string' || table.length === 0) throw new TypeError('supabase(): table is required');
  for (const [name, value] of [
    ['primaryKey', primaryKey],
    ['modifiedColumn', modifiedColumn],
    ['deletedColumn', deletedColumn],
  ]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`supabase(): ${name} must be a column name`);
    }
  }
  if (typeof stream !== 'boolean') throw new TypeError('supabase(): stream must be a boolean');
  checkLookback('supabase', lookback);
  const stamps = new Map();

  const answered = (result, what) => {
    if (result?.error) {
      const error = new Error(`Supabase ${what} failed: ${result.error.message ?? String(result.error)}`);
      error.cause = result.error;
      throw error;
    }
    return result?.data ?? null;
  };

  const strip = (row) => {
    const data = {};
    for (const key of Object.keys(row)) {
      if (key !== primaryKey && key !== modifiedColumn && key !== deletedColumn) data[key] = row[key];
    }
    return data;
  };

  const documentOf = (row) => {
    const id = String(row[primaryKey]);
    if (typeof row[modifiedColumn] === 'string') stamps.set(id, row[modifiedColumn]);
    return row[deletedColumn] === true ? { id, deleted: true } : { id, data: strip(row) };
  };

  const current = async (id) => {
    const result = await client.from(table).select('*').eq(primaryKey, id).maybeSingle();
    const row = answered(result, 'select');
    if (row === null) {
      stamps.delete(id);
      return { id, deleted: true };
    }
    return documentOf(row);
  };

  // The rows after a position, in the cursor's order. The cursor is (stamp, id): the rows modified after the
  // position's stamp, and those modified at it with a greater key — a transaction's rows share one `now()`, and a
  // page's edge never skips the rest of them; a position with no id (a lookback's start) is the stamp alone.
  const read = async (after, limit) => {
    const m = modifiedColumn;
    let query = client.from(table).select('*');
    if (after !== null && after.id === null) query = query.gt(m, after.at);
    else if (after !== null) {
      query = query.or(`${m}.gt."${after.at}",and(${m}.eq."${after.at}",${primaryKey}.gt."${after.id}")`);
    }
    query = query.order(m, { ascending: true }).order(primaryKey, { ascending: true }).limit(limit);
    return answered(await query, 'select') ?? [];
  };
  // A checkpoint's position: `{ at, id }`, or the first version's stamp alone.
  const parse = (value) => {
    if (typeof value === 'string') return { at: value, id: '' };
    return value !== null && typeof value === 'object' && typeof value.at === 'string'
      ? { at: value.at, id: String(value.id) }
      : null;
  };
  const positionOf = (row) =>
    typeof row[modifiedColumn] === 'string' ? { at: row[modifiedColumn], id: String(row[primaryKey]) } : null;

  return {
    pull: {
      handler:
        lookback > 0
          ? lookbackPull({
              lookback,
              parse,
              millis: (position) => Date.parse(position.at),
              since: (ms) => ({ at: new Date(Math.max(ms, 0)).toISOString(), id: null }),
              read,
              positionOf,
              documentOf,
            })
          : async (checkpoint, batchSize) => {
              const after = parse(checkpoint);
              const rows = await read(after, batchSize);
              const documents = [];
              let last = after;
              for (let i = 0; i < rows.length; i++) {
                documents.push(documentOf(rows[i]));
                last = positionOf(rows[i]) ?? last;
              }
              return { documents, checkpoint: last };
            },
      ...(stream && typeof client.channel === 'function'
        ? {
            stream(emit) {
              const name = channel ?? `syncom:${table}`;
              let stopped = false;
              const subscription = client
                .channel(name)
                .on('postgres_changes', { event: '*', schema, table }, () => emit('RESYNC'))
                // The channel erring, timing out or closing on its own is over: followed again after a backoff.
                .subscribe((status) => {
                  if (!stopped && OVER.has(status)) emit('END');
                });
              return () => {
                stopped = true;
                if (typeof client.removeChannel === 'function') client.removeChannel(subscription);
                else subscription.unsubscribe?.();
              };
            },
          }
        : {}),
    },
    push: {
      async handler(rows) {
        const conflicts = [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          // A probe: the row as it stands, nothing written.
          if (row.assumed === undefined) {
            conflicts.push(await current(row.id));
            continue;
          }
          const stamp = now();
          const values = {
            ...(row.deleted ? {} : row.data),
            [primaryKey]: row.id,
            [deletedColumn]: row.deleted,
            [modifiedColumn]: stamp,
          };
          const held = stamps.get(row.id);
          const result =
            held === undefined
              ? await client.from(table).insert(values).select()
              : await client.from(table).update(values).eq(primaryKey, row.id).eq(modifiedColumn, held).select();
          let landed;
          if (result?.error && typeof result.error.code === 'string') {
            // A duplicate key is the conflict (the row read back); another code of the database's — a constraint,
            // a type — is the row refused by name. An error without a code (the network) is the push's failure.
            if (result.error.code === '23505' || /duplicate/i.test(result.error.message ?? '')) landed = [];
            else {
              conflicts.push({ id: row.id, error: { code: result.error.code, message: result.error.message ?? '' } });
              continue;
            }
          } else landed = answered(result, held === undefined ? 'insert' : 'update') ?? [];
          if (landed.length > 0) {
            // The stamp as the database stored it — a trigger's, not this adapter's — is what the next update matches.
            const stored = landed[0]?.[modifiedColumn];
            stamps.set(row.id, typeof stored === 'string' ? stored : stamp);
            continue;
          }
          conflicts.push(await current(row.id));
        }
        return conflicts;
      },
    },
    /** The `modified` stamp this adapter last saw for a row, or undefined. */
    stampOf: (id) => stamps.get(id),
  };
};

module.exports = { supabase };

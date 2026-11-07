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
// an `END`. No requires.

const OVER = new Set(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']);

/**
 * `{ pull, push }` for `replicate()`. `client.from(table)` is the table;
 * `primaryKey` (`id`), `modifiedColumn` (`updated_at`) and `deletedColumn`
 * (`deleted`) name the columns; `channel` (`syncom:<table>`) the Realtime
 * channel, `stream: false` for none.
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

  return {
    pull: {
      async handler(checkpoint, batchSize) {
        let query = client.from(table).select('*');
        if (typeof checkpoint === 'string') query = query.gt(modifiedColumn, checkpoint);
        query = query.order(modifiedColumn, { ascending: true }).limit(batchSize);
        const rows = answered(await query, 'select') ?? [];
        const documents = [];
        let last = typeof checkpoint === 'string' ? checkpoint : null;
        for (let i = 0; i < rows.length; i++) {
          documents.push(documentOf(rows[i]));
          const stamp = rows[i][modifiedColumn];
          if (typeof stamp === 'string' && (last === null || stamp > last)) last = stamp;
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
            stamps.set(row.id, stamp);
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

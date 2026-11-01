'use strict';

// The MongoDB engine (@alexify/syncom/mongodb `mongoEngine()`): the engine
// contract of src/engine.js over one MongoDB database — the driver's client
// injected, never required (syncom takes no dependency). Six collections
// hold every database opened through the engine, each document keyed by the
// database's path first; a write set is a bulk write per collection it
// touches — inside one session transaction under `transactions: true` (a
// replica set), in order otherwise, where a set that fails midway is landed
// again by the replay (every put is an upsert, so the second landing is the
// first); a group of the op log is one bulk write that first wipes every
// document at or past its first seq — what a group whose acknowledgement
// was lost left behind — and `load` leaves out a newest group short of its
// documents (never acknowledged: its seqs were taken back); another process hears
// every write through a change stream (`db.changes`, a replica set too),
// its own writes told apart by the writer's token on each document. One
// instance holds a database by a lease on the server's clock, and every
// document a handle writes carries the lease's generation (`gen`): a put or
// a removal never reaches a document of a newer lease (the fence). Nothing
// here opens or closes a connection: the client is the caller's. Requires
// engine.js and errors.js only.
//
//   collection  _id (the key as JSON)   fields beside it
//   kv          [p, ns, key]            p, ns, key, v, gen — the small named texts (node.json, schema.json, the keys, the lock…)
//   records     [p, id]                 p, id, t, w, gen — the record's JSON as the engine was handed it, the writer's token
//   pieces      [p, id, name]           p, id, name, t, gen — the runs of a large block
//   copies      [p, tag, id]            p, tag, id, t, gen — a tag's copies of records
//   log         [p, seq]                p, seq, first, last, e, w, gen — an entry of the op log (JSON), the first and last seq of its group
//   meta        [p, key]                p, key, v, gen — the log's index and sealed segments
//   locks       p                       owner, gen, expires — the lease: its holder's token, its generation, when it lapses (a Date, the server's)
//
// A point read is `findOne({ _id })`; a range is the flat fields over an
// index (`{ p, id: { $gt } }` sorted by `id` over `{ p: 1, id: 1 }`).

const { capabilitiesOf } = require('../engine.js');
const { SyncomError } = require('../errors.js');

const COLLECTIONS = ['kv', 'records', 'pieces', 'copies', 'log', 'meta'];
// A lease per database path: `{ _id: path, owner, gen, expires }`, renewed by its holder, taken once it lapsed.
const LOCKS = 'locks';
const DEFAULT_LEASE = 30_000;
const INDEXES = {
  kv: { p: 1, ns: 1, key: 1 },
  records: { p: 1, id: 1 },
  pieces: { p: 1, id: 1 },
  copies: { p: 1, tag: 1, id: 1 },
  log: { p: 1, seq: 1 },
  meta: { p: 1, key: 1 },
};
const DUPLICATE = 11000;
// A duplicate key as the driver reports it: the code on the error, or on the first write error of a bulk.
const isDuplicate = (error) => error?.code === DUPLICATE || error?.writeErrors?.[0]?.code === DUPLICATE;

const locked = (path, why = 'is leased by another instance') =>
  new SyncomError('LOCKED', `Storage at ${path} ${why}`, { path });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const exists = (key) => Object.assign(new Error(`EEXIST: key already exists, ${key}`), { code: 'EEXIST' });
const unreadable = (id) =>
  new SyncomError('INTEGRITY', `Storage record ${id} is unreadable`, { id, cause: null, reason: 'unreadable' });

// A record's text read back: the object it parses to, or INTEGRITY.
const parsed = (id, text) => {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw unreadable(id);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw unreadable(id);
  return value;
};

// The `_id` of a document: its key as JSON, the path first.
const keyOf = (parts) => JSON.stringify(parts);
// The key back from an `_id`, or null for one that is no key of ours.
const partsOf = (_id) => {
  if (typeof _id !== 'string' || _id[0] !== '[') return null;
  try {
    const parts = JSON.parse(_id);
    return Array.isArray(parts) && typeof parts[0] === 'string' ? parts : null;
  } catch {
    return null;
  }
};

const sorted = (docs, field) => {
  const out = [];
  for (let i = 0; i < docs.length; i++) out.push(docs[i][field]);
  return out.sort();
};

const token = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * `mongoEngine({ client, db, name, transactions, changes })` — the engine over
 * MongoDB: `client` is the driver's `MongoClient` (connected; the driver 6 or
 * later), `name` the database every path lives in (`'syncom'`); `db` a `Db`
 * in place of the two. `transactions: true` lands a write set in one session
 * transaction (a replica set; `atomicBatch`); `changes: false` says the
 * deployment has no change streams (a standalone server). `destroy()` drops
 * the database.
 */
const mongoEngine = ({ client = null, db = null, name = 'syncom', transactions = false, changes = true } = {}) => {
  if (db === null && (client === null || typeof client?.db !== 'function')) {
    throw new TypeError('mongoEngine: pass the driver’s client ({ client }) or a database ({ db })');
  }
  if (transactions && typeof client?.startSession !== 'function') {
    throw new TypeError('mongoEngine: transactions need the client ({ client }), whose sessions they run in');
  }
  const database = db ?? client.db(name);
  if (typeof database?.collection !== 'function') throw new TypeError('mongoEngine: the database has no collection()');
  const capabilities = capabilitiesOf({
    atomicBatch: transactions,
    exclusiveCreate: true,
    changeStream: changes,
    lock: 'native',
    shared: true,
  });
  const c = {};
  for (let i = 0; i < COLLECTIONS.length; i++) c[COLLECTIONS[i]] = database.collection(COLLECTIONS[i]);
  const locks = database.collection(LOCKS);
  let indexed = null;

  // The indexes behind every range, made once per engine (idempotent on the server).
  const ensure = () => {
    indexed ??= (async () => {
      for (let i = 0; i < COLLECTIONS.length; i++) {
        const collection = c[COLLECTIONS[i]];
        if (typeof collection.createIndex === 'function') await collection.createIndex(INDEXES[COLLECTIONS[i]]);
      }
    })().catch((error) => {
      indexed = null;
      throw error;
    });
    return indexed;
  };

  // One write set's statements under `fn(session)`: a transaction where asked, in order otherwise.
  const within = async (fn) => {
    await ensure();
    if (!transactions) return fn(undefined);
    const session = client.startSession();
    try {
      return await session.withTransaction(() => fn(session));
    } finally {
      await session.endSession();
    }
  };
  const bulk = async (collection, ops, session) => {
    if (ops.length === 0) return;
    await collection.bulkWrite(ops, session === undefined ? { ordered: true } : { ordered: true, session });
  };
  const one = async (collection, _id, projection) => {
    await ensure();
    return collection.findOne({ _id }, { projection });
  };
  const many = async (collection, filter, options) => {
    await ensure();
    // oxlint-disable-next-line no-restricted-properties -- the driver's query, not Array#find
    return collection.find(filter, options).toArray();
  };

  const openDb = async (p) => {
    await ensure();
    // The fence: every document this handle writes carries `gen`, the
    // generation of the lease — the one `lock()` takes, until then the one
    // the lease document holds (a handle that never locks writes as the
    // current holder's generation; 0 where nothing ever held the path) —
    // and no put or removal of this handle's matches a document of a newer
    // one: the upsert then tries an insert, the `_id` collides, and the
    // statement — the ordered bulk, the write set, the log's group — fails
    // as LEASE_LOST. Under transactions the lease is checked first, inside
    // the transaction, where the handle holds one.
    let gen = (await locks.findOne({ _id: p }, { projection: { _id: 0, gen: 1 } }))?.gen ?? 0;
    let owner = null;
    // The writer's token on every record and log document — one per handle, so two handles of one engine tell each other apart.
    const writer = token();
    const fence = () => ({ gen: { $not: { $gt: gen } } });
    const put = (_id, doc) => ({
      updateOne: { filter: { _id, ...fence() }, update: { $set: { ...doc, gen } }, upsert: true },
    });
    const del = (_id) => ({ deleteOne: { filter: { _id, ...fence() } } });
    const leaseLost = (cause) =>
      new SyncomError('LEASE_LOST', `Storage at ${p}: a newer lease holds the document, the write was refused`, {
        path: p,
        cause,
      });
    // Every statement of this handle: under the fence, in a transaction where asked.
    const fenced = async (fn) => {
      try {
        return await within(async (session) => {
          if (session !== undefined && owner !== null) {
            const held = await locks.findOne({ _id: p, owner, gen }, { session, projection: { _id: 1 } });
            if (held === null) throw leaseLost(null);
          }
          return fn(session);
        });
      } catch (error) {
        throw isDuplicate(error) ? leaseLost(error) : error;
      }
    };

    const kv = {
      get: async (ns, key) => (await one(c.kv, keyOf([p, ns, key]), { _id: 0, v: 1 }))?.v ?? null,
      has: async (ns, key) => (await one(c.kv, keyOf([p, ns, key]), { _id: 1 })) !== null,
      list: async (ns) => sorted(await many(c.kv, { p, ns }, { projection: { _id: 0, key: 1 } }), 'key'),
      put: (ns, key, value) =>
        fenced((session) => bulk(c.kv, [put(keyOf([p, ns, key]), { p, ns, key, v: String(value) })], session)),
      remove: (ns, key) => fenced((session) => bulk(c.kv, [del(keyOf([p, ns, key]))], session)),
      // The exclusive create the lock prefers: an insert, refused on the key's unique `_id`.
      create: async (ns, key, value) => {
        await ensure();
        const _id = keyOf([p, ns, key]);
        try {
          await c.kv.insertOne({ _id, p, ns, key, v: String(value), gen });
        } catch (error) {
          throw isDuplicate(error) ? exists(`${ns}/${key}`) : error;
        }
      },
    };

    const records = {
      get: async (id) => {
        const doc = await one(c.records, keyOf([p, id]), { _id: 0, t: 1 });
        return doc === null ? null : parsed(id, doc.t);
      },
      raw: async (id) => (await one(c.records, keyOf([p, id]), { _id: 0, t: 1 }))?.t ?? null,
      has: async (id) => (await one(c.records, keyOf([p, id]), { _id: 1 })) !== null,
      // One query over the keys (`$in`), the result in the order asked.
      getMany: async (ids) => {
        const keys = [];
        for (let i = 0; i < ids.length; i++) keys.push(keyOf([p, ids[i]]));
        const docs = await many(c.records, { _id: { $in: keys } }, { projection: { _id: 0, id: 1, t: 1 } });
        const texts = new Map();
        for (let i = 0; i < docs.length; i++) texts.set(docs[i].id, docs[i].t);
        const found = new Map();
        for (let i = 0; i < ids.length; i++) {
          const text = texts.get(ids[i]);
          if (text !== undefined) found.set(ids[i], parsed(ids[i], text));
        }
        return found;
      },
      ids: async ({ after = null, limit = Infinity } = {}) => {
        const filter = after === null ? { p } : { p, id: { $gt: after } };
        const options = { projection: { _id: 0, id: 1 }, sort: { id: 1 } };
        if (limit !== Infinity) options.limit = limit;
        const docs = await many(c.records, filter, options);
        const ids = [];
        for (let i = 0; i < docs.length; i++) ids.push(docs[i].id);
        return ids;
      },
    };

    const pieces = {
      get: async (id, name) => (await one(c.pieces, keyOf([p, id, name]), { _id: 0, t: 1 }))?.t ?? null,
      remove: (id, name) => fenced((session) => bulk(c.pieces, [del(keyOf([p, id, name]))], session)),
    };

    const copies = {
      get: async (tag, id) => (await one(c.copies, keyOf([p, tag, id]), { _id: 0, t: 1 }))?.t ?? null,
      has: async (tag, id) => (await one(c.copies, keyOf([p, tag, id]), { _id: 1 })) !== null,
      ids: async (tag) => sorted(await many(c.copies, { p, tag }, { projection: { _id: 0, id: 1 } }), 'id'),
      put: (tag, id, text) =>
        fenced((session) => bulk(c.copies, [put(keyOf([p, tag, id]), { p, tag, id, t: text })], session)),
      remove: (tag, id) => fenced((session) => bulk(c.copies, [del(keyOf([p, tag, id]))], session)),
      drop: (tag) => fenced((session) => bulk(c.copies, [{ deleteMany: { filter: { p, tag, ...fence() } } }], session)),
    };

    const meta = async (key) => {
      const doc = await one(c.meta, keyOf([p, key]), { _id: 0, v: 1 });
      return doc === null ? null : JSON.parse(doc.v);
    };
    const metaPut = (key, value) => put(keyOf([p, key]), { p, key, v: JSON.stringify(value) });

    // The op log's medium: a document per entry with the first and last seq
    // of its group, the index and the sealed segments in the meta collection.
    const log = (() => {
      let groups = [];
      let segments = [];
      // Seq → its group (`{ first, last }`, one object per group): what a scrub writes a document again with.
      const groupOf = new Map();
      const sealedTo = () => (segments.length > 0 ? segments[segments.length - 1].to : null);
      const row = (entry, group) =>
        put(keyOf([p, entry.seq]), {
          p,
          seq: entry.seq,
          first: group.first,
          last: group.last,
          e: JSON.stringify(entry),
          w: writer,
        });
      // Every document at or past `first`: what a group whose write failed
      // after it landed left — its seqs were taken back and are this group's
      // now. Nothing acknowledged sits there (a seq is handed out once per
      // epoch), so the wipe is the group's first statement, and a best effort
      // after a failure, before the next open could read the leftovers.
      const from = (first) => ({ p, seq: { $gte: first }, ...fence() });
      const wipeFrom = (first) => ({ deleteMany: { filter: from(first) } });
      return {
        journaled: false,
        async load() {
          const index = await meta('index');
          const saved = await meta('segments');
          segments = Array.isArray(saved) ? saved : [];
          const docs = await many(
            c.log,
            { p },
            { projection: { _id: 0, seq: 1, first: 1, last: 1, e: 1 }, sort: { seq: 1 } },
          );
          const byFirst = new Map();
          let newest = null;
          for (let i = 0; i < docs.length; i++) {
            const { seq, first } = docs[i];
            const last = typeof docs[i].last === 'number' ? docs[i].last : seq;
            let group = byFirst.get(first);
            if (group === undefined) byFirst.set(first, (group = { first, last, docs: [] }));
            if (last > group.last) group.last = last;
            if (seq > group.last) group.last = seq;
            group.docs.push(docs[i]);
            if (newest === null || first > newest.first) newest = group;
          }
          // The newest group short of its documents was never acknowledged:
          // its seqs were taken back and handed out again, and what it left
          // is the next group's to wipe — nothing of it is a group.
          if (newest !== null && newest.docs.length < newest.last - newest.first + 1) byFirst.delete(newest.first);
          const entries = [];
          for (const group of byFirst.values()) {
            const held = { first: group.first, last: group.last };
            for (let i = 0; i < group.docs.length; i++) {
              entries.push(JSON.parse(group.docs[i].e));
              groupOf.set(group.docs[i].seq, held);
            }
          }
          const floor = index !== null ? index.floor : entries.length > 0 ? entries[0].seq : 1;
          const sealed = sealedTo() ?? floor - 1;
          groups = [];
          const open = [];
          for (const group of byFirst.values()) {
            if (group.last <= sealed) continue;
            groups.push({ first: group.first, last: group.last });
            const unsealed = [];
            for (let i = 0; i < group.docs.length; i++) {
              if (group.docs[i].seq > sealed) unsealed.push(group.docs[i].seq);
            }
            open.push({ first: group.first, last: group.last, unsealed });
          }
          return { index, hasIndex: index !== null, entries, groups: open, floor, lost: false };
        },
        get sealedTo() {
          return sealedTo();
        },
        get open() {
          return groups.length;
        },
        get segments() {
          return segments;
        },
        get corrupt() {
          return 0;
        },
        get health() {
          return { journaled: false, open: groups.length, torn: 0, lost: false };
        },
        // One ordered bulk write: the wipe from `first`, then an upsert per
        // entry. A write that failed — midway, or after it landed with the
        // acknowledgement lost — leaves what the wipe takes before the next
        // group writes the seqs again; a best effort takes it at once too.
        async append(entries, _headers, { first, last, onFail }) {
          const group = { first, last };
          const ops = [wipeFrom(first)];
          for (let i = 0; i < entries.length; i++) ops.push(row(entries[i], group));
          try {
            await fenced((session) => bulk(c.log, ops, session));
          } catch (error) {
            try {
              await c.log.deleteMany(from(first));
            } catch {
              // The next group wipes it; a reopen before that leaves a group short of its documents out.
            }
            onFail(error);
            return false;
          }
          for (let i = 0; i < entries.length; i++) groupOf.set(entries[i].seq, group);
          groups.push(group);
          return true;
        },
        async seal(entries, from, to) {
          segments.push({ from, to, count: entries.length });
          await fenced((session) => bulk(c.meta, [metaPut('segments', segments)], session));
        },
        async sealed(to) {
          const kept = [];
          for (let i = 0; i < groups.length; i++) if (groups[i].last > to) kept.push(groups[i]);
          groups = kept;
        },
        async drop(segment) {
          if (segments[0] !== segment) throw new TypeError('drop(segment): the oldest segment goes first');
          segments.shift();
          await fenced(async (session) => {
            await bulk(
              c.log,
              [{ deleteMany: { filter: { p, seq: { $gte: segment.from, $lte: segment.to }, ...fence() } } }],
              session,
            );
            await bulk(c.meta, [metaPut('segments', segments)], session);
          });
          for (let seq = segment.from; seq <= segment.to; seq++) groupOf.delete(seq);
        },
        saveIndex: (index) => fenced((session) => bulk(c.meta, [metaPut('index', index)], session)),
        // The documents at `seqs` written again as the entries are now (a scrub stripped them).
        async scrub(seqs, { entriesBetween }) {
          const ops = [];
          for (let i = 0; i < seqs.length; i++) {
            const held = entriesBetween(seqs[i], seqs[i]);
            if (held.length === 1) ops.push(row(held[0], groupOf.get(seqs[i]) ?? { first: seqs[i], last: seqs[i] }));
          }
          if (ops.length > 0) await fenced((session) => bulk(c.log, ops, session));
        },
      };
    })();

    // The records this instance removed, to tell their deletions apart from
    // another instance's (a deletion carries no document, so no token): kept
    // only while a subscription of this handle is live, added once the
    // write landed.
    const deleted = new Set();
    let listening = 0;

    // One write set: a bulk write per collection, kv puts first and kv
    // removals last, the pieces a record makes before it and the ones it
    // drops after it — in one transaction where the engine has them.
    const write = async (batch) => {
      const kvPuts = [];
      const made = [];
      const recordOps = [];
      const removedKeys = [];
      const dropped = [];
      const copied = [];
      const kvDrops = [];
      const puts = batch.kv?.put;
      if (puts !== undefined) {
        for (let i = 0; i < puts.length; i++) {
          const [ns, key, value] = puts[i];
          kvPuts.push(put(keyOf([p, ns, key]), { p, ns, key, v: String(value) }));
        }
      }
      const rows = batch.records;
      if (rows !== undefined) {
        for (let i = 0; i < rows.length; i++) {
          const rowOf = rows[i];
          const id = rowOf.id;
          const makes = rowOf.pieces?.put;
          if (makes !== undefined) {
            for (let k = 0; k < makes.length; k++) {
              made.push(put(keyOf([p, id, makes[k][0]]), { p, id, name: makes[k][0], t: makes[k][1] }));
            }
          }
          const t = rowOf.stored !== undefined ? JSON.stringify(rowOf.stored) : rowOf.text;
          recordOps.push(put(keyOf([p, id]), { p, id, t, w: writer }));
          const drops = rowOf.pieces?.remove;
          if (drops !== undefined) for (let k = 0; k < drops.length; k++) dropped.push(del(keyOf([p, id, drops[k]])));
        }
      }
      const removed = batch.remove;
      if (removed !== undefined) {
        for (let i = 0; i < removed.length; i++) {
          const key = keyOf([p, removed[i]]);
          recordOps.push(del(key));
          removedKeys.push(key);
        }
      }
      const copiesPut = batch.copies?.put;
      if (copiesPut !== undefined) {
        for (let i = 0; i < copiesPut.length; i++) {
          const [tag, id, text] = copiesPut[i];
          copied.push(put(keyOf([p, tag, id]), { p, tag, id, t: text }));
        }
      }
      const removals = batch.kv?.remove;
      if (removals !== undefined) {
        for (let i = 0; i < removals.length; i++) kvDrops.push(del(keyOf([p, removals[i][0], removals[i][1]])));
      }
      if (kvPuts.length + made.length + recordOps.length + dropped.length + copied.length + kvDrops.length === 0) {
        return;
      }
      await fenced(async (session) => {
        await bulk(c.kv, kvPuts, session);
        await bulk(c.pieces, made, session);
        await bulk(c.records, recordOps, session);
        await bulk(c.pieces, dropped, session);
        await bulk(c.copies, copied, session);
        await bulk(c.kv, kvDrops, session);
      });
      if (listening > 0) for (let i = 0; i < removedKeys.length; i++) deleted.add(removedKeys[i]);
    };

    // What another instance over the same database wrote — `{ records: [id] }`
    // or `{ log: [seq, seq] }` per document, this instance's own left out —
    // through a change stream on `records` and on `log`.
    const subscribe = (listener) => {
      const hear = (event, key) => {
        const parts = partsOf(event.documentKey?._id);
        if (parts === null || parts[0] !== p || parts.length !== 2) return;
        if (event.operationType === 'delete') {
          if (deleted.delete(event.documentKey._id)) return;
        } else if (event.fullDocument?.w === writer) return;
        listener(key === 'records' ? { p, records: [parts[1]] } : { p, log: [parts[1], parts[1]] });
      };
      const options = { fullDocument: 'updateLookup' };
      const streams = [c.records.watch([], options), c.log.watch([], options)];
      streams[0].on('change', (event) => hear(event, 'records'));
      streams[1].on('change', (event) => hear(event, 'log'));
      listening++;
      return () => {
        for (let i = 0; i < streams.length; i++) streams[i].close();
        if (--listening === 0) deleted.clear();
      };
    };

    // The lease document made or taken, on the server's clock: `{ gen }` once
    // it is this instance's, null while another holds it.
    const take = async (mine, staleAfter) => {
      try {
        // A path never leased: the document is made with an expiry on this
        // clock — the one round trip the client's clock is trusted for — and
        // set on the server's at once.
        await locks.insertOne({ _id: p, owner: mine, gen: 1, expires: new Date(Date.now() + staleAfter) });
        await locks.updateOne({ _id: p, owner: mine }, [{ $set: { expires: { $add: ['$$NOW', staleAfter] } } }]);
        return { gen: 1 };
      } catch (error) {
        if (!isDuplicate(error)) throw error;
      }
      // Leased before: taken once the server says it lapsed, the generation one up.
      const taken = await locks.findOneAndUpdate(
        { _id: p, $expr: { $lt: ['$expires', '$$NOW'] } },
        [
          {
            $set: {
              owner: mine,
              gen: { $add: [{ $ifNull: ['$gen', 0] }, 1] },
              expires: { $add: ['$$NOW', staleAfter] },
            },
          },
        ],
        { returnDocument: 'after', includeResultMetadata: false },
      );
      // The document (the driver 6 or later); `{ value }` around it on an older one.
      const doc = taken?.value ?? taken;
      return doc !== null && doc !== undefined && doc.owner === mine ? { gen: doc.gen } : null;
    };

    // The lease: one document per path, this instance's while it renews it
    // every third of `staleAfter` on the server's clock; a lapsed one is
    // taken over, a live one is LOCKED (at once, or after `timeout` under
    // 'wait'); lost — taken by another instance, or a renewal that failed —
    // `onLost` hears once. The generation taken is what this handle writes
    // with from here on.
    const lock = async ({
      mode = 'fail',
      staleAfter = DEFAULT_LEASE,
      poll = 100,
      timeout = Infinity,
      onLost = null,
    }) => {
      await ensure();
      const mine = token();
      const deadline = Number.isFinite(timeout) ? Date.now() + timeout : Infinity;
      let held = null;
      for (;;) {
        held = await take(mine, staleAfter);
        if (held !== null) break;
        if (mode === 'fail') throw locked(p);
        if (Date.now() >= deadline) throw locked(p, `is still leased after ${timeout} ms`);
        await sleep(poll);
      }
      const generation = held.gen;
      owner = mine;
      gen = generation;
      let holding = true;
      let timer = null;
      const lost = (error) => {
        if (!holding) return;
        holding = false;
        clearInterval(timer);
        if (onLost !== null) onLost(error);
      };
      const renew = async () => {
        try {
          const result = await locks.updateOne({ _id: p, owner: mine, gen: generation }, [
            { $set: { expires: { $add: ['$$NOW', staleAfter] } } },
          ]);
          if (result.matchedCount === 0) lost(new Error(`the lease on ${p} was taken by another instance`));
        } catch (error) {
          lost(error);
        }
      };
      timer = setInterval(renew, Math.max(10, Math.floor(staleAfter / 3)));
      timer.unref?.();
      return {
        gen: generation,
        async release() {
          if (!holding) return;
          holding = false;
          clearInterval(timer);
          // The document stays, lapsed: the generation counts on from it, so a later holder is a newer one.
          await locks.updateOne({ _id: p, owner: mine, gen: generation }, { $set: { expires: new Date(0) } });
        },
      };
    };

    const engineDb = { path: p, capabilities, kv, records, pieces, copies, log, write, lock, close: async () => {} };
    if (changes) engineDb.changes = { subscribe };
    return Object.freeze(engineDb);
  };

  return Object.freeze({
    name: 'mongodb',
    capabilities,
    /** The MongoDB database every path lives in. */
    database,
    open: (path) => openDb(path),
    /**
     * Every document of the database at `path`, in every collection, its lease document too — in one transaction
     * where the engine has them. The engine's, not a handle's: no fence (the database is closed, by the contract).
     */
    remove: (path) =>
      within(async (session) => {
        for (let i = 0; i < COLLECTIONS.length; i++) {
          await bulk(c[COLLECTIONS[i]], [{ deleteMany: { filter: { p: path } } }], session);
        }
        await locks.deleteOne({ _id: path }, session === undefined ? {} : { session });
      }),
    /** Nothing to close: the client is the caller's. */
    close: async () => {},
    /** Drops the MongoDB database — every path's collections. */
    async destroy() {
      indexed = null;
      await database.dropDatabase();
    },
  });
};

module.exports = { mongoEngine };

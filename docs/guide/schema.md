# Schema and validation

A schema gives a storage its collections, validates every write before it is
stamped, keys the [query layer](./query), and carries a version so nodes on
different versions of it keep working together. syncom validates through a
contract, not a library: anything that implements
[Standard Schema](https://standardschema.dev) (`~standard`), any compiled
validator function, or any object a `validator` you inject can compile.
Nothing is installed alongside it. The schema is the `schema` plugin —
`@alexify/syncom/schema`, registered by `@alexify/syncom/all`; the core alone
refuses `open({ schema })` and `open({ validator })` with `PLUGIN_MISSING`,
and its records are untyped. The examples on this page open the core with it.

## A metaschema model

[metaschema](https://metaschema.vercel.app) is the first-class fit: a `Model`
is one description of the domain for the client, the server and every tool
in between, and each of its entities is a `Schema` that syncom reads
whole — the validator through `~standard`, the indexes off `schema.indexes`
and `unique: true` fields, the id key by the kind's own convention, and the
snapshot for versioning.

```js
const { open } = require('@alexify/syncom');
const { schema } = require('@alexify/syncom/schema');
const { Model } = require('@alexify/metaschema');

const model = new Model(
  {},
  new Map([
    [
      'Project',
      {
        Registry: {},
        orgId: 'string',
        name: { type: 'string', length: { min: 3, max: 100 }, aliases: ['title'] },
        slug: { type: 'string', unique: true },
        'desc?': { type: 'string', default: '' },
        byOrg: { index: ['orgId'] },
        byOrgName: { unique: ['orgId', 'name'] },
      },
    ],
  ]),
);

const storage = await open({
  plugins: [schema],
  path: 'data',
  schema: {
    version: 2,
    snapshot: model.toJSON(),
    entities: Object.fromEntries([...model.entities].map(([name, schema]) => [name, { schema }])),
  },
});

const project = await storage.Project.insert({ title: 'Alioth', slug: 'alioth', orgId: 'org1' });
await storage.get(project.id);
// { name: 'Alioth', slug: 'alioth', orgId: 'org1', desc: '', $type: 'Project' }
//   `title` became `name` (the alias), `desc` was filled (the default)

await storage.Project.insert({ name: 'x', slug: 'alioth', orgId: 'org2' });
// ValidationError: Project failed validation at name: value is too short
await storage.Project.insert({ name: 'Alioth', slug: 'other', orgId: 'org1' });
// ValidationError … code: 'unique', path: ['orgId', 'name'] — byOrgName

await storage.check('Project', { title: 'Vega', slug: 'vega', orgId: 'org1' });
// { name: 'Vega', slug: 'vega', orgId: 'org1', desc: '' } — validated, nothing written
```

What the entity brought with it:

| From the metaschema `Schema` | What syncom does |
| --- | --- |
| `~standard.validate` | Validates every write of the collection; its value — defaults, decoders, aliases resolved — is what is written and replicated |
| `fields.projectId` (the `Registry` kind's id field) | The record id is handed to the validator as `projectId`; a `Struct` without an id-like field is handed none |
| `indexes` (`byOrg: { index }`, `byOrgName: { unique }`) and `slug: { unique: true }` | The catalog's indexes and unique keys; a `many` relation is left alone |
| `model.toJSON()` as `snapshot` | Hashed into `schemaInfo.hash`, exchanged in hello, drift reported |
| `unknown: 'reject'` (metaschema's default) | A key the schema does not know is a `ValidationError` with `code: 'unexpected'`; `Registry: { unknown: 'ignore' }` lets peers on a newer schema add fields |

One model file shared by the web app and the API is the whole point: the
browser validates before it writes, the hub validates the same record with
the same schema when the op arrives, and both reach the same verdict.

## Other validators

The entity's `schema` may be:

- **any Standard Schema** — zod v4, valibot, arktype, metaschema: the
  `~standard` property is all syncom reads. `idField` is read off a `shape`
  (zod) or `entries` (valibot) map the same way as off `fields`. With zod,
  `z.object({ id: z.string(), … })` is handed the id as `id`; a strict object
  without an `id` key takes `idField: false`. Indexes are explicit then —
  `{ schema: ProjectZod, index: ['orgId'], unique: ['slug'] }` — since a zod
  schema has none to read;
- **a function** — an ajv-compiled validator (`false` and `fn.errors`), or
  any function that throws on a bad value and returns the value, or
  nothing, on a good one;
- **a plain object** with `open({ validator })` — a JSON Schema or TypeBox
  object: `validator.compile(schema, { entity })` returns the function above.
  An Ajv instance fits as it is.

```js
const ajv = new Ajv();
const storage = await open({
  path: 'data',
  validator: ajv,                                    // compile(schema) → a validator
  schema: {
    entities: {
      Event: { schema: { type: 'object', properties: { at: { type: 'string' } }, required: ['at'] } },
      Note: { schema: compiledByAjv, idField: false },
      Thin: { schema: definitionOnly, validate: false }, // @alexify/metaschema/definition: indexes read, nothing validated
    },
  },
});
```

Whatever the shape, a failing write rejects with `ValidationError` —
`code: 'VALIDATION_FAILED'`, `entity`, `issues` as `[{ path, message, code? }]`
(ajv's `instancePath` and `keyword` map onto `path` and `code`), `cause` when
the validator threw something of its own — and nothing was stamped, logged
or written. The validator's value is taken as JSON: a `Date` a decoder made
is stored as the string it serializes to.

## How a write is validated

The validator sees the record **as the op leaves it**: for a `write` the
whole new record, for a `set` the whole record after the delta, for an
`inc`, `add`, `remove`, or a list, text or tree write (`splice`, `assign`,
`move`, `mark`, `tree`) the record with that field as it reads after the op —
under its id field, without `$type`. A counter, set, list, text or tree op
carries no record data, so for it the verdict alone counts — and a field the
schema does not name is an unknown key there too, refused under
`unknown: 'reject'` like any other. What the validator returns is folded back
into a `write` or a `set`:

- a `write` becomes the validated record — defaults filled, aliases
  renamed, unknown keys stripped if the validator strips;
- a `set` keeps only the keys it named (in their validated form) and the
  keys whose validated value differs from how the record read before — a
  default on a record that lacked it, an alias target. A delta key the
  validator dropped drops out of the op. A `set` is never promoted to a
  `write`: that would reset the record and erase concurrent sets and
  counters from other peers. So write a field by its own name, not an alias:
  a delta under an alias of a field the record already has changes nothing.

A peer's op is validated here too, against this node's schema, and never
rewritten: an op that would leave the record invalid is skipped — logged,
relayed, replay-safe, exactly as a `beforeApply` returning `false` — and
reported through the `error` event (`error.entity`, `error.issues`) and the
`syncom.ops.rejected` metric with reason `validation`. `merge`, `delete`
and `purge` are not validated.

## Versions

`schema.version` is a positive integer (default 1). Every op this node makes
carries it as `v`, every record remembers the version of its last
whole-record write as `meta.v`, `schema.json` in the directory remembers
what it last ran, and hello exchanges `{ version, hash }` with every peer.
Two nodes on two versions keep syncing: registers are forward-tolerant, and
what differs is how each reads the other's records.

### Reading an older record: the lens

A record written under an older version is read through a lens — nothing is
rewritten, the view is computed once per cached entry — in two steps:

1. **migrations** you wrote, keyed by the version they migrate *to*:
2. the entity's **Standard Schema validator**, whose aliases and defaults are
   a rename and a fill for free.

With a metaschema model, step 2 is often all there is. The `Project` above
went from a v1 with `title` to the v2 with `name: { aliases: ['title'] }` and
`'desc?': { default: '' }`:

```js
const upgraded = await open({ path: 'data', schema: { version: 2, snapshot: model.toJSON(), entities } });

upgraded.schemaInfo.previous;      // { version: 1, hash: '…' } — this directory ran v1
await upgraded.get(legacy);        // { name: 'Old', slug: 'old', orgId: 'org1', desc: '', $type: 'Project' }
upgraded.getCachedData(legacy);    // { title: 'Old', slug: 'old', orgId: 'org1', $type: 'Project' } — raw, as on disk
```

What an alias cannot express is a migration:

```js
const storage = await open({
  path: 'data',
  schema: {
    version: 2,
    entities: { Post: {} },
    migrations: {
      2: { Post: { up: ({ title, ...rest }) => ({ ...rest, name: title }) } }, // per entity
      // 3: { up: (data, { entity, id, from, to }) => data },                   // or storage-wide
    },
  },
});
```

`up` gets the record without `$type` and returns it as it is under the next
version; the chain runs from the record's version up to this one, then the
validator. `lens: 'migrations'` or `'validate'` picks one step (the default
`'both'` runs both; `'validate'` refuses a schema that also has
`migrations`).

The lens applies everywhere a record is read as a record — `get()`,
`swap()`, the [query layer](./query), a `Record` as it loads and as it
follows a change — and to what a write is validated against;
`snapshot()`, `getCachedData()` and replication stay raw.

### Rewriting: `migrate()`

```js
if (storage.schemaInfo.previous) await storage.migrate();
// { migrated: 12, counters: 3, sets: 1, lists: 0, texts: 2, trees: 0 }
```

Every record of an older version becomes a whole-record write of its view,
with the fields of other kinds made again after it (a write resets them) —
an `inc` per counter, an `add` per set, one `splice` per list or text (one
run), one move per tree node; an empty set, list or text and a tree with
nothing to read are dropped. The ops carry this node's version, peers
receive ordinary ops, and a record already of this version is left alone —
idempotent. Run it on one node after an upgrade;
`{ entities: ['Project'] }` limits it, `{ batch }` sets how many records go
between turns of the event loop, `{ actor }` names the writer.

### A newer peer: `ahead`

An op from a newer version than this node runs is `ahead`. `'apply'` (the
default) applies it as it is — unvalidated, since the validator does not
know the shape — and emits `schema` `{ kind: 'ahead', op, held: false }`.
`'hold'` keeps it in the log, flagged with its version and relayed, until an
open runs that version; the held ops are then applied and
`schemaInfo.held = { replayed, lost }` says how many, `lost` counting ops
retention dropped before the upgrade (a hold needs `sync.retention.ops` of
1000 or more, or `0` — keep everything).

### Drift

The same version with another snapshot hash on a peer — two builds of "the
same" schema that disagree — is reported on both sides as the storage's
`schema` event `{ kind: 'drift', peer, version, hash, local }` and a
warning; the link stays up. Under `unknown: 'reject'` a drifted peer's new
field is a validation failure here (the op is skipped); give the entity
`unknown: 'ignore'`, or bump the version. Catch it before it ships —
metaschema's `diff` and `compatibility` are built for the CI gate:

```js
const { diff, compatibility } = require('@alexify/metaschema/model');
compatibility(diff(previousModel, model)); // 'full' | 'backward' | 'forward' | 'none'
```

## The reference

| Option | Where | Meaning |
| --- | --- | --- |
| `schema.version` | `open({ schema })` | A positive integer, default 1; on every op as `v` |
| `schema.snapshot` | `open({ schema })` | Any JSON describing the schema (`model.toJSON()`); hashed, in hello |
| `schema.entities[name]` | `open({ schema })` | `{ schema?, idField?, validate?, index?, unique?, fields?, search? }`; `{}` is a bare collection |
| `schema.entities[name].search` | `open({ schema })` | Field paths `$text` searches; explicit for every validator, never read off a schema; needs `open({ search })` — see [Full-text search](./query#full-text-search) |
| `schema.migrations` | `open({ schema })` | `{ [toVersion]: { up } \| { [entity]: { up } } }` |
| `schema.ahead` | `open({ schema })` | `'apply'` (default) or `'hold'` |
| `schema.lens` | `open({ schema })` | `'both'` (default), `'migrations'`, `'validate'` |
| `validator` | `open({ validator })` | `{ compile(schema, { entity }) }` for plain-object schemas |
| `storage.check(entity, data)` | — | The validator's value, nothing written |
| `storage.schemaInfo` | — | `{ version, hash, previous, held }` |
| `storage.migrate(options?)` | — | `{ migrated, counters, sets, lists, texts, trees }` — how many records, then how many fields of each kind made again |

See [Storage](./storage#collections) for `$type` and the collection
methods, and [Sync](./sync#schemas) for what hello carries.

# Smart contracts

A smart contract is a JavaScript procedure stored **in the chain** by hash,
loaded back by that hash, and run against a read-only view of storage. It is a
way to make the code that produced a record as auditable as the record itself.

```js
const { Blockchain } = require('@alexify/syncom');
const { SmartContract, DataReader } = require('@alexify/syncom/contracts');

const chain = await new Blockchain('contracts'); // a chain of its own
```

The chain a contract lives in is a [`Blockchain`](./chain#using-it-directly)
you open; a storage's own chain is internal to it and is not handed out. Give
it a directory of its own — two writers of one chain directory overwrite each
other's tail.

Contracts are a **subpath**, not part of the package root: `SmartContract.load`
reconstructs a stored procedure with `new Function`, so a process that never
imports `@alexify/syncom/contracts` — a hub that only replicates, say — never
executes a block's code (see [Security](https://github.com/Alexis-Technologies/syncom/blob/main/SECURITY.md)).

## Saving

`SmartContract.save` serialises the procedure's source into a block and
returns its hash.

```js
const hash = await SmartContract.save('publish', chain, async (reader, args) => {
  const post = await reader.get(args.id);
  return { ...post, status: 'published' };
});
```

The block is `{ type: 'smart contract', name, source }`.

## Loading and executing

```js
const contract = await SmartContract.load(hash, { storage, chain });
const result = await contract.execute({ id: postId, ...args });
```

`execute` calls the procedure with a `DataReader` and your arguments, then
saves the returned value back to storage under `args.id` — through
`saveData`, a whole-record write that replicates like any other. If the procedure
throws, the failure is appended to the chain as
`{ contract, args, error, timestamp }` and the error is re-thrown — so a
rejected execution leaves an audit trail rather than vanishing.

`DataReader` exposes exactly one method, `get(id)`, backed by
`storage.loadData`. A contract cannot write except through its return value.

## The serialisation format

::: danger Contracts are `new Function` over stored source
`SmartContract.load` reconstructs the procedure with `new Function`. Anything
that can append a `smart contract` block to your chain can therefore run
arbitrary code in your process. Only load contracts from a chain you control.
:::

The parser is deliberately narrow. It handles a **single arrow function**,
splitting on the first `=>`:

```js
// both of these round-trip
async (reader, args) => { /* body */ }
(reader, args) => expression
```

It does not handle `function` declarations, default parameter values
containing `=>`, or destructured parameters spanning the arrow. A procedure
outside that shape will not survive the round trip, so keep the stored
procedure to a plain arrow function and put anything complex behind data it
reads.

Loading a hash whose block is not a contract rejects with
`code: 'NOT_CONTRACT'` (`Not a smart contract block`), and one with no block
at all with `code: 'BLOCK_NOT_FOUND'`.

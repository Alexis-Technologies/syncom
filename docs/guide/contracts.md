---
title: Smart contracts
description: Store a procedure in a hash-linked chain, run it against a read-only view of the database, and keep an audit trail of what it did and what failed.
---

# Smart contracts

A smart contract in syncom is a JavaScript procedure stored in a [chain](./chain) by hash, loaded back by
that hash, and run against a read-only view of the database. Its result is written as an ordinary record,
and its failures are recorded in the chain. Use it when the code that produced a record must be as
auditable as the record: anyone holding the chain can see exactly which procedure ran, under which hash.

Contracts are `@alexify/syncom/contracts`, deliberately off the package root: loading one rebuilds code
with `new Function`, so a process that never imports the subpath never runs code from a block (see
[SECURITY.md](https://github.com/Alexis-Technologies/syncom/blob/main/SECURITY.md)).

## Save a contract

<<< @/examples/contracts.mjs#save

`SmartContract.save(name, chain, procedure)` writes the procedure's source into a block
`{ type: 'smart contract', name, source }` and resolves to the block's hash, which is the contract's
identity from then on. The chain is a [`Blockchain`](./chain#keep-a-chain-of-your-own) you open in a
directory of its own; a database's own chain is internal to it and not handed out.

## Run it

<<< @/examples/contracts.mjs#execute

`SmartContract.load(hash, { storage, chain })` rebuilds the procedure from its block, and `execute(args)`
calls it with a reader and your arguments. The reader has one method, `get(id)`, so a contract cannot
write anything except through its return value, which `execute()` saves under `args.id` as a whole-record
write that replicates like any other.

## Keep a trail of what failed

<<< @/examples/contracts.mjs#failure

When the procedure throws, the failure is appended to the chain as `{ contract, args, error, timestamp }`
and the error is rethrown, so a rejected execution leaves a record instead of vanishing. Loading a hash
whose block is no contract rejects with `ALX_ERR_NOT_CONTRACT`, and a hash with no block at all with
`ALX_ERR_BLOCK_NOT_FOUND`.

## Only load contracts from a chain you control

::: danger Stored source runs in your process
`SmartContract.load` rebuilds the procedure with `new Function`. Anything that can append a
`smart contract` block to your chain can run arbitrary code in your process. Keep the contracts' chain
local, and load only hashes you saved yourself.
:::

## Write procedures the loader can read back

The stored source is parsed narrowly: a single arrow function, split at its first `=>`. Both
`async (reader, args) => { ... }` and `(reader, args) => expression` round-trip. A `function` declaration,
a default parameter value containing `=>`, or destructured parameters spanning the arrow do not survive the
trip. Keep the stored procedure a plain arrow function and put anything complex in the data it reads.

## Coming from RxDB

RxDB has nothing like this. The closest pattern is a document hook or a replication handler on a server,
which is code you deploy, not code stored and identified by hash next to the data it produced.

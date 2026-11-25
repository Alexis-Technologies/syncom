---
title: Agent tools (MCP)
description: Give an AI agent tools to query, follow and change a syncom database, in the shape of the Model Context Protocol, from a server or a browser page.
---

# Agent tools (MCP)

An AI agent works with your data through tools: functions with a name, a description and a JSON Schema for their
arguments, which the model chooses and calls. `@alexify/syncom/mcp` makes those tools for the collections of a
database in the shape the [Model Context Protocol](https://modelcontextprotocol.io) uses, so an MCP server can
serve them and a browser's WebMCP registry can take them as they are. The subpath imports no SDK: a tool is a plain
object, and registering it is up to you.

Because the data is local, an agent's query runs against the node's own copy, offline included, and its writes
replicate to other nodes like any other write.

## Make the tools for a collection

<<< @/examples/mcp.mjs#tools

`createTools(db, options)` answers one set of tools per collection, named `<Collection>_<verb>`. Each tool is a
frozen `{ name, description, inputSchema, annotations, execute }`:

| Tool                        | Arguments                                                                                                                                       | Answer                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `<Collection>_query`        | `query` (a [Mango query](./query)), `order` (fields, `'-field'` for descending), `limit` (100 by default, at most the `limit` option), `offset` | `{ rows }`                                                                      |
| `<Collection>_count`        | `query`                                                                                                                                         | `{ count }`                                                                     |
| `<Collection>_get`          | `id`                                                                                                                                            | `{ record }`, `null` where there is none                                        |
| `<Collection>_changes`      | `since` (optional), `limit`                                                                                                                     | `{ eventId, changes, more }`; see [Follow changes](#follow-what-changed)        |
| `<Collection>_wait_changes` | `since`, `limit`, `timeout` (30 000 ms by default, 120 000 at most)                                                                             | what `_changes` answers, once something changed after `since` or at the timeout |
| `<Collection>_insert`       | `data`                                                                                                                                          | `{ id }`                                                                        |
| `<Collection>_upsert`       | `id` (optional), `data`                                                                                                                         | `{ id }`: the record written whole under `id`, or under the id its data names   |
| `<Collection>_delete`       | `id`                                                                                                                                            | `{ id, deleted }`, `deleted: false` where there was nothing to delete           |

## Call a tool

`execute(args)` takes the arguments as the model sent them and answers JSON:

<<< @/examples/mcp.mjs#execute

A tool runs the collection's own method (`select()`, `count()`, `insert()`…), so what applies to the app applies to
the agent: the collection's [schema](./schema-validation) validates its writes, the writes go through your
[hooks](./hooks), and they replicate. A refusal comes back as the `SyncomError` it is: `ALX_ERR_NOT_FOUND`, a
`ValidationError`, `ALX_ERR_PLUGIN_MISSING` where the database has no query plugin. Nothing marks a write as the agent's:
it is this node's write, made the way your app makes one.

## Tell a client which tools change data

Every tool carries the protocol's `annotations`, which a client reads to decide what to ask the user to confirm:

<<< @/examples/mcp.mjs#annotations

The five readers are read-only and idempotent. `insert` is neither. `upsert` and `delete` are destructive (one
overwrites a record whole, the other takes it away) and idempotent. No tool reaches outside the database, so
`openWorldHint` is `false` everywhere.

## Give an agent read access only

The writers are made by default. When the model is not one you trust with your data, leave them out:

<<< @/examples/mcp.mjs#read-only

`readOnly: true` makes no writer at all, whatever else you ask for, so a read-only set has nothing an agent could
call to write. To pick verbs one by one, pass `tools` (for example `tools: ['query', 'get']`); `collections` picks
the collections, and every collection of the database is served when you leave it out.

## What happens to a wrong call

A model makes mistakes: a misspelled argument, a number where a string belongs, a window far too large. Each tool
checks its arguments against its own `inputSchema` before anything runs, and a wrong call is an `ArgumentError` (a `TypeError`, `ALX_ERR_INVALID_ARGUMENT`) that
names the member:

<<< @/examples/mcp.mjs#door

Every object in a schema is closed, so a member the schema does not name is refused, and so are inherited names
such as `constructor` or `__proto__`. A `$regex` anywhere in a query is refused too, unless you pass
`regex: true`: a regular expression runs on your event loop, and a pathological one such as `^(a+)+$` can hold it
for seconds. Your server reports the `ArgumentError` to the model as the tool's error, and the model can try again.

The same check is exported for your own tools, or for arguments you want to validate before they reach `execute`:

<<< @/examples/mcp.mjs#check-args

## Follow what changed

An agent that keeps working on a collection does not need to query it again and again. `_changes` called without
`since` answers the `eventId` to start from; called with one, it answers the records of the collection that changed
since, each id once and with `deleted` as it stands now:

<<< @/examples/mcp.mjs#changes

A page holds at most `limit` records, and `more` is `true` while the log holds more after the `eventId` it answers.
`changes` is `null` where the log can no longer resume at `since` (the position was compacted away, or belongs to
another log): the agent lists the collection again then. `_wait_changes` is the long poll: it answers as soon as
something changed after `since`, or at its timeout with an empty list.

<<< @/examples/mcp.mjs#wait

## Serve the tools over MCP

An MCP server needs two handlers: one that lists the tools (`tools/list`) and one that runs a tool by name
(`tools/call`). `inputSchema` is already JSON Schema, the protocol's own shape, so nothing is translated:

<<< @/examples/mcp.mjs#handlers

With the official SDK (`@modelcontextprotocol/sdk`, installed next to syncom), hand the two handlers to its
server; here over stdio, the transport a desktop agent launches a local server with:

<<< @/examples/mcp-server.mjs#sdk

The SDK is not a dependency of this repository, so this file is only checked for syntax; the handlers above run in
the page's tests.

## Register the tools with WebMCP in a browser

WebMCP is an experimental browser API through which a page offers tools to an agent running in the browser. Its
registry takes a tool with the same members `createTools()` makes, `execute` included:

<<< @/examples/mcp.mjs#webmcp

The registry is `document.modelContext` in the current drafts of the specification and `navigator.modelContext` in
earlier builds, hence the fallback. Where neither exists, there is nothing to register with.

## Options

| Option        | Default          | What it does                                                                                                           |
| ------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `collections` | every collection | The collections to make tools for                                                                                      |
| `tools`       | all eight verbs  | The verbs to make: `query`, `count`, `get`, `changes`, `wait_changes`, `insert`, `upsert`, `delete`                    |
| `readOnly`    | `false`          | Make no writer, whatever `tools` says                                                                                  |
| `limit`       | `1000`           | The most rows a `query` answers and the most records a `changes` page holds; `1000` at most                            |
| `sealed`      | `false`          | Read the collections' [encrypted records](./encryption) too; they are left out of `query`, `count` and `get` otherwise |
| `regex`       | `false`          | Allow `$regex` in a query                                                                                              |

With the [telemetry](./telemetry) plugin every call is counted as `syncom.mcp.calls`, by verb and by result: `ok`,
`refused` (an `ArgumentError` at the door) or `error` (a refusal from the collection).

## Limitations

The tools do not authenticate anyone: who may reach your MCP server, or which page may register tools, is the
server's and the page's business. An agent is a reader of the plain records by default; records written
`encrypted: true` are the key holder's, and an agent sees them only when you pass `sealed: true`. A query cannot
use `$regex` unless you allow it, and there is no tool for the text, list or tree operations of a field: an agent
writes a record whole (`upsert`) or a new one (`insert`).

## Coming from RxDB

RxDB's WebMCP plugin registers the tools for you, at the browser's registry, from a database or a collection. In
syncom you make the definitions and register them where you want: the browser's WebMCP registry, an MCP server for
a desktop agent, or both. syncom adds a `get` tool, the annotations, and the argument check at the door; RxDB waits
for running replications before it answers a query, which syncom does not do.

::: code-group

<<< @/examples/mcp.mjs#webmcp [syncom]

<<< @/examples/rxdb/mcp.mjs#webmcp [RxDB]

:::

<FromRxdb page="webmcp" :rows="['webmcp']" />

# src/mcp/CLAUDE.md — Agent tools

The tools an agent calls over a database, in the shape of the Model Context Protocol. The rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/mcp/mcp.js            @alexify/syncom/mcp — createTools(db, { collections, readOnly, limit, sealed }): per collection query, count, get, changes,
                          wait_changes, insert, upsert, delete as { name, description, inputSchema, execute }; checkArgs — requires
                          symbols.js only
```

## Rules

- **A tool is a definition, not a registration.** `createTools` answers plain objects in the protocol's shape — `name`
  (`<Collection>_<verb>`), `description`, `inputSchema` (JSON Schema), `execute(args)` — and imports no SDK: an MCP
  server's `tools/list` answers the definitions and its `tools/call` runs `execute`; WebMCP's
  `navigator.modelContext.registerTool(tool)` takes one as it is. What the server makes of the answer (text content,
  a structured result) is the server's.
- **The schema is checked at the door.** `execute(args)` runs `checkArgs(inputSchema, args)` before anything: a
  member of another type, a required one missing, one the schema does not name (`additionalProperties: false`), a
  window past `limit`, a wait past `MAX_WAIT` is a `TypeError` naming the member — a model's wrong call is a wrong
  call, never a crash deeper down. `check` is the subset of JSON Schema the tools declare (type, enum, minimum,
  maximum, items, properties, required, additionalProperties) and grows with them, never ahead of them. The
  collection's own refusals (`NOT_FOUND`, a validator's, `PLUGIN_MISSING` without the query plugin) come through as
  the SyncomErrors they are.
- **`readOnly` is no writer at all.** The three writers are not made, not refused: a read-only tool set has nothing
  an agent could call to write.
- **A sealed record is the key holder's, not the agent's.** `query` and `count` read through
  `collection.select(query, { sealed })` and `get` asks the catalog's row first: a collection's `encrypted: true`
  records are left out unless `createTools(db, { sealed: true })` — an agent, often another party's model, reads the
  plain rows by default (SEC-7).
- **Changes are the log's, filtered by the catalog.** `changes` without `since` answers the `eventId` to start from
  (`db.log.lastEventId`); with one, the records of the collection the log touched since (`db.log.since`, an id once,
  `deleted` from the catalog's row — the `[SOURCE]` seam's `row(id).type`, as the pipeline decides membership) and
  the next `eventId`; `changes: null` where the log cannot resume there (another epoch, a position compacted away):
  the agent lists the collection again. `wait_changes` listens to the collection's `change` event BEFORE reading
  the log, so nothing lands between the two unheard, and answers at the timeout with nothing.

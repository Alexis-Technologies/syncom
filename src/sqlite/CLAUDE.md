# src/sqlite/CLAUDE.md — SQLite

The engine over SQLite, Node only. The engine contract and the rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/sqlite/sqlite.js      @alexify/syncom/sqlite — sqliteEngine({ file, database, driver, durable }): the engine over one SQLite database
                          — kv (p, ns, key), records (p, id) as JSON text, pieces (p, id, name), copies (p, tag, id), log (p, seq) with
                          the group's first seq, meta (p, key) for the log's index and segments; one transaction per write set and per
                          log group, a statement per listing, every statement through one lane — requires engine.js, errors.js only
```

## Rules

- **`node:sqlite` is required inside the factory, never at the top.** The module is experimental in Node (a warning
  at the require, which the engine does not silence: `node --no-warnings=ExperimentalWarning`, or a driver), and an
  engine given a `driver` or a `database` must load nothing of it. A driver is duck-typed — `exec(sql)`,
  `prepare(sql)` → `{ run, get, all }`, an optional `close()` — and every result is awaited, so better-sqlite3,
  expo-sqlite and a promise-returning wrapper all fit (`tests/engine.sqlite.test.js` runs one). A row for "none" is
  `undefined` or `null` (`none`). A parameter is a text, a number or null — never `undefined` or a boolean, which
  SQLite refuses to bind.
- **One connection, one lane.** Every statement goes through `serial`: a transaction awaits its statements one by one
  (a driver may answer with promises), and nothing else may run on the connection between `BEGIN IMMEDIATE` and
  `COMMIT` — a read outside the lane would see the set before it is committed, a second write set would nest. A write
  set that throws is rolled back whole and the connection serves the next — a `COMMIT` that fails (BUSY, FULL, an I/O
  error) is rolled back the same, or the connection would hold an open transaction for good. `log.load` is a `read`:
  the lane alone, no transaction (nothing of this connection runs between its statements). A log row that does not
  parse at open is counted `corrupt`, left out and said (`log.row.unreadable`, `health.lost`); a meta row that does
  not is none (`log.meta.unreadable`). The segments list in memory moves once the medium has it. `getMany` is one statement over
  `json_each(ids)` (never a spread of the ids into parameters); `ids` a range over the primary key (`id > ?`, ids are
  ASCII, so SQLite's byte order is JavaScript's); a listing of keys or copies is sorted here.
- **The file is the engine's, the path a row's first key.** Every table starts with `p`, so one file serves many
  databases (a mesh in one process over `:memory:`), and `remove(path)` is one `DELETE … WHERE p = ?` per table in one
  transaction. `close()` closes a connection the engine opened and the next call opens the file again (a `:memory:`
  database starts over); a `database` given is never closed and keeps its settings — no pragma of the engine's reaches
  it but `durable`. `destroy()` deletes the file with its `-wal`/`-shm`. `durable: true` on any database sets `PRAGMA
synchronous = FULL` for the connection; a connection the engine opened gets `journal_mode = WAL` for a file,
  `synchronous = NORMAL` and a `busy_timeout`.

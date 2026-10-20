# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities **privately** via
[GitHub Security Advisories](https://github.com/Alexis-Technologies/syncom/security/advisories/new)
or by emailing the author (see `package.json`). Do not open public issues or
pull requests for security reports — a fix should ship before the details do.

What to include: the affected surface (see below), a minimal reproduction, and
the impact as you understand it. Reports are acknowledged within **7 days**; a
confirmed vulnerability gets a fix or a mitigation plan within **30 days**, and
coordinated disclosure (an advisory + a patched release) once the fix is out.
Credit is given unless you ask otherwise.

## Threat model

Three parties, three levels of trust:

- **The local process** owns everything under `<path>`: the records, the log,
  the private key, the tokens. Nothing protects the storage from the process
  that opened it; the chain makes tampering *evident*, not impossible.
- **An authorized peer** — one that passed the unit's `access`, your
  `authorize(context, hello)` and the transport's own authentication — may
  write and read every record **in the scopes its hello named**, and nothing
  outside them. `origin`, `actor` and the node id it greets with are claims it
  makes about itself; ops are not signed. It cannot move another node's
  version vector (an `advance` is adopted only from the host a subscription is
  read from, and only that host's own), cannot move another node's clock more
  than `sync.maxSkew` ahead, and cannot reach a property name, a file name or
  a type the engine does not index records by.
- **Anyone else** — a peer that fails `hello` — gets nothing but the refusal.

## Scope

These are the areas where a report matters most, roughly in order:

- **Smart contracts** (`src/contract.js`, the `@alexify/syncom/contracts`
  subpath). `SmartContract.load` reconstructs a stored procedure with
  `new Function` and runs it in your process. Anything that can append a
  `smart contract` block to a chain you load from can therefore execute
  arbitrary code. This is the sharpest surface in the library; treat a chain
  as trusted input, and report anything that widens the gap between "can
  write a block" and "can run code". The package root never imports the
  subpath: a node that only stores and replicates — a hub — executes no
  block's code, whatever a peer's chain holds.
- **Chain integrity** (`src/chain.js`, `calculateHash`). The whole tamper-
  evidence claim rests on blocks hashing to what they are filed under and on
  `validate` walking `prev` honestly. A way to mutate a record or block and
  still pass `validate` is a vulnerability.
- **Replication** (`src/sync.js`, `src/ops.js`, `src/log.js`). A peer is
  trusted with everything its scopes cover: anything that passes `hello`
  (the unit's `access`, your `authorize(context, hello)`, the transport's own
  authentication) can write any record in those scopes. The host holds it to
  them — in `push`, `snapshot` and `changes` — and checks every op's shape
  (`origin`, `seq`, `ts`, `type`, `scope`, the record id) before reading it.
  Ops are not signed; `origin` is a claim. In scope: a way for a peer to
  write or read outside its scopes, to make another node apply an op twice
  with a different result (idempotence), to move another node's vector
  through a `merge`/`advance` op, to move another node's clock past
  `sync.maxSkew`, prototype pollution through op payloads or merge metadata,
  or a malformed op that crashes a node rather than being counted and
  skipped. The token in `addNode({ token })` and `hello` is stored and sent as
  given; use `wss://`.
- **Crypto** (`src/crypto.js`, `src/crypto.browser.js`). RSA-2048 key
  generation, PEM handling, and the hybrid envelope (AES-256-GCM under an
  RSA-OAEP/SHA-256 wrapped key) records stored with `{ encrypted: true }` use,
  identical in both halves. Half a key pair is refused (`KEYS_INCOMPLETE`),
  never replaced. A *silent* mismatch that produces wrong plaintext rather
  than an error is in scope, as is any way an encrypted record's plaintext
  leaves the node (they are deliberately excluded from replication).
- **Purge** (`storage.purge()`, `OpLog.scrub()`). A purged record must leave
  no payload in this node's `data/` and `log/`, and the purge must reach and
  scrub every peer that holds the id. A way for purged data to survive here
  or to be resurrected by a later op is in scope; a peer that never
  reconnects, and a chain block (hashes only), are not.
- **Filesystem access** (`src/fsi.js`, `src/fsi.browser.js`, `src/idb.js`).
  Paths are built from record ids and caller-supplied directory names. A
  record id is checked at every entrance — the local writers, `getId`, a
  peer's op, a snapshot record — against `[A-Za-z0-9_@-][A-Za-z0-9._@-]{0,127}`
  and refused otherwise. Traversal out of the storage directory through an id
  that passes that check, or through a name the check does not cover, is in
  scope. (`src/idb.js` keys by `[dir, name]` and has no path semantics.)

## Not in scope

- The transport itself. wrpc (or whatever `connect(node)` returns) owns the
  connection, its authentication and its encryption in transit; report those
  to the transport's maintainers.
- Node URLs and tokens are stored as given, in plaintext, under
  `<path>/remote/`; the RSA private key sits unprotected in `<path>/keys/`.
  Both are documented behaviour, not findings.
- Denial of service by a peer that is allowed to sync below the host's own
  `unit({ limits })` (ops and bytes per push, ops per second), or through a
  huge snapshot: those limits are the transport's and the operator's.
- Record ids and peer urls on telemetry spans while
  `telemetry.includeIdentity` is on (the default): documented behaviour.
- Anything requiring an attacker to already have write access to the storage
  directory, except where it defeats `validate` (see Chain integrity above).

## Supported versions

Pre-1.0: only the latest release receives fixes.

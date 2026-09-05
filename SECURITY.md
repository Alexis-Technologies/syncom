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

## Scope

These are the areas where a report matters most, roughly in order:

- **Smart contracts** (`src/contract.js`). `SmartContract.load` reconstructs a
  stored procedure with `new Function` and runs it in your process. Anything
  that can append a `smart contract` block to a chain you load from can
  therefore execute arbitrary code. This is the sharpest surface in the
  library; treat a chain as trusted input, and report anything that widens the
  gap between "can write a block" and "can run code".
- **Chain integrity** (`src/chain.js`, `calculateHash`). The whole tamper-
  evidence claim rests on blocks hashing to what they are filed under and on
  `validate` walking `prev` honestly. A way to mutate a record or block and
  still pass `validate` is a vulnerability.
- **Replication** (`src/sync.js`, `src/ops.js`, `src/log.js`). A peer is
  trusted with everything its scopes cover: anything that passes `hello`
  (the unit's `access`, your `authorize(context, hello)`, the transport's own
  authentication) can write any record in those scopes. Ops are not signed;
  `origin` is a claim. In scope: a way for a peer to write outside its
  scopes, to make another node apply an op twice with a different result
  (idempotence), to push a `merge`/`advance` op that grants itself state it
  was not given, prototype pollution through op payloads, or a malformed op
  that crashes a node rather than being logged and skipped. The token in
  `addNode({ token })` and `hello` is stored and sent as given; use `wss://`.
- **Crypto** (`src/crypto.js`, `src/crypto.browser.js`). RSA-2048 key
  generation, PEM handling, and the hybrid envelope (AES-256-GCM under an
  RSA-OAEP/SHA-256 wrapped key) records stored with `{ encrypted: true }` use,
  identical in both halves. A *silent* mismatch that produces wrong plaintext
  rather than an error is in scope, as is any way an encrypted record's
  plaintext leaves the node (they are deliberately excluded from replication).
- **Filesystem access** (`src/fsi.js`, `src/fsi.browser.js`). Paths are built
  from record ids and caller-supplied directory names. Traversal out of the
  storage directory via a crafted id or path is in scope.

## Not in scope

- The transport itself. wrpc (or whatever `connect(node)` returns) owns the
  connection, its authentication and its encryption in transit; report those
  to the transport's maintainers.
- Node URLs and tokens are stored as given, in plaintext, under
  `<path>/remote/`; the RSA private key sits unprotected in `<path>/keys/`.
  Both are documented behaviour, not findings.
- Denial of service by a peer that is allowed to sync (a flood of ops, a huge
  snapshot): the limits are the transport's and the operator's.
- Anything requiring an attacker to already have write access to the storage
  directory, except where it defeats `validate` (see Chain integrity above).

## Supported versions

Pre-1.0: only the latest release receives fixes.

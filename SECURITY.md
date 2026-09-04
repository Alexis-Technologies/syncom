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
- **Crypto** (`src/crypto.js`, `src/crypto.browser.js`). RSA-2048 key
  generation, PEM handling, encrypt/decrypt of records stored with
  `{ encrypted: true }`, and the base64url encoding in the browser half. Note
  the two halves are deliberately not ciphertext-compatible (default padding
  vs RSA-OAEP/SHA-256); a *silent* mismatch that produces wrong plaintext
  rather than an error is in scope.
- **Filesystem access** (`src/fsi.js`, `src/fsi.browser.js`). Paths are built
  from record ids and caller-supplied directory names. Traversal out of the
  storage directory via a crafted id or path is in scope.

## Not in scope

- `src/sync.js` moves no data — `start()` is a no-op and there is no transport
  to attack. Node URLs and tokens are stored as given, in plaintext, under
  `<path>/remote/`; that is the documented behaviour today, not a finding.
- Anything requiring an attacker to already have write access to the storage
  directory, except where it defeats `validate` (see Chain integrity above).

## Supported versions

Pre-1.0: only the latest release receives fixes.

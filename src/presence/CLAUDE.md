# src/presence/CLAUDE.md — Presence

Never logged; what a host relays. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/presence/presence.js  the @alexify/syncom/presence subpath — ephemeral state per node, signed through storage[SIGNER]; requires emitter, shape, symbols, errors, scope only
```

## Rules

- **Presence is never logged, and a host relays only a peer's own.** A
  presence update is `{ p: 1, scope, s: [[node, clock, ts, state, sig?]] }`,
  signed per entry as `[1, node, clock, ts, canonical(state)]` through
  `storage[SIGNER]` (`signMessage`/`verifyMessage` of the signing plugin's
  identity; `canonical` lives in src/shape.js). It travels as the
  fire-and-forget event `syncom/presence`: `link.send` on the dialing side,
  the unit's `on.presence` handler on the host (src/sync/hosting.js), which
  refuses — counted, never relayed — an update whose entries are not the
  greeted node's, of a scope not asked for, past `presence.rate`, or unsigned
  under 'require', then relays to `syncom:<scope>` except the sender and
  keeps the newest state per node for a newcomer's hello. The dialing side
  takes a host's relay with `from: null` (the host checked who said what; a
  signature says the rest). Nothing of it reaches the log, the chain or the
  Record; `receivePresence` feeds the registered instances alone.

'use strict';

// Signed ops as a plugin (@alexify/syncom/signing): the node's identity IS
// its Ed25519 public key (`keys/sign-public.pem`, made at the first open,
// 43 base64url characters as the node id), every op this node makes is
// signed in place before it is appended (./sign.js: the header plus a
// salted digest of the payload), and a peer's op is verified against its
// origin before it is admitted — `sync.signatures` 'verify' (the default)
// checks what carries a signature, 'require' refuses what carries none.
// Without the plugin the node id is what `open({ getId })` mints (a UUID
// by default), nothing is signed, and a peer's signatures are not checked:
// the 'verify' semantics for unsigned ops, as before — `'require'` without
// the plugin is PLUGIN_MISSING. The hook the core takes: `identity` — the
// id, `sign(op)`, `verify(op, mode)` and `signMessage(text)` (presence).

const { calculateHash, generateSigningKeys, loadSigningKeys, sign, verify } = require('./ed25519.js');
const { signOp, verifyOp } = require('./sign.js');

const signing = Object.freeze({
  name: 'signing',
  async setup({ fsi, path }) {
    const keys = await loadSigningKeys(`${path}/keys`, { fsi });
    return {
      identity: {
        id: keys.id,
        sign: (op) => signOp(op, keys.privateKey),
        verify: (op, mode) => verifyOp(op, mode),
        signMessage: (message) => sign(message, keys.privateKey),
      },
    };
  },
});

module.exports = { signing, calculateHash, generateSigningKeys, loadSigningKeys, sign, verify };

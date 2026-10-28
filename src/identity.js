'use strict';

// Which node a directory is, read from and written to `node.json`: the
// signing plugin's key id where it runs (the id IS the Ed25519 public key),
// else what node.json names, else what `getId` mints for a fresh directory
// (a UUID by default). The node's own sequence numbers live in the log's
// vector, which survives compaction, so a seq is durable the moment its op
// is appended. A directory from before signing (a UUID in node.json) is
// rekeyed once, with a warning, when the plugin arrives; node.json naming
// ANOTHER key is refused (IDENTITY_MISMATCH): an id that changed in silence
// would break SELF detection and every peer's echo filter. node.json also
// names the kind plugins the directory ran with: a reopen without one of
// them would hold fields it cannot apply and lose them at the next write,
// so it is refused (PLUGIN_MISSING, naming the plugin); more plugins than
// before is fine and is recorded. Requires errors.js and shape.js only.

const { SyncomError, typed } = require('./errors.js');
const { isStreamName, isKeyId } = require('./shape.js');

const NODE_FILE = 'node.json';

// A service file a storage wrote itself and cannot read any more.
const corruptFile = (file, cause) =>
  new SyncomError('CORRUPT', `${file} is unreadable (${cause?.message ?? cause}); restore it or remove the directory`, {
    cause,
  });

/**
 * The node id of the storage at `path`: `keyId` the signing plugin's key
 * (null without it), `kinds` the kind plugins it runs, `getId()` what mints
 * a fresh id. Writes node.json when it changed.
 */
const loadIdentity = async ({ fsi, path, keyId, kinds, getId, logger }) => {
  let nodeId = null;
  if (await fsi.exists(path, NODE_FILE)) {
    let stored;
    try {
      stored = JSON.parse(await fsi.read(path, NODE_FILE));
    } catch (error) {
      throw corruptFile(NODE_FILE, error);
    }
    const { id } = stored;
    if (!isStreamName(id)) throw corruptFile(NODE_FILE, 'no node id in it');
    // Every plugin it ran with is here (the first one missing is refused);
    // the same set when it names as many.
    const known = new Set(kinds);
    const ran = Array.isArray(stored.plugins) ? stored.plugins : [];
    let count = 0;
    for (let i = 0; i < ran.length; i++) {
      const name = ran[i];
      if (typeof name !== 'string') continue;
      if (!known.has(name)) {
        const message = `${NODE_FILE} says this storage runs with the ${name} plugin: open({ plugins }) with it from '@alexify/syncom/${name}'`;
        throw typed('PLUGIN_MISSING', message);
      }
      count++;
    }
    const same = count === kinds.length;
    if (keyId === null || id === keyId) {
      nodeId = id;
      if (same) return nodeId;
    } else if (isKeyId(id)) {
      const message = `${NODE_FILE} names node ${id}, but keys/sign-public.pem is ${keyId}`;
      throw new SyncomError('IDENTITY_MISMATCH', message, { id, key: keyId });
    } else {
      logger.warn({ event: 'identity.rekeyed', from: id, to: keyId });
      nodeId = keyId;
    }
  } else if (keyId !== null) {
    nodeId = keyId;
  } else {
    const minted = await getId();
    if (!isStreamName(minted)) {
      throw new TypeError(`open({ getId }): ${JSON.stringify(minted)} cannot be a node id (a short name without '@')`);
    }
    nodeId = minted;
  }
  await fsi.write(path, NODE_FILE, JSON.stringify({ id: nodeId, plugins: kinds }), { atomic: true });
  return nodeId;
};

module.exports = { NODE_FILE, loadIdentity, corruptFile };

'use strict';

/** Every library in the comparison, in the order the tables list them. */
const syncom = require('./syncom.js');

const ADAPTERS = [
  syncom.pure,
  syncom.secure,
  require('./yjs.js'),
  require('./automerge.js'),
  require('./loro.js'),
  require('./tinybase.js'),
  require('./pouchdb.js'),
  require('./rxdb.js'),
  require('./fireproof.js'),
  require('./gun.js'),
  require('./orbitdb.js'),
];

const getAdapter = (id) => {
  const adapter = ADAPTERS.find((candidate) => candidate.id === id);
  if (adapter) return adapter;
  const known = ADAPTERS.map((candidate) => candidate.id).join(', ');
  throw new Error(`unknown adapter "${id}" (known: ${known})`);
};

module.exports = { ADAPTERS, getAdapter };

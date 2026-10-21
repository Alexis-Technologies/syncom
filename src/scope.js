'use strict';

// Scopes: a record belongs to one (`'*'`, the global scope, by default), a
// peer asks for a list, and an op reaches a peer when its scope is global,
// the peer takes everything, or the peer named the scope. One definition,
// used by the log, the storage and the sync manager. No requires.

const GLOBAL_SCOPE = '*';

const inScope = (scope, scopes) =>
  !scopes || scope === GLOBAL_SCOPE || scopes.includes(GLOBAL_SCOPE) || scopes.includes(scope);

module.exports = { GLOBAL_SCOPE, inScope };

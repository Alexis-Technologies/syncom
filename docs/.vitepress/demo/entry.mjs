// What the live demos of the guide run: real syncom, bundled from src/ for the browser by the
// `syncom-demo` plugin of config.mts (esbuild, the package's "browser" map applied), served as the
// module `virtual:syncom-demo`. Nothing here is a copy: a demo shows what this checkout does.
export { createDatabase } from '../../../src/all/all.js';
export { createMesh, settle, sameVectors, memoryEngine } from '../../../src/testing/testing.js';
// LiveElection: @alexify/syncom/shared's election, run alone (no database) by three "tabs" in one page.
export { elect } from '../../../src/shared/election.js';
// LiveText: @alexify/syncom/editor's caret mapping through a peer's delta.
export { transformIndex } from '../../../src/editor/editor.js';
// LiveScopes: the wire form of ops (not a public export), for the button that pushes an op the way a client
// ignoring its own scopes would — what the host's boundary is there for.
export { packOps } from '../../../src/sync/wire.js';

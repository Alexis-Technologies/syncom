// What the live demos of the guide run: real syncom, bundled from src/ for the browser by the
// `syncom-demo` plugin of config.mts (esbuild, the package's "browser" map applied), served as the
// module `virtual:syncom-demo`. Nothing here is a copy: a demo shows what this checkout does.
export { createDatabase } from '../../../src/all/all.js';
export { createMesh, settle, sameVectors, memoryEngine } from '../../../src/testing/testing.js';

// Browser entry — intentionally mirrors index.js. Do not deduplicate: the
// package.json "exports" browser condition targets this file, and bundlers
// substitute src/runtime/node.js -> src/runtime/browser.js via the
// package.json "browser" field map.
module.exports = require('./src/index.js');

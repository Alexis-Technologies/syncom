'use strict';

// CRC-32 of a string's UTF-8 bytes, as 8 lowercase hex digits — the checksum
// every log line carries (src/log.js): zlib's, native, where Node.js has it
// (22.2 on), the table of ./crc32.browser.js where it does not — the same
// value either way. The browser takes ./crc32.browser.js through
// package.json#browser.

const zlib = require('node:zlib');
const table = require('./crc32.browser.js');

const native = typeof zlib.crc32 === 'function' ? zlib.crc32 : null;

const crc32 = native === null ? table.crc32 : (text) => native(text).toString(16).padStart(8, '0');

module.exports = { crc32 };

'use strict';

// An OpLog over the files engine's journal, as a test opens one on its own:
// the store the core hands the log (an engine's `db.log`) is the journal
// over the fsi given — node:fs by default — under `<dir>/log`.

const { OpLog } = require('../../src/log.js');
const { createJournalStore } = require('../../src/files/journal.js');
const nodeFsi = require('../../src/fsi.js');

const openLog = (dir, options = {}) => {
  const { fsi = nodeFsi, ...rest } = options;
  const logger = rest.logger === false ? null : (rest.logger ?? null);
  return new OpLog(dir, { ...rest, store: createJournalStore(fsi, `${dir}/log`, { logger }) });
};

module.exports = { openLog };

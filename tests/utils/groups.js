'use strict';

// The groups the op log's open files hold — a line of a journal
// (`<seq>-<token>.jsonl`, where the backend can append) or a file of its own
// (`<seq>.json`, where it cannot): what a test counts as "one append".

const openGroups = async (fsi, dir) => {
  let groups = 0;
  for (const name of await fsi.list(dir)) {
    if (!name.endsWith('.jsonl')) {
      groups++;
      continue;
    }
    for (const line of (await fsi.read(dir, name)).split('\n')) if (line !== '') groups++;
  }
  return groups;
};

// The same backend without `append`: the log writes a file per group.
const withoutAppend = (fsi) => {
  const { append, ...rest } = fsi;
  return rest;
};

module.exports = { openGroups, withoutAppend };

'use strict';

/** The machine a benchmark ran on, recorded next to its results. */
const os = require('node:os');

const describeMachine = () => {
  const cpus = os.cpus();
  return {
    cpu: cpus[0]?.model.trim() ?? 'unknown',
    cores: cpus.length,
    memoryGb: Math.round(os.totalmem() / 2 ** 30),
    os: `${os.platform()} ${os.release()} (${os.arch()})`,
    node: process.version,
  };
};

module.exports = { describeMachine };

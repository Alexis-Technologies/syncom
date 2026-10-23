'use strict';

const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

const { Emitter } = require('./emitter.js');
const { createLogger } = require('./logger.js');

const generateUUID = crypto.randomUUID;

const fileExists = async (path) => {
  const stats = await fsp.stat(path).catch(() => null);
  if (!stats) return false;
  return !stats.isDirectory();
};

const directoryExists = async (path) => {
  const stats = await fsp.stat(path).catch(() => null);
  if (!stats) return false;
  return stats.isDirectory();
};

module.exports = {
  Emitter,
  createLogger,
  generateUUID,
  fileExists,
  directoryExists,
};

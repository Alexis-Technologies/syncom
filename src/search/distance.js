'use strict';

// The distances a vector field is searched by (`cursor.nearest(field,
// vector, k)`): over two arrays of numbers of one length, smaller is
// nearer — cosine (1 − the cosine of the angle; 1 for a zero vector),
// euclidean, manhattan, and `dot` (the negated dot product, so a larger
// product is nearer). A vector is an array of finite numbers; `isVector`
// says so. No requires: platform-neutral, off the main entry.

const isVector = (value) => {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (let i = 0; i < value.length; i++) if (typeof value[i] !== 'number' || !Number.isFinite(value[i])) return false;
  return true;
};

const cosine = (a, b) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / Math.sqrt(na * nb);
};

const euclidean = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) * (a[i] - b[i]);
  return Math.sqrt(sum);
};

const manhattan = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum;
};

const dot = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return -sum;
};

/** The distances by name: what `nearest()` takes as `distance`. */
const DISTANCES = Object.freeze({ cosine, euclidean, manhattan, dot });

module.exports = { isVector, cosine, euclidean, manhattan, dot, DISTANCES };

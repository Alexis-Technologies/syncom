'use strict';

// A field whose reading is made when it is read, not when it is written:
// what a list's, a text's or a tree's field of a record is after an op (the
// plugin renders it — src/ops.js applyBlock). The field is an accessor, made
// once per version and shared by the entry's data and the op's delta: the
// first read renders and keeps the value, every later read is that value.
// Assigning the field or deleting it works as on a plain property. A spread
// or Object.assign would read it — `copyData` and `assignData` copy it as it
// is, still lazy. No requires.

// The lazy fields of a data object, by the object — a superset: a field
// assigned or deleted since is copied as what it is now.
const LAZY = new WeakMap();

const lazyField = (data, field, render) => {
  let made = false;
  let value;
  const descriptor = {
    configurable: true,
    enumerable: true,
    get() {
      if (!made) {
        value = render();
        made = true;
      }
      return value;
    },
    set(next) {
      Object.defineProperty(this, field, { configurable: true, enumerable: true, writable: true, value: next });
    },
  };
  return descriptor;
};

// `descriptor` (lazyField's) laid on `data` as `field`.
const putLazy = (data, field, descriptor) => {
  Object.defineProperty(data, field, descriptor);
  let fields = LAZY.get(data);
  if (fields === undefined) LAZY.set(data, (fields = new Set()));
  fields.add(field);
};

// What `{ ...data }` makes, with every lazy field still lazy.
const copyData = (data) => {
  const fields = LAZY.get(data);
  if (fields === undefined) return { ...data };
  const out = {};
  const kept = new Set();
  for (const key of Object.keys(data)) {
    if (!fields.has(key)) {
      out[key] = data[key];
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(data, key);
    Object.defineProperty(out, key, descriptor);
    if (descriptor.get !== undefined) kept.add(key);
  }
  if (kept.size > 0) LAZY.set(out, kept);
  return out;
};

// What `Object.assign(target, source)` does, with every lazy field of
// `source` laid on `target` still lazy.
const assignData = (target, source) => {
  const fields = LAZY.get(source);
  if (fields === undefined) return Object.assign(target, source);
  for (const key of Object.keys(source)) {
    if (!fields.has(key)) {
      target[key] = source[key];
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor.get !== undefined) putLazy(target, key, descriptor);
    else target[key] = descriptor.value;
  }
  return target;
};

module.exports = { lazyField, putLazy, copyData, assignData };

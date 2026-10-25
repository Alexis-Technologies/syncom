'use strict';

// The schema as a plugin (@alexify/syncom/schema): `open({ plugins: [schema],
// schema, validator })` reads the entity definitions once — the validators
// adapted (Standard Schema, a function, or what the injected `validator`
// compiles), the id fields, the indexes and the search fields, the
// migrations and the lens (./define.js, ./lens.js) — and hands the core what
// it applies: collections on the storage, validation on the write path
// (the validated record folded into a local op, a verdict on a peer's), the
// catalog's indexes, `schemaInfo` for hello, `migrate()` and `check()`.
// Without the plugin `open({ schema })` and `open({ validator })` are
// PLUGIN_MISSING, as are `migrate()` and `check()`; records are untyped.
// The hook the core takes: `schema` — the normalized definitions plus
// `view`, the lens as a function (null without migrations or validators to
// read through).

const { normalizeSchema } = require('./define.js');
const { createLens } = require('./lens.js');
const { ValidationError } = require('../errors.js');

const schema = Object.freeze({
  name: 'schema',
  setup({ options, logger }) {
    const given = options.schema ?? null;
    const normalized = normalizeSchema(given, { validator: options.validator });
    const view = given === null ? null : createLens(normalized, logger);
    return { schema: { ...normalized, given, view } };
  },
});

module.exports = { schema, ValidationError };

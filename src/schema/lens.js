'use strict';

// The lens: how a record written under an older version reads under this
// one. Step 1, the migrations from the record's version up to this one;
// step 2, the entity's Standard Schema validator — its aliases and defaults
// are a rename and a fill for free, and metaschema's own `validate` is the
// lens of its evolution model. Neither step writes anything: the record
// stays as it is until `migrate()` rewrites it, and the view is cached on
// the entry. A validator that refuses the record leaves step 1's result
// (logged at debug); a migration that returns no object is a TypeError.

// Requires the core's projections (src/schema/entity.js) only.

const { project, unproject } = require('./entity.js');

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const createLens = ({ version, entities, migrations, lens }, logger) => {
  const chain = lens === 'validate' ? null : migrations;
  const validates = lens !== 'migrations';
  return async (id, data, from) => {
    const type = data.$type;
    const entity = typeof type === 'string' ? type : null;
    let out = {};
    for (const key of Object.keys(data)) if (key !== '$type') out[key] = data[key];
    if (chain !== null) {
      for (let to = from + 1; to <= version; to++) {
        const step = chain.get(to);
        const migration = step instanceof Map ? (entity === null ? undefined : step.get(entity)) : step;
        if (!migration) continue;
        out = await migration.up(out, { entity, id, from: to - 1, to });
        if (!isObject(out)) throw new TypeError(`open({ schema }): migrations[${to}] must return an object (${id})`);
      }
    }
    const def = entity === null ? undefined : entities.get(entity);
    if (validates && def?.standard && def.validator) {
      let output = null;
      try {
        output = await def.validator(project(def, id, out));
      } catch (error) {
        logger.debug({ event: 'schema.lens.issues', entity, id, issues: error.issues });
      }
      if (output !== null) return unproject(def, output, type);
    }
    if (type !== undefined) out.$type = type;
    return out;
  };
};

module.exports = { createLens };

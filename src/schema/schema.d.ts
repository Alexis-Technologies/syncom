// The schema as a plugin (@alexify/syncom/schema): `open({ plugins: [schema],
// schema, validator })` reads the entity definitions once — validators,
// id fields, indexes, search fields, migrations, the lens — and the core
// applies them: collections on the storage, validation on the write path,
// `schemaInfo`, `migrate()`, `check()`. The option types are the core's
// (index.d.ts) and are re-exported here; without the plugin `open({ schema })`
// and `open({ validator })` are `PLUGIN_MISSING`.

import type {
  Plugin,
  Schema,
  SchemaEntity,
  SchemaEntities,
  EntityDefinition,
  SchemaValidator,
  ValidationIssue,
  SchemaInfo,
  SchemaStatus,
  Migration,
  MigrationContext,
} from '../../index.js';

export type {
  Plugin,
  Schema,
  SchemaEntity,
  SchemaEntities,
  EntityDefinition,
  SchemaValidator,
  ValidationIssue,
  SchemaInfo,
  SchemaStatus,
  Migration,
  MigrationContext,
};

export { ValidationError } from '../../index.js';

/** The plugin: `open({ schema, validator })` read into definitions the core applies. */
export declare const schema: Plugin;

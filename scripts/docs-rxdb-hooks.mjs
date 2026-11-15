// Module hooks for `pnpm docs:examples:rxdb`: RxDB and its peers resolve from bench/compare, the
// package that holds every library the benchmarks compare (never syncom's own dependencies).
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const parentURL = pathToFileURL(path.join(import.meta.dirname, '..', 'bench', 'compare', 'package.json')).href;
const hooks = `
export async function resolve(specifier, context, next) {
  if (/^(rxdb|rxjs)(\\/|$)/.test(specifier)) return next(specifier, { ...context, parentURL: ${JSON.stringify(parentURL)} });
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

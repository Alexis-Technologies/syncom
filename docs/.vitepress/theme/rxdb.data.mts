// The data of <FromRxdb> and <NotInSyncom>: docs/rxdb-map.json (every page of RxDB's sidebar and the
// syncom page that answers it) and, from docs/comparison-rxdb.json, each row's title and the two
// cells as the matrix renders them — without `source` and `detail`, which only the matrix's
// reviewers read. Loaded at build time, so a page carries the rows, not the 260 KB file.
import { readFileSync } from 'node:fs';

export interface RxdbCell {
  mark: string;
  html: string;
}
export interface RxdbRow {
  title: string;
  group: string;
  syncom: RxdbCell;
  rxdb: RxdbCell;
}
export interface RxdbPage {
  label: string;
  group: string;
  page: string;
  verdict: 'same' | 'different' | 'partial' | 'absent';
  url: string;
}
export interface RxdbData {
  version: string;
  verdicts: Record<string, string>;
  pages: Record<string, RxdbPage>;
  rows: Record<string, RxdbRow>;
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// The same inline markup scripts/comparison.js renders: `code` spans and [links](url).
const inline = (text: string) =>
  escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

declare const data: RxdbData;
export { data };

export default {
  watch: ['../../rxdb-map.json', '../../comparison-rxdb.json'],
  load(files: string[]): RxdbData {
    const map = JSON.parse(readFileSync(files.find((file) => file.endsWith('rxdb-map.json'))!, 'utf8'));
    const matrix = JSON.parse(readFileSync(files.find((file) => file.endsWith('comparison-rxdb.json'))!, 'utf8'));
    const syncom = matrix.libraries.find((library: { id: string }) => library.id === 'syncom');
    const rxdb = matrix.libraries.find((library: { id: string }) => library.id === 'rxdb');
    const cell = (value: { mark: string; text: string }) => ({ mark: value.mark, html: inline(value.text) });
    const rows: Record<string, RxdbRow> = {};
    for (const group of matrix.groups) {
      for (const row of group.rows) {
        rows[row.id] = {
          title: row.title,
          group: group.title,
          syncom: cell(syncom.cells[row.id]),
          rxdb: cell(rxdb.cells[row.id]),
        };
      }
    }
    return { version: rxdb.version, verdicts: map.verdicts, pages: map.pages, rows };
  },
};

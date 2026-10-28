/**
 * Chart models for the benchmark results in bench/results/*.json: the one
 * place that decides what a chart shows (rows, order, grouping, scale,
 * formatting). Two renderers read it: the docs components
 * (docs/.vitepress/theme/components/Bench*.vue, HTML bars) and the README
 * images (bench/report/svg.mjs). ESM so that Vite can import it; the
 * CommonJS report script loads it with import().
 *
 * A row's `tone` says how it is emphasized: `primary` for syncom as it opens
 * as a pure CRDT (core + text + sync), `secondary` for syncom signed and
 * chained (`@alexify/syncom/all`), none for the rest.
 */

const TONES = { syncom: 'primary', 'syncom-text': 'primary', 'syncom-secure': 'secondary', 'syncom-all': 'secondary' };

const trim = (value) => String(Number(value.toPrecision(3)));

/** 779878 → "780k", 16685662 → "16.7M", 1219 → "1,219", 3.67 → "3.67". */
export const compact = (value) => {
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e4) return `${trim(value / 1e3)}k`;
  if (abs >= 100) return Math.round(value).toLocaleString('en-US');
  return trim(value);
};

/** A full integer with thousands separators, for tables. */
export const grouped = (value) => (value >= 100 ? Math.round(value).toLocaleString('en-US') : trim(value));

/** Three significant figures, thousands-separated: 779878 → "780,000". */
export const approx = (value) => {
  if (value < 100) return trim(value);
  const digits = Math.max(0, Math.floor(Math.log10(Math.abs(value))) + 1 - 3);
  return (Math.round(value / 10 ** digits) * 10 ** digits).toLocaleString('en-US');
};

/** The time one operation takes at `perSecond` a second. */
export const perCall = (perSecond) => {
  const seconds = 1 / perSecond;
  if (seconds >= 1) return `${trim(seconds)} s`;
  if (seconds >= 1e-3) return `${trim(seconds * 1e3)} ms`;
  if (seconds >= 1e-6) return `${trim(seconds * 1e6)} µs`;
  return `${trim(seconds * 1e9)} ns`;
};

export const formatValue = (value, unit) => {
  if (unit === 'ms') return `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
  if (unit === 'KB') return `${value < 100 ? value.toFixed(1) : Math.round(value)} KB`;
  return compact(value);
};

// ─── Scales ─────────────────────────────────────────────────────────────────

const niceStep = (raw) => {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const residual = raw / magnitude;
  const nice = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10;
  return nice * magnitude;
};

/**
 * `{ ticks: [{ value, label, at }], at(value) }`, where `at` maps a value to
 * 0..1 along the bar track. A linear scale starts at zero; a log scale spans
 * whole decades around the data (the bars then encode orders of magnitude,
 * which the subtitle says).
 */
export const createScale = (values, kind, unit) => {
  const max = Math.max(...values);
  if (kind === 'log') {
    const min = Math.min(...values.filter((value) => value > 0));
    const lo = Math.floor(Math.log10(min));
    const hi = Math.max(lo + 1, Math.ceil(Math.log10(max)));
    const at = (value) => (Math.log10(Math.max(value, 10 ** lo)) - lo) / (hi - lo);
    const ticks = [];
    for (let exp = lo; exp <= hi; exp++) {
      ticks.push({ value: 10 ** exp, label: compact(10 ** exp), at: at(10 ** exp) });
    }
    return { kind, at, ticks };
  }
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const at = (value) => value / top;
  const ticks = [];
  for (let value = 0; value <= top + step / 2; value += step) {
    let label = compact(value);
    if (unit === 'ms' || unit === 'KB') label = `${trim(value)} ${unit}`;
    ticks.push({ value, label, at: at(value) });
  }
  return { kind, at, ticks };
};

// ─── Captions ───────────────────────────────────────────────────────────────

const day = (iso) => iso.slice(0, 10);

export const machineCaption = (machine) => [machine.cpu, `${machine.cores} cores`, `Node ${machine.node}`].join(' · ');

export const compareCaption = (compare) => {
  const { method } = compare;
  const samples =
    `median of ${method.samples} × ${method.sampleMs / 1000} s samples ` +
    `(${method.rounds} rounds for a batch or a replication)`;
  return `${machineCaption(compare.machine)} · ${samples}, each library in a fresh process · ${day(compare.generatedAt)}`;
};

export const engineCaption = (engine) =>
  `pnpm bench --save · ${machineCaption(engine.machine)} · 1 s per row · ${day(engine.generatedAt)}`;

// ─── Cross-library comparison ───────────────────────────────────────────────

const byValueDesc = (a, b) => b.value - a.value;
const byValueAsc = (a, b) => a.value - b.value;

const libraryRow = (library, line, value, extra) => ({
  id: library.id,
  label: library.name,
  sublabel: `${library.lines?.[line] ?? ''} · v${library.version}`,
  value,
  tone: TONES[library.id],
  ...extra,
});

/** The scenario kinds and, per kind, the lines it ran on: what the toggles show. */
export const compareKinds = (compare) => {
  const kinds = [];
  for (const scenario of compare.scenarios) {
    let kind = kinds.find((candidate) => candidate.id === scenario.kind);
    if (!kind) {
      kind = { id: scenario.kind, title: scenario.kindTitle, lines: [] };
      kinds.push(kind);
    }
    kind.lines.push({ id: scenario.line, title: scenario.lineTitle, scenario: scenario.id });
  }
  return kinds;
};

const PER_WHAT = { 'ops/s': 'per operation', 'records/s': 'per record' };

// The libraries a chart shows: all of them, or the ids of `only` (a page about one alternative).
const pick = (libraries, only) => (only ? libraries.filter((library) => only.includes(library.id)) : libraries);

export const compareModel = (compare, scenarioId, scale = 'log', only = null) => {
  const scenario = compare.scenarios.find((candidate) => candidate.id === scenarioId) ?? compare.scenarios[0];
  const libraries = pick(compare.libraries, only);
  const rows = libraries
    .filter((library) => scenario.results[library.id])
    .map((library) => {
      const result = scenario.results[library.id];
      return libraryRow(library, scenario.line, result.median, {
        details: [
          `${grouped(result.median)} ${scenario.unit}`,
          `${perCall(result.median)} ${PER_WHAT[scenario.unit] ?? 'per operation'}`,
          `samples ${compact(result.min)} – ${compact(result.max)}`,
          // The JS heap the trace left, after a collection: WebAssembly memory is not in it, and a
          // collection that freed more than the trace kept reads as nothing.
          ...(result.memory > 0 ? [`JS heap after the trace ${(result.memory / 2 ** 20).toFixed(1)} MB`] : []),
          `${library.package}@${library.version}`,
        ],
      });
    })
    .sort(byValueDesc);
  const missing = libraries.filter((library) => !scenario.results[library.id]);
  const reasons = missing.map((library) => {
    const failed = scenario.failed?.[library.id];
    const why = failed ? `failed: ${failed.replace(/^\w*Error:\s*/, '')}` : scenario.unsupported?.[library.id];
    return why ? `${library.name} (${why})` : library.name;
  });
  const names = [...new Set(reasons)];
  const note = names.length ? ` Not shown: ${names.join('; ')}.` : '';
  const axis = scale === 'log' ? 'log scale' : 'linear scale';
  return {
    id: `compare-${scenario.id}`,
    title: scenario.title,
    subtitle: `${scenario.description} ${scenario.unit}, ${axis}, higher is better.${note}`,
    unit: scenario.unit,
    scale,
    groups: [{ id: 'all', label: null, rows }],
  };
};

export const coldStartModel = (compare, only = null) => {
  const rows = pick(compare.libraries, only)
    .filter((library) => compare.coldStart?.[library.id])
    .map((library) => {
      const phases = compare.coldStart[library.id];
      const ms = (value) => `${value.toFixed(1)} ms`;
      return libraryRow(library, 'disk', phases.total, {
        details: [
          `${ms(phases.total)} in total`,
          `load and open ${ms(phases.open)} · first read ${ms(phases.firstRead)}`,
          `${library.package}@${library.version}`,
        ],
      });
    })
    .sort(byValueAsc);
  return {
    id: 'coldstart',
    title: 'Cold start',
    subtitle:
      'Load the library, open a store of 1,000 records on disk, read one: a fresh process, ' +
      `median of ${compare.method.coldStartRuns} runs. Lower is better.`,
    unit: 'ms',
    scale: 'linear',
    groups: [{ id: 'all', label: null, rows }],
  };
};

export const sizeModel = (size, only = null) => {
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
  const rows = pick(size.libraries, only)
    .map((library) => ({
      id: library.id,
      label: library.name,
      sublabel: library.entry,
      value: library.gzip / 1024,
      tone: TONES[library.id],
      details: [
        `${kb(library.gzip)} min+gzip`,
        `${kb(library.min)} minified${library.wasm ? `, ${kb(library.wasm)} of it WebAssembly` : ''}`,
        library.packages.join(', '),
        ...(library.note ? [library.note] : []),
      ],
    }))
    .sort(byValueAsc);
  return {
    id: 'size',
    title: 'Bundle size',
    subtitle:
      'What a browser app ships to keep records on the device and sync them (esbuild, minified, ' +
      'tree-shaken, the network client left out), min+gzip, WebAssembly included. Lower is better.',
    unit: 'KB',
    scale: 'linear',
    groups: [{ id: 'all', label: null, rows }],
  };
};

/**
 * The CRDT libraries' whole packages next to syncom's whole entry, nothing
 * around them (bench/compare/size.js `CORES`): what /guide/vs-crdt shows.
 */
export const coreSizeModel = (size, only = null) => {
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
  const rows = pick(size.cores ?? [], only)
    .map((library) => ({
      id: library.id,
      label: library.name,
      sublabel: library.entry,
      value: library.gzip / 1024,
      tone: TONES[library.id],
      details: [
        `${kb(library.gzip)} min+gzip`,
        `${kb(library.min)} minified${library.wasm ? `, ${kb(library.wasm)} of it WebAssembly` : ''}`,
        library.packages.join(', '),
      ],
    }))
    .sort(byValueAsc);
  return {
    id: 'cores',
    title: 'Bundle size of the whole package',
    subtitle:
      'Every export of the package (export *), with no persistence or sync around it (esbuild, minified), ' +
      "min+gzip, WebAssembly included; syncom's entry carries its storage, queries and sync too. Lower is better.",
    unit: 'KB',
    scale: 'linear',
    groups: [{ id: 'all', label: null, rows }],
  };
};

// ─── syncom's own hot paths ─────────────────────────────────────────────────

/** The scripts of `pnpm bench`, in the order the toggle lists them. */
export const ENGINE_SUBJECTS = [
  { id: 'storage', title: 'Storage' },
  { id: 'search', title: 'Search' },
  { id: 'apply', title: 'Apply' },
  { id: 'sequence', title: 'Lists and text' },
  { id: 'tree', title: 'Trees' },
  { id: 'history', title: 'History' },
  { id: 'tags', title: 'Tags' },
  { id: 'undo', title: 'Undo' },
  { id: 'sync', title: 'Sync' },
  { id: 'log', title: 'Op log' },
  { id: 'chain', title: 'Chain' },
  { id: 'hash', title: 'Hash' },
  { id: 'crdt', title: 'CRDT' },
  { id: 'emitter', title: 'Emitter' },
];

const SUBJECT_NOTES = {
  storage: 'The public API end to end on node:fs: a write is an op appended to the log, a record file and a block.',
  search: 'The @alexify/syncom/search trigram index: a put per write, $text answered from the catalog in rank order.',
  apply: "A peer's page once it has arrived: admit, fold, append, write, announce. The applyRemote rows count ops.",
  sequence:
    'The sequence engine behind list and text fields: a fold per op over Fugue runs, a reading, a join, a diff.',
  tree: 'The movable tree behind tree fields: one move folded over a block of thousands, the fold read anew and read kept.',
  history:
    'The past out of the log: history() over a record with two thousand ops, a version a thousand ops back, its diff.',
  tags: 'Named versions: a tag over a thousand records, writes under it (the first copies the file), reads at the tag.',
  undo: 'The @alexify/syncom/undo manager: what capturing a commit costs a write, what one step back and forward costs.',
  sync: 'Replication over the in-process link (JSON across the boundary, like a wrpc client).',
  log: 'OpLog, the persisted operation log every write and every replicated op goes through.',
  chain: 'The hash-linked chain a write appends a block to (the chain plugin; @alexify/syncom/all has it).',
  hash: 'The digest behind the chain and the integrity checks.',
  crdt: 'diff / merge / apply over plain objects, no I/O.',
  emitter: 'The Emitter every event leaves through.',
};

export const engineSubjects = (engine) =>
  ENGINE_SUBJECTS.filter((subject) => engine.results.some((row) => row.subject === subject.id));

export const engineModel = (engine, subjectId) => {
  const subject = ENGINE_SUBJECTS.find((candidate) => candidate.id === subjectId) ?? ENGINE_SUBJECTS[0];
  const rows = engine.results
    .filter((row) => row.subject === subject.id)
    .map((row) => {
      const [label, ...rest] = row.name.split(' — ');
      return {
        id: row.name,
        label,
        sublabel: rest.join(' — ') || null,
        value: row.opsPerSec,
        tone: 'primary',
        details: [`${grouped(row.opsPerSec)} ops/s`, `${perCall(row.opsPerSec)} per operation`],
      };
    });
  return {
    id: `engine-${subject.id}`,
    title: `${subject.title}: syncom's own benchmarks`,
    subtitle: `${SUBJECT_NOTES[subject.id] ?? ''} ops/s, log scale, higher is better.`,
    unit: 'ops/s',
    scale: 'log',
    groups: [{ id: 'all', label: null, rows }],
  };
};

/** The bars of a row: one, unless the row compares several. */
export const barsOf = (row) => row.bars ?? [{ value: row.value, tone: row.tone }];

export const allValues = (model) =>
  model.groups.flatMap((group) => group.rows.flatMap((row) => barsOf(row).map((bar) => bar.value)));

export const allRows = (model) => model.groups.flatMap((group) => group.rows);

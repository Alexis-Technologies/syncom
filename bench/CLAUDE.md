# bench/CLAUDE.md — Benchmarks

The comparison's own package, the generated charts. what holds for the whole repository is in [CLAUDE.md](../CLAUDE.md).

## Layout

```
bench/                    one file per subject + support/harness.js; run-all.js skips compare.js and report.js
bench/compare/            the cross-library comparison: its OWN package.json (the alternatives, never syncom's
                          devDependencies), adapters/ (one per library), worker.js, size.js
bench/report/             model.mjs (what every chart shows) + svg.mjs (README images); bench/report.js writes both
bench/results/            compare.json, size.json, engine.json — the inputs of the charts, committed
```

## Rules

- **The alternatives are not devDependencies.** They live in `bench/compare/package.json`, installed with
  `pnpm bench:compare:install` (`--ignore-workspace`, its own lockfile); CI never installs them. An adapter
  loads its library on first use (the cold start counts it) and must pass the worker's checks before
  anything is timed — a check that fails measures nothing. Use each library the way its docs show.
- **Charts and tables are generated.** `pnpm bench:report` rewrites the regions between
  `<!-- bench:<name>:start -->` / `:end -->` in README.md and docs/guide/benchmarks.md and the SVGs in
  docs/public/benchmarks/; edit `bench/results/*.json` or the model, never the regions. The docs components
  (`docs/.vitepress/theme/components/Bench*.vue`) import the same `bench/report/model.mjs`.

<script setup>
import BenchCompare from '../.vitepress/theme/components/BenchCompare.vue';
import BenchFigure from '../.vitepress/theme/components/BenchFigure.vue';
</script>

# Compared with CRDT libraries

[Yjs](https://github.com/yjs/yjs), [Automerge](https://automerge.org) and [Loro](https://loro.dev)
are the CRDT libraries JavaScript apps reach for when several people edit the same thing. syncom
merges with CRDTs too: every field of a record is a register, a counter, a set, a list, a text or
a tree, and every node merges them the same way. This page compares the four as CRDT libraries
only: the data types and how they merge, history and versions, encoding and sync, integrity, and
what a developer works with. It leaves out what syncom has as a database (schemas over
collections, queries, indexes, a storage engine) and what the three leave to you;
[Compared with alternatives](/guide/comparison) covers that, next to the databases and sync services.

The three differ among themselves too. Yjs is pure JavaScript, small, fast, and has the most editor
bindings. Automerge is a Rust core compiled to WebAssembly, and keeps every change of a document
in a hash-linked history. Loro is a Rust core compiled to WebAssembly too, with the most container
types (a movable list, a movable tree, rich text) and a document that loads lazily. The table below
compares all four, row by row, from their source code: 141 rows in seven sections.

## What the table shows

- **Three document CRDTs and a record CRDT.** A Yjs, Automerge or Loro document is one tree of
  containers, nested to any depth: a list of maps of texts. A syncom replica is a storage of
  records, and each record is a set of fields, each of one kind. A field may be a path
  (`profile/city`), and a list element or a tree node holds fields of any kind under its id
  (`items/<element>/body` is a text), so a record nests as deep as a document does. A document
  for an editor is one text with embeds and block markers (Automerge's model), not a tree of
  nodes; the one type syncom has no counterpart for is Yjs's XML.
- **The same families of merge rules.** syncom's lists and texts use Fugue (Weidner and Kleppmann,
  2023), as Loro's do. Yjs uses YATA, and Automerge uses RGA. In syncom and Loro two writers' runs
  never interleave. Automerge interleaves runs typed backwards, and a three-replica case can
  interleave in Yjs. syncom and Loro have a movable list (`setAt`/`move`) and a movable tree
  (Kleppmann et al., 2021); Automerge and Yjs have neither, so a move there is a delete and an
  insert. All four mark ranges of text. syncom and Automerge take the expand rule per mark call,
  and Loro per key. Only syncom stacks marks of one name, each with its own id and value
  (comments); the others need a key per comment.
- **What only syncom has.** In thirteen rows syncom alone has the feature built in. In five of
  them none of the other three has it at all: an observed-remove set, one atomic change across
  records (`transact`), named versions (tags of the whole storage), signed changes (Ed25519 per op,
  the node's id is its key), and validation of a peer's change against a schema and hooks. In the
  other eight they have part of it: a hook that can veto or rewrite a local change before it
  commits, refusing a peer's change, purging a payload from the history of every replica it
  reaches, partial replication by scopes that the host enforces, limits against a hostile peer,
  overlapping marks of one name, a schema, and errors with codes.
- **What syncom does not have.** No XML type, no readable losers of a conflict (Automerge's
  `getConflicts`; a lost value is readable in history), no suggestion mode, and no bindings for
  other languages. Where the others have it whole, syncom has part of it: history is kept as long
  as the log's retention says (`retention: 'all'` keeps it all), reading the past needs the log to
  still hold it, a view of the past is read-only (edit through a branch at any version), a record
  loads whole rather than lazily, the hash-linked chain is per node and opt-in, its compatibility
  promise is written but no version has been published to keep it, and its inspector is a function
  (`/inspect`), not a window. The editor bindings (ProseMirror, CodeMirror, any editor through an
  adapter), the UI stores, presence, deltas, per-path events, transactions, undo scopes, forks at
  any version and blame are all built in now, each a subpath.
- **Speed: past Automerge and Yjs on a real trace, behind Loro.** A syncom keystroke is an op
  appended to the log; the text is a copy-on-write rope, O(log n) per keystroke, and the record file
  is written once per deferred window. In memory the pure build (the core with `text` and `sync`,
  no signatures, no chain), every keystroke awaited, types about 74 000 characters a second at the
  end, 48 000 at the start and 38 000 at random, where Automerge types 21 000 to 23 000, Yjs
  342 000 to 461 000 at either end and 28 000 at random, and Loro 294 000 to 609 000; signing
  every keystroke (`/all`) brings syncom to 13 000 to 18 000. Through an editor's handle
  (`openText()`, what the bindings stand on: keystrokes made at once, logged a window later as one
  transaction, a word typed backward one op) it types 322 000 a second at the end and 94 000 at the start — 262 000 and 93 000 on disk, where Yjs's y-leveldb does 19 000 to 21 000 and Loro's append 40 000. The automerge-perf editing trace (259 778 keystrokes) replays in 1.6 seconds (6.8 signed), Yjs in 5, Automerge in 15, Loro in half a second. Typing at the start through a handle is where Yjs and Loro stay five times ahead, and at random — a new run every keystroke — Loro eight times; Yjs, there, types 28 000.
- **Size depends on what is counted.** Yjs ships 28 KB min+gzip, all of it. Automerge and Loro
  ship about 1.1 MB each, almost all of it WebAssembly. syncom's core is 56 KB and the core with
  the `text` plugin 92 KB — the core carries the storage and the op log, which the three do not;
  everything, with the sync protocol, queries, versions and signatures, is 129 KB.
- **History is kept four ways.** Automerge keeps every change forever, in a graph of SHA-256
  hashes, and never drops any. Loro keeps every change too, until you export a shallow snapshot.
  Yjs keeps the current state and the ids of what was deleted, not the changes; reading the past
  needs `gc: false` and a snapshot taken at the time. syncom keeps an op log with retention. It
  reads any version the log still holds, diffs and restores between versions, and keeps named
  tags past retention. `purge()` erases a payload on every replica it reaches.
- **What a replica does with a bad update.** Loro throws and rolls the import back. Yjs throws, but
  keeps what it decoded before the error. Automerge throws on bytes it cannot decode; when we built
  a change with an op on an object that does not exist, it panicked, and the document panicked
  again on its next change. syncom drops and counts what is malformed and never throws for it.
  It also limits what a peer can make it hold (pending work, run and field sizes, tree depth) and
  refuses stamps too far in the future. None of the three checks a peer's change against a rule,
  and none signs one; Automerge's hashes and Loro's and Automerge's checksums detect corruption,
  not forgery.
- **Maturity.** Yjs 13 is the stable line most apps run, and its README lists the products built
  on it. Automerge has been stable since 2.0 (January 2023) and at 3.x since July 2025, Loro since
  1.0 (October 2024). The Yjs column describes its `main` branch, the 14.0 release candidate
  published as `@y/y`; the `yjs` package on npm is still 13.6.33, and the notes say where it
  differs. syncom is a pre-release with no users yet.

## How the table was made

- **From the repositories.** Yjs, Automerge and Loro were cloned on 2026-10-23 and read at the
  commits the Version row names. The code came first: the Rust cores of Automerge and Loro, the
  JavaScript of Yjs, and their tests. Their documentation repositories came next (`yjs-docs`,
  `automerge-docs`, `loro-docs`). Where the documentation and the code disagree, the cell follows
  the code and a note says so.
- **Checked by running it.** Where a claim was cheap to test, it was tested against the published
  package: `yjs` 13.6.33, `@automerge/automerge` 3.5.0, `loro-crdt` 1.16.4. A run counts only where
  the code it exercises is the same at the cloned commit. Interleaving, surrogate pairs, conflicts,
  counters, a reused replica id and malformed updates were settled this way.
- **Packages outside the clones.** Editor bindings, network providers, sync servers, `loro-protocol`
  and `loro-mirror` were not cloned. Their cells name them from the official docs, and a note says
  the code was not read.
- **CRDT features only.** A row is about merging, history, encoding, sync primitives, integrity or
  the developer surface. Queries, collections and storage engines are on
  [Compared with alternatives](/guide/comparison).
- **The syncom column is this repository**, at the version on the page, checked against its tests
  and by running it.
- **The data is in the repository.**
  [`docs/comparison-crdt.json`](https://github.com/Alexis-Technologies/syncom/blob/main/docs/comparison-crdt.json)
  keeps every cell with the file and lines it was decided from. `pnpm docs:comparison` renders it
  into this page. If a cell is wrong, open an issue or edit the data.

## Concepts side by side

The closest counterpart of each building block, in each library. The Yjs column is the 14.0 API;
13.6.33 has `Y.Map`, `Y.Array` and `Y.Text` where 14.0 has one `Y.Node`.

| | syncom | Yjs | Automerge | Loro |
| --- | --- | --- | --- | --- |
| A replica | `open({ path })` | `new Y.Doc()` | `Automerge.init()` | `new LoroDoc()` |
| What merges | a record, by id | the document | the document | the document |
| A map | the record's fields: `update(id, delta)` | `node.setAttr(key, value)` | `change(doc, d => { d.key = value })` | `map.set(key, value)` |
| A counter | `inc(id, key, n)` | — | `new Counter()`, `d.c.increment(n)` | `counter.increment(n)` |
| A set | `add(id, key, items)`, `remove()` | — | — | — |
| A list | `splice(id, key, i, n, items)` | `node.insert(i, items)` | `d.list.insertAt(i, ...items)` | `list.insert(i, value)` |
| A move | `move(id, key, from, to)` | — | — | `movableList.move(from, to)` |
| A text | `splice(id, key, i, n, text)`, `updateText()` | `node.insert(i, text)`, `delete()` | `splice(doc, path, i, n, text)`, `updateText()` | `text.splice(i, n, text)`, `update()` |
| A mark | `mark(id, key, start, end, name, value)` | `node.format(i, n, { name: value })` | `mark(doc, path, { start, end }, name, value)` | `text.mark({ start, end }, key, value)` |
| A cursor | `cursor(id, key, i)`, `index()` | `createRelativePositionFromTypeIndex()` | `getCursor()`, `getCursorPosition()` | `text.getCursor(i)`, `doc.getCursorPos()` |
| A tree | `treeMove(id, key, node, parent)` | — | — | `tree.createNode()`, `node.move()` |
| A change | one call, one op | `doc.transact(fn, origin)` | `change(doc, fn)` | `doc.commit()` |
| Events | `change` and `commit` events | `observe()`, `observeDeep()` | a patch callback | `subscribe()` |
| A version | a vector, an event id, a tag | a state vector, a snapshot | heads (change hashes) | a version vector, frontiers |
| The past | `get(id, { at })` | `createDocFromSnapshot()` | `view(doc, heads)` | `doc.checkout(frontiers)` |
| A diff | `diff(id, from, to)` | `diffDocsToDelta(a, b)` | `diff(doc, from, to)` | `doc.diff(from, to)` |
| Back to a version | `restore(id, at)` | experimental `undoContentIds()` | — | `doc.revertTo(frontiers)` |
| A fork | `branch()` from `/branch` | `Y.cloneDoc(doc)` | `clone(doc)` | `doc.fork()` |
| Undo | `createUndo()` from `/undo` | `new Y.UndoManager(scope)` | — | `new UndoManager(doc)` |
| All of it | `snapshot()` pages | `encodeStateAsUpdate(doc)` | `save(doc)` | `doc.export({ mode: 'snapshot' })` |
| What a peer lacks | ops past its vector | `encodeStateAsUpdate(doc, vector)` | `saveSince(doc, heads)` | `doc.export({ mode: 'update', from })` |
| Taking it in | `storage.sync` (`applyRemote()`) | `Y.applyUpdate(doc, update)` | `loadIncremental(doc, bytes)` | `doc.import(bytes)` |
| Sync protocol | `sync.addNode()` / `sync.unit()` | `y-protocols/sync` | `generateSyncMessage()` | the Loro Protocol (`loro-websocket`) |

## The matrix

<!-- comparison:start -->
<!-- generated by `pnpm docs:comparison` from docs/comparison-crdt.json — edit the data, not this block -->

✅ built in, or in an official package of the same project (named) · ⚠️ partial, opt-in, experimental, with a caveat, or only through a third-party package (named) · ❌ not built in · 🔜 planned by the maintainers, no code yet · — does not apply. The Yjs, Automerge and Loro columns were decided from their repositories as cloned on 2026-10-23 — Yjs `main` at 0e0dc34 (14.0.0-rc.29; npm `latest` is still 13.6.33), Automerge `main` at 5bae775 (3.5.0) with automerge-repo at 3ab7c33 (2.6.0-alpha.5), Loro `main` at 75e4bf2 (1.17.1) — and their official docs; where a claim was cheap to test, the published package was run. The syncom column is this repository.

### Package and platform

<div class="sc-matrix sc-matrix-quad">

<table>
<thead>
<tr>
<th>Feature</th>
<th><a href="https://github.com/Alexis-Technologies/syncom">syncom</a><br><sub>sync engine</sub></th>
<th><a href="https://github.com/yjs/yjs">Yjs</a><br><sub>CRDT library</sub></th>
<th><a href="https://github.com/automerge/automerge">Automerge</a><br><sub>CRDT library</sub></th>
<th><a href="https://github.com/loro-dev/loro">Loro</a><br><sub>CRDT library</sub></th>
</tr>
</thead>
<tbody>
<tr class="sc-matrix-group"><td colspan="5"><strong>Package and license</strong></td></tr>
<tr><td>Version compared</td><td><code>@alexify/syncom</code> 0.0.1 at <code>de85f88</code>; never published to npm<sup>1</sup></td><td><code>@y/y</code> 14.0.0-rc.29 at 0e0dc34; npm <code>latest</code> is <code>yjs</code> 13.6.33<sup>2</sup></td><td><code>@automerge/automerge</code> 3.5.0 at 5bae775 (= npm <code>latest</code>); Rust crate 0.12.0<sup>3</sup></td><td><code>loro-crdt</code> 1.17.1 at commit 75e4bf2</td></tr>
<tr><td>Release status</td><td>pre-release, unpublished; repository started in 2026-09</td><td>v14 release candidate; v13 is the stable line<sup>4</sup></td><td>stable: 3.x since July 2025, 2.0 in Jan 2023; LICENSE from 2019<sup>5</sup></td><td>stable 1.x since 1.0.0 (2024-10-21); open source since 2023-11</td></tr>
<tr><td>License</td><td>MIT, every subpath included; wrpc, the transport, MIT too<sup>6</sup></td><td>MIT; y-protocols, y-indexeddb, y-leveldb and y-crdt also MIT</td><td>MIT: core, WASM, JS, C, automerge-repo and its adapters<sup>7</sup></td><td>MIT (core, <code>@loro-dev/fractional-index</code>, Loro Protocol packages)<sup>8</sup></td></tr>
<tr><td>Maintained by</td><td>Alex Dolid (Alexis Technologies)</td><td>Kevin Jahns (dmonad), sponsor-funded independent maintainer<sup>9</sup></td><td>Ink &amp; Switch; Alex Good and Orion Henry work on it full time</td><td>Loro team (Zixuan Chen, Liang Zhao), GitHub org <code>loro-dev</code></td></tr>
<tr class="sc-matrix-group"><td colspan="5"><strong>Implementation and runtimes</strong></td></tr>
<tr><td>Implementation</td><td>pure JavaScript: CommonJS, no build step</td><td>pure JavaScript (ESM source, JSDoc types), no build step</td><td>Rust core compiled to WASM (wasm-bindgen), TypeScript wrapper with proxies</td><td>Rust core compiled to WASM with wasm-bindgen<sup>10</sup></td></tr>
<tr><td>Runtime dependencies of the core package</td><td>0<sup>11</sup></td><td>1: <code>lib0</code> (^1.0.0-rc.35), by the same maintainer<sup>12</sup></td><td>0: no <code>dependencies</code>; the WASM binary ships inside the package</td><td>0 <code>dependencies</code></td></tr>
<tr><td>WebAssembly</td><td>— none: pure JavaScript</td><td>— not used: pure JS; <code>ywasm</code> is a separate Rust build</td><td>required: 3.6 MB <code>.wasm</code> (1.1 MB gzip), loaded per export condition<sup>13</sup></td><td>required; entries load it sync (Node, browser), async (<code>web</code>) or inline (<code>base64</code>)<sup>14</sup></td></tr>
<tr><td>Other languages</td><td>❌ javaScript only</td><td>✅ Rust <code>yrs</code>, JS <code>ywasm</code>, C <code>yffi</code>; Python, Ruby, .NET, Swift, Kotlin on yrs<sup>15</sup></td><td>✅ Rust crate and C API in repo; docs list Python, Swift, R<sup>16</sup></td><td>✅ Rust <code>loro</code>, Swift <code>loro-swift</code>, Python <code>loro-py</code>; C# and Go by the community<sup>17</sup></td></tr>
<tr><td>JavaScript runtimes</td><td>node.js ≥ 22 (CI on 22 and 24); browsers through OPFS or IndexedDB<sup>18</sup></td><td>ESM only; Node ≥ 22 and browsers; CI on Node 26<sup>19</sup></td><td>Node (CI tests 18), browsers, Workers (<code>workerd</code>), Deno; React Native via docs recipe<sup>20</sup></td><td>Node, browsers, Deno, Bun (all run in CI); no <code>engines</code> field<sup>21</sup></td></tr>
<tr><td>TypeScript types</td><td>✅ hand-written, <code>tsd</code>-tested; records typed from the entity's Standard Schema or <code>Schema&lt;Shapes&gt;</code></td><td>✅ generated <code>.d.ts</code> from JSDoc; generic <code>Y.Node&lt;DConf&gt;</code> types attrs and children<sup>22</sup></td><td>✅ shipped <code>.d.ts</code> from TS source; generic <code>Doc&lt;T&gt;</code>, <code>change&lt;T&gt;</code>, <code>from&lt;T&gt;</code><sup>23</sup></td><td>✅ shipped .d.ts: wasm-bindgen output plus hand-written generics (<code>LoroDoc&lt;T&gt;</code>, <code>LoroMap&lt;T&gt;</code>)</td></tr>
<tr><td>API style</td><td>async methods by record id; live <code>Record</code> objects stage edits and <code>save()</code><sup>24</sup></td><td>mutable shared objects; every call synchronous</td><td>immutable doc; <code>change(doc, d =&gt; …)</code> mutates a proxy, returns a new doc; synchronous<sup>25</sup></td><td>mutable container handles; synchronous calls that throw on error</td></tr>
</tbody>
</table>

</div>

### Document model

<div class="sc-matrix sc-matrix-quad">

<table>
<thead>
<tr>
<th>Feature</th>
<th><a href="https://github.com/Alexis-Technologies/syncom">syncom</a><br><sub>sync engine</sub></th>
<th><a href="https://github.com/yjs/yjs">Yjs</a><br><sub>CRDT library</sub></th>
<th><a href="https://github.com/automerge/automerge">Automerge</a><br><sub>CRDT library</sub></th>
<th><a href="https://github.com/loro-dev/loro">Loro</a><br><sub>CRDT library</sub></th>
</tr>
</thead>
<tbody>
<tr class="sc-matrix-group"><td colspan="5"><strong>What merges</strong></td></tr>
<tr><td>The unit that merges</td><td>a record: a JSON object with an id, many per storage<sup>26</sup></td><td><code>Y.Doc</code>: named root nodes plus nested subdocuments</td><td>a document: one root map tree plus its full hash-linked change history</td><td>a <code>LoroDoc</code>: its op log (history) plus the state of named root containers</td></tr>
<tr><td>Many units in one place</td><td>✅ a storage holds records by id, in collections, with queries</td><td>⚠️ subdocuments: a <code>Y.Doc</code> as a value, addressed by <code>guid</code><sup>27</sup></td><td>✅ automerge-repo <code>Repo</code>: <code>automerge:</code> URLs, <code>create</code>/<code>find</code>, sync per document<sup>28</sup></td><td>❌ one <code>LoroDoc</code> per document; no registry or subdocuments<sup>29</sup></td></tr>
<tr><td>Data types</td><td>register, counter, OR-set, list (movable), text (with marks), tree</td><td>one <code>Y.Node</code>: attrs (map), children (list or text), formats, name<sup>30</sup></td><td>map, list, text (with marks and block markers); <code>Counter</code> as a scalar<sup>31</sup></td><td>Map, List, MovableList, Text (rich text), Tree, Counter</td></tr>
<tr><td>Nested types</td><td>✅ fields by path (<code>profile/city</code>), each of any kind; a list element or a tree node holds fields under its id</td><td>✅ any node holds nodes in its attrs and its children<sup>32</sup></td><td>✅ any depth: maps and lists hold maps, lists and texts; root is a map<sup>33</sup></td><td>✅ Map, List and MovableList hold any container; each tree node holds a map<sup>34</sup></td></tr>
<tr><td>How a structure is created</td><td>by field name: the first op decides the kind (<code>inc</code>, <code>add</code>, <code>splice</code>, <code>treeMove</code>)<sup>35</sup></td><td><code>ydoc.get(key)</code>: roots by name, no create op; same node everywhere<sup>36</sup></td><td>one root map; children created by ops; same-key concurrent creation conflicts<sup>37</sup></td><td>roots by name and type (<code>getMap("x")</code>) merge across replicas; children are minted by ops<sup>38</sup></td></tr>
<tr><td>Plain values a field holds</td><td>JSON only; other values pass through <code>JSON.stringify</code> (<code>Date</code> → string)<sup>39</sup></td><td>JSON, <code>Uint8Array</code>, <code>undefined</code>, <code>bigint</code>, <code>Date</code>, nodes, docs<sup>40</sup></td><td>str, int, uint, f64, bool, null, <code>Date</code>, <code>Uint8Array</code>, <code>Counter</code>, <code>ImmutableString</code><sup>41</sup></td><td>JSON values, <code>Uint8Array</code>, container refs; <code>undefined</code> becomes <code>null</code><sup>42</sup></td></tr>
<tr><td>A plain nested object</td><td>one register: replaced whole, the newer writer wins<sup>43</sup></td><td>atomic: one value, replaced whole<sup>44</sup></td><td>becomes a nested map: its keys merge one by one; reassigning replaces it<sup>45</sup></td><td>one atomic value, replaced whole by the map's LWW</td></tr>
<tr><td>Two types created at one key concurrently</td><td>fixed precedence, not stamps: register &gt; counter &gt; set &gt; list &gt; text &gt; tree<sup>46</sup></td><td>one node wins by <code>clientID</code>; the loser and its content are deleted<sup>47</sup></td><td>one wins by op id; the loser stays, readable through <code>getConflicts</code><sup>48</sup></td><td>Map LWW shows one; the loser stays readable by its container id<sup>49</sup></td></tr>
<tr><td>Schema of a document</td><td>✅ entity schemas, injected validator (Standard Schema, a function, <code>compile</code>)<sup>50</sup></td><td>⚠️ type-level <code>Y.Node&lt;DConf&gt;</code>; <code>$node</code> checks only the name<sup>51</sup></td><td>❌ none; <code>load&lt;T&gt;</code> trusts <code>T</code>, migrations are the app's job<sup>52</sup></td><td>⚠️ none in core; <code>loro-mirror</code> declares a schema for its state view<sup>53</sup></td></tr>
<tr class="sc-matrix-group"><td colspan="5"><strong>Identity, clocks and versions</strong></td></tr>
<tr><td>Replica identity</td><td><code>nodeId</code>: with <code>/signing</code>, the Ed25519 public key (43 base64url characters); without it, what <code>getId</code> mints</td><td><code>doc.clientID</code>: random 53-bit integer, new per <code>Doc</code>; app may set it<sup>54</sup></td><td>actor ID: bytes (hex in JS), 16 random by default, app may set it<sup>55</sup></td><td>random u64 <code>PeerID</code> per <code>LoroDoc</code>; settable with <code>setPeerId()</code></td></tr>
<tr><td>Two replicas with one id</td><td>⚠️ one open per directory (lock); <code>SELF</code> and <code>REWOUND</code> caught at hello<sup>56</sup></td><td>⚠️ regenerates on seeing its own id; replicas may already have diverged<sup>57</sup></td><td>⚠️ detected at merge: <code>duplicate seq N found for actor</code> error; no recovery<sup>58</sup></td><td>⚠️ importing a clashing op id throws <code>UsedOpID</code>; nothing regenerates the id<sup>59</sup></td></tr>
<tr><td>A user above replica ids</td><td>✅ <code>actor</code> on every op (<code>open({ actor })</code> or per write), signed and replicated<sup>60</sup></td><td>⚠️ no: the app maps <code>clientID</code>s to users<sup>61</sup></td><td>✅ <code>author</code> (hex) mapped to many actors: <code>getAuthors</code>, <code>getActorsForAuthor</code> (3.5.0)<sup>62</sup></td><td>⚠️ no: map peer ids to users, e.g. in <code>subscribeFirstCommitFromPeer</code></td></tr>
<tr><td>Operation id</td><td><code>(origin, seq)</code> per origin and scope stream, plus its stamp <code>ts</code><sup>63</sup></td><td><code>ID(client, clock)</code> per element; a run shares one item<sup>64</sup></td><td><code>counter@actor</code>: op counter, then actor, e.g. <code>2@aaaa01</code></td><td><code>{ peer, counter }</code> per op; each change also carries a Lamport</td></tr>
<tr><td>Clock behind the merge order</td><td>hybrid wall clock <code>max(Date.now(), last + 1)</code> that observes peers; vectors for delivery<sup>65</sup></td><td>per-client counters (state vector); no Lamport merge, no wall time<sup>66</sup></td><td>Lamport op counters (max seen + 1); causality via the change-hash DAG<sup>67</sup></td><td>Lamport; ties broken by larger peer id</td></tr>
<tr><td>Wall-clock time on a change</td><td>✅ always: each op's <code>ts</code> is milliseconds and the merge order<sup>68</sup></td><td>❌ no timestamp on a change<sup>69</sup></td><td>✅ per-change <code>time</code> (seconds), on by default; advisory, not in merge order<sup>70</sup></td><td>⚠️ opt-in <code>setRecordTimestamp(true)</code>, in seconds; never used for merge order<sup>71</sup></td></tr>
<tr><td>A version</td><td>a version vector <code>{ 'origin@scope': seq }</code> as JSON; event ids, stamps, tags<sup>72</sup></td><td>state vector (client → next clock), varint binary; snapshot adds deletes<sup>73</sup></td><td>heads: an array of SHA-256 change hashes as hex strings<sup>74</sup></td><td><code>VersionVector</code> (peer→counter) and <code>Frontiers</code> (<code>OpId[]</code>), both encodable</td></tr>
<tr><td>Compare two versions</td><td>✅ <code>compareVectors(a, b)</code>: -1, 0, 1, or undefined when concurrent</td><td>⚠️ <code>snapshotContainsUpdate</code>, <code>equalSnapshots</code>; no ahead/behind/concurrent test<sup>75</sup></td><td>⚠️ <code>hasHeads(doc, heads)</code> tests inclusion; no ahead/behind/concurrent compare<sup>76</sup></td><td>✅ <code>vv.compare(other)</code> and <code>doc.cmpFrontiers(a, b)</code> return -1/0/1/undefined</td></tr>
</tbody>
</table>

</div>

### Data types

<div class="sc-matrix sc-matrix-quad">

<table>
<thead>
<tr>
<th>Feature</th>
<th><a href="https://github.com/Alexis-Technologies/syncom">syncom</a><br><sub>sync engine</sub></th>
<th><a href="https://github.com/yjs/yjs">Yjs</a><br><sub>CRDT library</sub></th>
<th><a href="https://github.com/automerge/automerge">Automerge</a><br><sub>CRDT library</sub></th>
<th><a href="https://github.com/loro-dev/loro">Loro</a><br><sub>CRDT library</sub></th>
</tr>
</thead>
<tbody>
<tr class="sc-matrix-group"><td colspan="5"><strong>Registers and maps</strong></td></tr>
<tr><td>Map / object type</td><td>✅ a record: <code>insert</code>, <code>get</code>, <code>update</code>, <code>set</code>, <code>delete</code>, a live <code>Record</code></td><td>✅ <code>Y.Node</code> attrs: <code>setAttr</code>, <code>getAttr</code>, <code>deleteAttr</code>, <code>hasAttr</code>, <code>getAttrs</code><sup>77</sup></td><td>✅ JS object proxy: <code>d.k = v</code>, <code>delete d.k</code>; Rust <code>put</code>, <code>get</code>, <code>get_all</code></td><td>✅ <code>LoroMap</code>: <code>set</code>, <code>get</code>, <code>delete</code>, <code>setContainer</code>, <code>ensureMergeable*</code>, <code>keys</code></td></tr>
<tr><td>Concurrent writes to one key</td><td>per field by <code>(ts, origin)</code>: the wall-clock stamp, then the node id</td><td>the unseen concurrent write with higher <code>clientID</code> wins, not wall-clock<sup>78</sup></td><td>greater op id wins (counter, then actor); not wall-clock</td><td>higher Lamport wins, then larger peer id; no wall clock</td></tr>
<tr><td>Losing values readable</td><td>❌ no multi-value register; a lost value is readable only in history</td><td>❌ losing values are deleted, not readable<sup>79</sup></td><td>✅ <code>getConflicts(obj, key)</code> returns every concurrent value; Rust <code>get_all</code><sup>80</sup></td><td>❌ no; the losing values are reachable only through history</td></tr>
<tr><td>Delete a key</td><td>✅ <code>unset(id, fields)</code>: an <code>unset</code> op, a tombstone an older concurrent <code>set</code> loses to</td><td>✅ <code>deleteAttr(key)</code>; a concurrent set survives the delete<sup>81</sup></td><td>✅ <code>delete d.k</code>; a concurrent set beats the delete</td><td>✅ <code>map.delete(key)</code>; against a concurrent set, the same Lamport+peer LWW</td></tr>
<tr><td>Clear a map</td><td>✅ <code>set(id, {})</code> or <code>delete(id)</code>: a reset; newer concurrent ops survive<sup>82</sup></td><td>✅ <code>clearAttrs()</code>: deletes visible keys in one change; concurrent sets survive<sup>83</sup></td><td>❌ no clear op; delete keys one by one or reassign the parent<sup>84</sup></td><td>⚠️ <code>map.clear()</code> writes one delete per present key<sup>85</sup></td></tr>
<tr><td>Key order when read</td><td>as each node's object took the keys; replicas can differ<sup>86</sup></td><td>local <code>Map</code> insertion order; can differ between replicas<sup>87</sup></td><td>sorted by key in the core; a live JS doc appends newly added keys<sup>88</sup></td><td><code>keys()</code>/<code>entries()</code> sorted by key; <code>toJSON()</code> order unspecified</td></tr>
<tr class="sc-matrix-group"><td colspan="5"><strong>Counters and sets</strong></td></tr>
<tr><td>Counter type</td><td>✅ <code>inc(id, key, value)</code>: one running sum per origin, added up</td><td>❌ no counter type<sup>89</sup></td><td>✅ <code>Counter</code> class: <code>increment(n)</code>, <code>decrement(n)</code>, <code>.value</code></td><td>✅ <code>LoroCounter</code>: <code>increment(n)</code>, <code>decrement(n)</code>, <code>value</code></td></tr>
<tr><td>Counter values</td><td>finite floats; a negative <code>inc</code> decrements; each origin's sum within ±2^53−1<sup>90</sup></td><td>— no counter type</td><td>64-bit integer; decrement allowed; fractional deltas truncated<sup>91</sup></td><td>f64 floats; decrement; no bounds or overflow checks</td></tr>
<tr><td>A counter reset while others add</td><td>a reset drops increments stamped below it; a register outranks the counter<sup>92</sup></td><td>— no counter type</td><td>an overwrite or delete wins; concurrent increments are dropped<sup>93</sup></td><td>no reset op; a concurrent increment lands in the deleted counter, hidden<sup>94</sup></td></tr>
<tr><td>Set type (concurrent adds kept)</td><td>✅ oR-set field: <code>add()</code> / <code>remove()</code>; a concurrent add survives a remove<sup>95</sup></td><td>❌ no set type; map keys behave add-wins<sup>96</sup></td><td>❌ no set type; the docs give no set recipe</td><td>❌ no set type; map keys give LWW, not add-wins</td></tr>
<tr class="sc-matrix-group"><td colspan="5"><strong>Lists</strong></td></tr>
<tr><td>List type</td><td>✅ list field: <code>splice</code>, <code>push</code>, <code>setAt</code>, <code>move</code>, <code>cursor</code> / <code>index</code></td><td>✅ <code>Y.Node</code> children: <code>insert</code>, <code>push</code>, <code>unshift</code>, <code>delete</code>, <code>get</code>, <code>slice</code><sup>97</sup></td><td>✅ JS array proxy: <code>push</code>, <code>unshift</code>, <code>insertAt</code>, <code>deleteAt</code>, <code>splice</code>, index assign</td><td>✅ <code>LoroList</code> and <code>LoroMovableList</code>: <code>insert</code>, <code>delete</code>, <code>push</code>, <code>pop</code>, <code>get</code></td></tr>
<tr><td>List merge algorithm</td><td>Fugue (Weidner &amp; Kleppmann 2023), not FugueMax; movable per Kleppmann 2020<sup>98</sup></td><td>YATA (Nicolaescu, Jahns et al., 2016) with an added <code>originRight</code><sup>99</sup></td><td>RGA, as the docs name it; no paper cited</td><td>Fugue, merged by Eg-walker-style replay; MovableList moves per Kleppmann 2020</td></tr>
<tr><td>Concurrent inserts at one spot</td><td>✅ never: each writer's run stays whole, forward and backward<sup>100</sup></td><td>⚠️ two runs stay whole, forward or backward; a three-replica case interleaves<sup>101</sup></td><td>⚠️ forward runs stay whole; runs typed backwards interleave element by element<sup>102</sup></td><td>✅ no interleaving, forward or backward</td></tr>
<tr><td>Insert and delete ranges</td><td>✅ <code>splice(id, key, index, count, items)</code>: one op for both</td><td>✅ <code>insert(i, [many])</code> and <code>delete(i, n)</code> in one call</td><td>✅ <code>splice(i, n, ...items)</code>, <code>insertAt(i, ...items)</code>, <code>deleteAt(i, n)</code></td><td>⚠️ <code>delete(pos, len)</code> takes a range; <code>insert</code> takes one value per call<sup>103</sup></td></tr>
<tr><td>Replace an element in place</td><td>✅ <code>setAt(id, key, index, value)</code>: a value register per element, newer stamp wins<sup>104</sup></td><td>❌ no in-place assign; delete and insert<sup>105</sup></td><td>✅ <code>d.l[i] = v</code> writes in place; concurrent assigns conflict, op id wins<sup>106</sup></td><td>✅ <code>LoroMovableList.set(i, v)</code>; concurrent sets keep one, by Lamport+peer<sup>107</sup></td></tr>
<tr><td>Move an element</td><td>✅ <code>move(id, key, from, to)</code>; two concurrent moves leave the element once<sup>108</sup></td><td>❌ no move op<sup>109</sup></td><td>❌ no move op; assigning an existing object elsewhere throws</td><td>✅ <code>LoroMovableList.move(from, to)</code>; the element stays once, last mover wins</td></tr>
<tr><td>Concurrent move and delete</td><td>the move wins: the element comes back at the new place<sup>110</sup></td><td>— no move op</td><td>— no move op</td><td>the move wins: the element comes back at its new place<sup>111</sup></td></tr>
<tr><td>Containers inside a list</td><td>✅ an element holds fields of any kind under its id: <code>items/&lt;element&gt;/title</code>, <code>items/&lt;element&gt;/body</code> a text</td><td>✅ children may be nodes: lists of maps of texts</td><td>✅ lists hold maps, lists and texts at any depth</td><td>✅ <code>insertContainer</code>/<code>pushContainer</code>; <code>setContainer</code> on MovableList</td></tr>
<tr><td>Runs stored compactly</td><td>✅ content run-length encoded; a writer's next keystroke extends its own run<sup>112</sup></td><td>✅ consecutive inserts by one client merge into one item<sup>113</sup></td><td>✅ columnar RLE/delta op columns, kept compressed in memory since 3.0</td><td>✅ consecutive ops of one peer merge into runs and changes; columnar blocks</td></tr>
<tr class="sc-matrix-group"><td colspan="5"><strong>Text</strong></td></tr>
<tr><td>Text type</td><td>✅ text field: <code>splice</code>, <code>push</code>, <code>updateText</code>, <code>mark</code>, <code>spans</code>, <code>cursor</code></td><td>✅ text is a node's string children: <code>insert</code>, <code>delete</code>, <code>format</code>, <code>toString</code><sup>114</sup></td><td>✅ a JS <code>string</code> field is collaborative text; edit with <code>splice</code>, <code>updateText</code><sup>115</sup></td><td>✅ <code>LoroText</code>: <code>insert</code>, <code>delete</code>, <code>splice</code>, <code>mark</code>, <code>toDelta</code>, <code>update</code></td></tr>
<tr><td>Text merge algorithm</td><td>Fugue, the same engine as lists (<code>src/text/sequence.js</code>)</td><td>the same YATA list engine as lists</td><td>the same RGA as lists; marks follow Peritext</td><td>same Fugue tracker as lists, Eg-walker-style replay; state in a B-tree rope</td></tr>
<tr><td>Index units</td><td>UTF-16 code units, as <code>String#slice</code> counts them; no other units</td><td>UTF-16 code units; no other unit in the JS API<sup>116</sup></td><td>UTF-16 code units in JS; Rust also offers code points, UTF-8, graphemes<sup>117</sup></td><td>UTF-16 by default; <code>insertUtf8</code>/<code>deleteUtf8</code> and <code>convertPos</code> for code points and UTF-8</td></tr>
<tr><td>A split surrogate pair</td><td>✅ refused: an index between the halves of a pair is <code>SURROGATE</code>; <code>updateText</code> diffs by code points</td><td>⚠️ a split pair becomes two U+FFFD; no error<sup>118</sup></td><td>✅ an index inside a pair rounds to the whole character; never splits it<sup>119</sup></td><td>✅ throws <code>UTF16InUnicodeCodePoint</code>; the text is unchanged</td></tr>
<tr><td>Splice at an index</td><td>✅ <code>splice(id, key, index, count, text)</code>; past the end is <code>OUT_OF_RANGE</code></td><td>✅ <code>insert(index, string, formats?)</code> and <code>delete(index, length)</code></td><td>✅ <code>splice(doc, path, index | cursor, del, text)</code>; negative <code>del</code> deletes backwards</td><td>✅ <code>insert(pos, s)</code>, <code>delete(pos, len)</code>, <code>splice(pos, len, s)</code></td></tr>
<tr><td>Set a whole new string (diff)</td><td>✅ <code>updateText(id, key, text)</code>: Myers over UTF-16, one splice per hunk<sup>120</sup></td><td>❌ no set-whole-string API<sup>121</sup></td><td>✅ <code>updateText(doc, path, s)</code>: Myers diff over grapheme clusters<sup>122</sup></td><td>✅ <code>text.update(s)</code> (Myers diff) and <code>updateByLine(s)</code>; <code>timeoutMs</code> option<sup>123</sup></td></tr>
<tr><td>Delta format</td><td>✅ <code>toDelta(changes)</code> and <code>applyDelta(id, key, delta)</code>: Quill's form, embeds and marks included</td><td>✅ lib0 deltas in and out: <code>toDelta()</code>, <code>applyDelta()</code>, <code>event.delta</code><sup>124</sup></td><td>❌ no Quill deltas; <code>spans()</code>/<code>updateSpans()</code> and patches instead</td><td>✅ <code>toDelta()</code>, <code>applyDelta()</code>, <code>sliceDelta()</code>; text events are deltas</td></tr>
<tr><td>Embeds in text</td><td>✅ <code>insertEmbed(id, key, index, { type, attrs })</code>: a slot (U+FFFC) whose marker is a register, marked like a character</td><td>✅ JSON objects or nodes inside text</td><td>✅ block markers (inline maps); <code>isEmbed: true</code> schema convention for images</td><td>❌ strings only; a delta insert must be text</td></tr>
<tr><td>Long documents</td><td>a copy-on-write rope, O(log n) per keystroke; the B4 trace (260k edits) in 1.6 s, 23 MB of JS heap after it (its log held in memory included)</td><td>one item per typed run; B4 (105k chars): 160 KB doc, 3.2 MB heap<sup>125</sup></td><td>every keystroke kept; a 260k-edit trace saves to 129 KB, loads in 0.13 s<sup>126</sup></td><td>B-tree text, O(log n) edits; 260k-op trace: 231 KB, 6 ms parse<sup>127</sup></td></tr>
<tr class="sc-matrix-group"><td colspan="5"><strong>Rich text</strong></td></tr>
<tr><td>Formatting marks</td><td>✅ <code>mark()</code>, <code>unmark()</code>, <code>unmarkById()</code>, <code>spans()</code>: ranges between two anchors</td><td>✅ <code>format(index, length, { key: value })</code>; <code>insert</code> takes formats<sup>128</sup></td><td>✅ <code>mark(doc, path, {start, end, expand}, name, value)</code>, <code>unmark</code>, <code>marks</code>, <code>marksAt</code><sup>129</sup></td><td>✅ <code>text.mark({ start, end }, key, value)</code>, <code>unmark(range, key)</code><sup>130</sup></td></tr>
<tr><td>Typing at a mark's edge</td><td>✅ per mark call: <code>expand: 'after' | 'before' | 'both' | 'none'</code><sup>131</sup></td><td>⚠️ none: an insert carries only the formats it names<sup>132</sup></td><td>✅ per mark call: <code>before</code>, <code>after</code>, <code>both</code>, <code>none</code>; default <code>after</code><sup>133</sup></td><td>✅ per key via <code>configTextStyle</code>: before, after, both or none</td></tr>
<tr><td>Overlapping marks of one name</td><td>✅ <code>{ many: true }</code> marks stack, each with its own id and value<sup>134</sup></td><td>⚠️ one value per key at any position<sup>135</sup></td><td>⚠️ one value per name per character; overlaps split, the greater op wins<sup>136</sup></td><td>⚠️ one value per key per character; <code>comment:&lt;id&gt;</code> keys overlap<sup>137</sup></td></tr>
<tr><td>Remove a mark</td><td>✅ <code>unmark(range, name)</code> is a null mark; the newer stamp wins against a mark<sup>138</sup></td><td>✅ <code>format(i, n, { key: null })</code>; marker order decides against a concurrent mark</td><td>✅ <code>unmark(doc, path, range, name)</code>; against a concurrent mark, op id decides<sup>139</sup></td><td>✅ <code>unmark(range, key)</code>; against a concurrent mark, Lamport+peer LWW</td></tr>
<tr><td>Concurrent marks of one name</td><td>the newest stamp <code>(ts, origin)</code> covering the character</td><td>the marker later in list order wins; ties by <code>clientID</code>, not time</td><td>per character, the greater op id (counter, then actor) wins</td><td>per character, higher Lamport then larger peer wins</td></tr>
<tr><td>Blocks (paragraphs, headings)</td><td>✅ block markers in the text (<code>splitBlock</code>, <code>joinBlock</code>, <code>updateBlock</code>, <code>blocks()</code>), <code>{ type, parents, attrs }</code></td><td>✅ named child nodes (<code>new Y.Node('p')</code>), or Quill-style newline formats</td><td>✅ block markers: <code>splitBlock</code>, <code>joinBlock</code>, <code>updateBlock</code>, <code>block</code>, <code>spans</code><sup>140</sup></td><td>❌ no block markers; model blocks as containers</td></tr>
<tr><td>XML / DOM-like type</td><td>❌ none</td><td>✅ <code>Y.Node(name)</code>: name, attrs, children; <code>toString()</code> renders XML<sup>141</sup></td><td>❌ no element tree type; block markers with <code>parents</code> paths instead</td><td>❌ no XML type; use Map, List or Tree</td></tr>
<tr><td>Editor bindings</td><td>✅ <code>/prosemirror</code> and <code>/codemirror</code> (the editor's modules injected), <code>/editor</code> for any editor through a three-function adapter</td><td>✅ y-prosemirror (Tiptap, BlockNote), y-quill, y-codemirror, y-monaco; Lexical native<sup>142</sup></td><td>✅ official <code>automerge-prosemirror</code> and <code>automerge-codemirror</code> (outside the clones)<sup>143</sup></td><td>✅ <code>loro-prosemirror</code> (works with Tiptap) and <code>loro-codemirror</code><sup>144</sup></td></tr>
<tr class="sc-matrix-group"><td colspan="5"><strong>Positions and trees</strong></td></tr>
<tr><td>Stable cursor</td><td>✅ <code>cursor(id, key, index)</code> → a string; <code>index(id, key, cursor)</code> reads it back</td><td>✅ <code>createRelativePositionFromTypeIndex</code> and <code>createAbsolutePositionFromRelativePosition</code><sup>145</sup></td><td>✅ <code>getCursor(doc, path, index)</code>, <code>getCursorPosition</code>; <code>splice</code> accepts a cursor<sup>146</sup></td><td>✅ <code>text.getCursor(pos, side)</code> → <code>Cursor</code>; <code>doc.getCursorPos(cursor)</code></td></tr>
<tr><td>Cursor side (affinity)</td><td>✅ <code>side: 'before'</code> (the default) or <code>'after'</code></td><td>✅ <code>assoc</code>: ≥ 0 sticks to the next element, &lt; 0 to the previous</td><td>⚠️ anchored to the character at the index; <code>move</code> only sets the deletion fallback<sup>147</sup></td><td>✅ <code>Side</code> -1 (before), 0, 1 (after) at <code>getCursor</code></td></tr>
<tr><td>Cursor as a value to keep or send</td><td>✅ a string (<code>&lt;elem</code>, <code>&gt;elem</code>, <code>^</code>, <code>$</code>) to keep or send</td><td>✅ bytes (<code>encodeRelativePosition</code>) or JSON (<code>relativePositionToJSON</code>)</td><td>✅ a string such as <code>8@00</code>, <code>s</code>, <code>e</code>; Rust <code>Cursor::to_bytes()</code></td><td>✅ <code>cursor.encode()</code> bytes, <code>Cursor.decode(bytes)</code></td></tr>
<tr><td>Cursor into deleted content</td><td>the next visible element; <code>null</code> once a reset (or <code>compact</code>) dropped it<sup>148</sup></td><td>the gap where the element was; <code>null</code> once collected<sup>149</sup></td><td>resolves to the next (<code>after</code>, default) or previous visible element</td><td>resolves to where it was, plus an <code>update</code> cursor on live content<sup>150</sup></td></tr>
<tr><td>Fractional indexes</td><td>✅ <code>@alexify/syncom/order</code>: <code>between</code>, <code>spread</code>, <code>compare</code>, <code>isKey</code></td><td>❌ no fractional-index helper</td><td>❌ no fractional-index helper</td><td>✅ <code>@loro-dev/fractional-index</code> (TS) and Rust <code>loro_fractional_index</code><sup>151</sup></td></tr>
<tr><td>Movable tree type</td><td>✅ tree field: <code>treeMove(id, key, node, parent, { after | before })</code>, <code>treeRemove</code></td><td>⚠️ no movable tree; third-party <code>yjs-orderedtree</code> builds one on maps<sup>152</sup></td><td>❌ no tree type</td><td>✅ <code>LoroTree</code>: <code>createNode</code>, <code>move</code>, <code>moveBefore</code>/<code>moveAfter</code>, <code>delete</code></td></tr>
<tr><td>Concurrent moves that would form a cycle</td><td>Kleppmann et al. 2021: moves fold in stamp order, the cyclic one skipped<sup>153</sup></td><td>— no movable tree</td><td>— no tree type</td><td>Kleppmann 2021: moves applied in Lamport order, a cycle-making move is ignored<sup>154</sup></td></tr>
<tr><td>Order among siblings</td><td>ordered: a fractional index per move, ties broken by stamp</td><td>— no movable tree; nested nodes' children are an ordered list</td><td>— no tree type</td><td>ordered siblings by fractional index, on by default; <code>index()</code><sup>155</sup></td></tr>
<tr><td>Delete a subtree</td><td>✅ <code>treeRemove</code> moves it under <code>$trash</code> with its subtree; moving it out restores it<sup>156</sup></td><td>— no movable tree; deleting a node deletes its subtree<sup>157</sup></td><td>— no tree type</td><td>✅ <code>delete(id)</code> hides the subtree; a node moved into it is hidden too<sup>158</sup></td></tr>
<tr><td>Data on a node</td><td>✅ a node holds fields under its id (<code>outline/&lt;node&gt;/title</code>); the tree reads as <code>{ id, data, children }</code></td><td>— no movable tree; a nested node carries its own attrs</td><td>— no tree type</td><td>✅ a <code>LoroMap</code> per node (<code>node.data</code>)</td></tr>
</tbody>
</table>

</div>

### Changes and events

<div class="sc-matrix sc-matrix-quad">

<table>
<thead>
<tr>
<th>Feature</th>
<th><a href="https://github.com/Alexis-Technologies/syncom">syncom</a><br><sub>sync engine</sub></th>
<th><a href="https://github.com/yjs/yjs">Yjs</a><br><sub>CRDT library</sub></th>
<th><a href="https://github.com/automerge/automerge">Automerge</a><br><sub>CRDT library</sub></th>
<th><a href="https://github.com/loro-dev/loro">Loro</a><br><sub>CRDT library</sub></th>
</tr>
</thead>
<tbody>
<tr class="sc-matrix-group"><td colspan="5"><strong>Writing</strong></td></tr>
<tr><td>Group edits into one change</td><td>✅ <code>transact(fn)</code>: several writes, several records, one log append, all or none</td><td>✅ <code>doc.transact(fn, origin)</code>: one event round, one update for peers<sup>159</sup></td><td>✅ <code>change(doc, fn)</code> is one change: one hash, one callback; a throw rolls back<sup>160</sup></td><td>✅ an implicit transaction closed by <code>commit()</code>: one event batch, one change<sup>161</sup></td></tr>
<tr><td>When an edit becomes a change</td><td>every call: durable once its op is appended to the log<sup>162</sup></td><td>each call outside <code>transact</code> is its own transaction<sup>163</sup></td><td>JS commits when the <code>change</code> callback returns; Rust <code>AutoCommit</code> before reads and saves<sup>164</sup></td><td>on <code>commit()</code>, and implicitly before <code>import</code>, <code>export</code> and <code>checkout</code>; no timer</td></tr>
<tr><td>Message and metadata on a change</td><td>✅ <code>message</code> (≤ 1,024 characters, signed, replicated), <code>actor</code>, <code>ts</code>, the schema <code>v</code>; no free-form fields</td><td>❌ nothing travels with a change; <code>transaction.meta</code> is local</td><td>✅ <code>message</code>, <code>time</code>, <code>author</code> (hex, 3.5.0); no custom fields<sup>165</sup></td><td>✅ <code>commit({ message, timestamp })</code>; the author is the peer id<sup>166</sup></td></tr>
<tr><td>Tag a change with an origin</td><td>✅ a <code>source</code> per write and per transaction, on the <code>commit</code> and <code>transaction</code> events (local); <code>actor</code> replicates</td><td>✅ <code>transact(fn, origin)</code>, <code>applyUpdate(doc, u, origin)</code>; local only, not replicated<sup>167</sup></td><td>⚠️ the patch callback's <code>source</code> names the API call; no app-defined tag<sup>168</sup></td><td>✅ <code>commit({ origin })</code>: local only, in events and undo filters<sup>169</sup></td></tr>
<tr><td>One atomic change across documents</td><td>✅ <code>transact(fn)</code> writes several records as one append, all or none</td><td>❌ a transaction covers one <code>Doc</code><sup>170</sup></td><td>❌ no; a change belongs to one document</td><td>❌ no</td></tr>
<tr><td>Hook before a local change commits</td><td>✅ <code>hooks.beforeWrite(ctx)</code>: return new <code>data</code> or throw to refuse<sup>171</sup></td><td>❌ no veto; <code>beforeObserverCalls</code> sees the applied change<sup>172</sup></td><td>❌ no hook; a throw inside the <code>change</code> callback rolls it back</td><td>⚠️ <code>subscribePreCommit</code> edits message and timestamp; no veto</td></tr>
<tr><td>Refuse a peer's change</td><td>✅ <code>beforeApply</code> returning <code>false</code>, or a failing validator, skips it here<sup>173</sup></td><td>❌ no way to reject part of a remote update<sup>174</sup></td><td>⚠️ <code>initSyncState({ readOnly: true })</code> ignores all of one peer's changes<sup>175</sup></td><td>❌ no; imports get structural checks only</td></tr>
<tr class="sc-matrix-group"><td colspan="5"><strong>Observing</strong></td></tr>
<tr><td>Change events</td><td>✅ every op reports <code>changes</code> in the write API's terms and the reading's indices; one <code>transaction</code> event per turn</td><td>✅ <code>observe</code>, <code>observeDeep</code>, a <code>delta</code> event per node; doc <code>update</code>, <code>afterTransaction</code><sup>176</sup></td><td>✅ <code>patchCallback</code> per call or per doc; automerge-repo <code>DocHandle</code> <code>change</code> events<sup>177</sup></td><td>✅ <code>doc.subscribe</code>, deep <code>container.subscribe</code>, <code>subscribeLocalUpdates</code> (bytes)</td></tr>
<tr><td>What an event carries</td><td>the op and its <code>changes</code>; <code>commit</code> adds <code>before</code> / <code>after</code> copies and the kinds; <code>transaction</code> the turn's changes by record</td><td>lib0 delta (<code>event.delta</code>, <code>deltaDeep</code>), changed keys; <code>update</code> gives bytes<sup>178</sup></td><td>path patches (<code>put</code>, <code>splice</code>, <code>mark</code>…) plus <code>before</code>/<code>after</code> docs and <code>source</code><sup>179</sup></td><td>per container: target, path, delta/map/tree/counter diff; from/to frontiers<sup>180</sup></td></tr>
<tr><td>Local or remote in an event</td><td>✅ <code>via</code> is <code>null</code> for a local op; <code>commit</code> fires for local ops only</td><td>✅ <code>transaction.local</code> and <code>transaction.origin</code></td><td>✅ <code>info.source</code>: <code>change</code> vs <code>merge</code>, <code>applyChanges</code>, <code>receiveSyncMessage</code>…</td><td>✅ <code>by</code>: "local", "import" or "checkout"; plus <code>origin</code></td></tr>
<tr><td>Changes as JSON patches</td><td>✅ <code>diff(id, from, to)</code> → JSON patches in the write API's terms<sup>181</sup></td><td>✅ deep lib0 deltas with nested <code>modify</code>/<code>modifyAttr</code> per change<sup>182</sup></td><td>✅ <code>Patch[]</code> with paths, from callbacks and from <code>diff()</code></td><td>✅ events and <code>doc.diff()</code> give typed diffs with paths (not RFC 6902)</td></tr>
<tr><td>Apply a patch or diff back</td><td>✅ <code>applyPatches(id, patches)</code>: new ops, rehearsed, all or none on a refusal</td><td>✅ <code>node.applyDelta(delta, origin)</code> turns a delta into ops<sup>183</sup></td><td>⚠️ <code>applyPatches(target, patches)</code>: to a plain object, or as ops inside <code>change</code><sup>184</sup></td><td>✅ <code>doc.applyDiff(diff)</code>, all or nothing; <code>text.applyDelta()</code></td></tr>
<tr><td>Subscribe by path</td><td>✅ <code>observe(id, path, listener)</code>: the changes of a field, of what hangs under it and of a prefix of it</td><td>❌ observe a node or its subtree; no path filter<sup>185</sup></td><td>⚠️ automerge-repo <code>handle.sub(...path)</code>: scoped handle with re-rooted patches (experimental)<sup>186</sup></td><td>✅ <code>doc.subscribeJsonpath(path, cb)</code>; may fire false positives</td></tr>
<tr><td>When observers run</td><td>once the op is durable: listeners called synchronously, before the write resolves<sup>187</sup></td><td>synchronously when the outermost transaction ends, before <code>update</code><sup>188</sup></td><td>synchronously, after the commit, before the call returns</td><td>synchronously at the end of <code>commit</code>, <code>import</code> or <code>checkout</code> (since 1.8)</td></tr>
</tbody>
</table>

</div>

### History and versions

<div class="sc-matrix sc-matrix-quad">

<table>
<thead>
<tr>
<th>Feature</th>
<th><a href="https://github.com/Alexis-Technologies/syncom">syncom</a><br><sub>sync engine</sub></th>
<th><a href="https://github.com/yjs/yjs">Yjs</a><br><sub>CRDT library</sub></th>
<th><a href="https://github.com/automerge/automerge">Automerge</a><br><sub>CRDT library</sub></th>
<th><a href="https://github.com/loro-dev/loro">Loro</a><br><sub>CRDT library</sub></th>
</tr>
</thead>
<tbody>
<tr class="sc-matrix-group"><td colspan="5"><strong>History</strong></td></tr>
<tr><td>History kept</td><td>⚠️ the op log, bounded by retention (10,000 ops by default; <code>retention: 'all'</code> keeps everything)</td><td>❌ no change log; default GC drops deleted content<sup>189</sup></td><td>✅ every change is kept; there is no history GC</td><td>✅ every change kept; nothing is collected unless you export a shallow snapshot</td></tr>
<tr><td>List the changes</td><td>✅ <code>history(id, { limit, before })</code>: versions with type, origin, actor, fields, data<sup>190</sup></td><td>❌ no API to list changes<sup>191</sup></td><td>✅ <code>getAllChanges</code>, <code>getChangesMetaSince</code>, <code>inspectChange(hash)</code>, <code>decodeChange</code><sup>192</sup></td><td>✅ <code>getAllChanges()</code>, <code>getChangeAt()</code>, <code>getOpsInChange()</code>, <code>travelChangeAncestors()</code></td></tr>
<tr><td>Read a past version</td><td>✅ <code>get(id, { at })</code> by event id, stamp, vector or tag; <code>at(tag)</code> views</td><td>✅ <code>Y.snapshot(doc)</code> then <code>createDocFromSnapshot</code>, or <code>getAttrs(snapshot)</code><sup>193</sup></td><td>✅ <code>view(doc, heads)</code>: a cheap read-only doc at a version; Rust <code>*_at(heads)</code></td><td>✅ <code>doc.checkout(frontiers)</code> (detached view), <code>forkAt(frontiers)</code></td></tr>
<tr><td>What reading the past needs</td><td>⚠️ the retained log: a fold of the record's ops, exact from a reset<sup>194</sup></td><td>⚠️ <code>gc: false</code> and a snapshot captured then; restore rebuilds a doc<sup>195</sup></td><td>✅ nothing: history is always whole; reads filter ops by a clock, no replay<sup>196</sup></td><td>✅ history back to the target (not before a shallow root); replays only the ops between</td></tr>
<tr><td>Diff two versions</td><td>✅ <code>diff(id, from, to)</code> between any two versions, as patches<sup>197</sup></td><td>✅ <code>diffDocsToDelta(v1, v2)</code>; <code>DiffRenderer</code> attributes the changes<sup>198</sup></td><td>✅ <code>diff(doc, before, after)</code> → <code>Patch[]</code> between any two versions<sup>199</sup></td><td>✅ <code>doc.diff(from, to)</code> between any two frontiers</td></tr>
<tr><td>Revert to a past version</td><td>✅ <code>restore(id, at)</code>: new ops that lead back, whole or not at all<sup>200</sup></td><td>⚠️ experimental <code>undoContentIds</code>, or <code>DiffRenderer.rejectAllChanges</code><sup>201</sup></td><td>❌ no revert API; <code>applyPatches(diff(now, past))</code> inside <code>change</code> is manual<sup>202</sup></td><td>✅ <code>doc.revertTo(frontiers)</code> as new ops, all or nothing</td></tr>
<tr><td>Named versions</td><td>✅ <code>tag(name)</code>, <code>untag</code>, <code>tags()</code>, <code>at(name)</code>: the whole storage, copy-on-write<sup>203</sup></td><td>❌ no named versions; snapshots are bytes the app stores</td><td>❌ no named versions; the app keeps heads itself</td><td>❌ no; keep frontiers yourself (<code>encodeFrontiers</code>)</td></tr>
<tr><td>Who wrote what</td><td>✅ <code>lastEditorOf(id, field)</code>, <code>editorsOf(id)</code>, and per element <code>editorOf(id, key, index)</code> → <code>{ origin, ts }</code></td><td>⚠️ v14 attribution renderers; who did what is the app's map of <code>clientID</code>s<sup>204</sup></td><td>⚠️ no blame API; per-change <code>actor</code>/<code>author</code> metadata and <code>diff</code> per change<sup>205</sup></td><td>✅ <code>text.getEditorOf(pos)</code>, <code>map.getLastEditor(key)</code>, list <code>getCreatorAt</code>/<code>getLastEditorAt</code><sup>206</sup></td></tr>
<tr><td>Drop old history</td><td>✅ log retention drops old segments; <code>compact(id)</code> rewrites a record's metadata<sup>207</sup></td><td>⚠️ GC drops deleted content; tombstone ids and positions stay<sup>208</sup></td><td>❌ no shallow snapshot or history GC; compression keeps size down</td><td>✅ shallow snapshot drops history before chosen frontiers, like a Git shallow clone<sup>209</sup></td></tr>
<tr><td>Erase a payload from history</td><td>✅ <code>purge(id)</code> scrubs the payload from the log here and on every peer it reaches<sup>210</sup></td><td>⚠️ default GC drops deleted content here and on peers that GC<sup>211</sup></td><td>❌ no; deleted content stays in the history on every replica<sup>212</sup></td><td>⚠️ a shallow snapshot leaves deleted content out; other replicas keep theirs<sup>213</sup></td></tr>
<tr class="sc-matrix-group"><td colspan="5"><strong>Branches and undo</strong></td></tr>
<tr><td>Fork a document</td><td>✅ <code>branch(parent, { path })</code> (<code>@alexify/syncom/branch</code>): a new storage, new identity<sup>214</sup></td><td>✅ <code>Y.cloneDoc(doc)</code>; the clone is a new <code>Doc</code> with a new <code>clientID</code><sup>215</sup></td><td>✅ <code>clone(doc)</code> copies with a new random actor; Rust <code>fork()</code></td><td>✅ <code>doc.fork()</code> with a new random peer id</td></tr>
<tr><td>Fork at a past version</td><td>✅ <code>branch(parent, { from: { at } })</code>: an event id, a stamp or a vector, exact while the log retains it</td><td>✅ <code>createDocFromSnapshot(doc, snapshot)</code> gives an editable doc<sup>216</sup></td><td>✅ <code>clone(view(doc, heads))</code>; Rust <code>fork_at(heads)</code></td><td>✅ <code>doc.forkAt(frontiers)</code></td></tr>
<tr><td>Merge a fork back</td><td>✅ <code>merge(source, { into })</code>, either way, as ops through <code>applyRemote</code><sup>217</sup></td><td>✅ exchange updates; <code>DiffRenderer</code> accepts or rejects suggestions selectively</td><td>✅ <code>merge(local, remote)</code>, or <code>applyChanges(getChanges(old, new))</code></td><td>✅ sync like any peer: <code>import(fork.export({ mode: "update", from }))</code></td></tr>
<tr><td>Edit while viewing the past</td><td>⚠️ views of the past are read-only; edit through <code>restore()</code> or a branch at any version</td><td>⚠️ no checkout; a past version is a new <code>Doc</code>, edited as a fork</td><td>✅ <code>view</code> is read-only; <code>changeAt(doc, heads, fn)</code> adds a change concurrent with later history<sup>218</sup></td><td>⚠️ read-only unless <code>setDetachedEditing(true)</code>; edits then branch off<sup>219</sup></td></tr>
<tr><td>Suggestions (tracked changes)</td><td>❌ none; a branch (<code>/branch</code>) merges back whole</td><td>✅ <code>DiffRenderer</code> keeps a suggestion doc; <code>acceptChanges</code>/<code>rejectChanges</code> by range<sup>220</sup></td><td>⚠️ <code>maskAuthor</code>/<code>revealAuthor</code> hide an author's changes in one view<sup>221</sup></td><td>❌ none; a fork merges back whole</td></tr>
<tr><td>Undo manager</td><td>✅ <code>createUndo(storage)</code> from <code>@alexify/syncom/undo</code>: <code>undo()</code>, <code>redo()</code></td><td>✅ <code>Y.UndoManager(scope, options)</code> with <code>undo()</code>, <code>redo()</code></td><td>❌ no undo manager in the core or automerge-repo</td><td>✅ <code>UndoManager</code>: <code>undo</code>, <code>redo</code>, <code>canUndo</code>, <code>pause</code>/<code>resume</code></td></tr>
<tr><td>Undo only local changes</td><td>✅ this node's own commits only; an undone <code>add</code> revokes its own adds alone</td><td>✅ tracks origins in <code>trackedOrigins</code> (default <code>null</code>); peers' changes stay<sup>222</sup></td><td>— no undo manager</td><td>✅ tracks this doc's peer only; never undoes remote edits<sup>223</sup></td></tr>
<tr><td>Undo steps grouped</td><td>✅ <code>mergeInterval</code> (500 ms), a transaction is one step, <code>group(fn)</code>, <code>mark()</code> closes a step, <code>limit</code> 100</td><td>✅ <code>captureTimeout</code> (500 ms), <code>stopCapturing()</code>, <code>captureTransaction</code> filter</td><td>— no undo manager</td><td>✅ <code>mergeInterval</code> (default 1000 ms) and <code>groupStart</code>/<code>groupEnd</code></td></tr>
<tr><td>Undo over part of a document</td><td>✅ <code>trackedSources</code>, <code>records</code> and <code>paths</code>: a stack over what they name, the inverse kept to those fields</td><td>✅ scope of nodes or a whole doc; <code>trackedOrigins</code>, <code>deleteFilter</code></td><td>— no undo manager</td><td>⚠️ <code>excludeOriginPrefixes</code> only; no per-container scope</td></tr>
<tr><td>Selection restored on undo</td><td>✅ a step's <code>meta</code> keeps the application's cursor tokens and travels to its redo; <code>position()</code> restores the selection</td><td>✅ <code>stackItem.meta</code> with <code>stack-item-added</code> / <code>stack-item-popped</code> events</td><td>— no undo manager</td><td>✅ <code>onPush</code> returns cursors, <code>onPop</code> gets them back transformed</td></tr>
<tr><td>Undo after a peer edited the same place</td><td>skipped (refuse to overwrite); <code>force</code> overrides; counters and sets commute<sup>224</sup></td><td>keeps peers' later edits; skips a key a peer overwrote<sup>225</sup></td><td>— no undo manager</td><td>steps are transformed over remote edits (OT-style); remote inserts stay</td></tr>
</tbody>
</table>

</div>

### Encoding and sync

<div class="sc-matrix sc-matrix-quad">

<table>
<thead>
<tr>
<th>Feature</th>
<th><a href="https://github.com/Alexis-Technologies/syncom">syncom</a><br><sub>sync engine</sub></th>
<th><a href="https://github.com/yjs/yjs">Yjs</a><br><sub>CRDT library</sub></th>
<th><a href="https://github.com/automerge/automerge">Automerge</a><br><sub>CRDT library</sub></th>
<th><a href="https://github.com/loro-dev/loro">Loro</a><br><sub>CRDT library</sub></th>
</tr>
</thead>
<tbody>
<tr class="sc-matrix-group"><td colspan="5"><strong>Encoding</strong></td></tr>
<tr><td>Encoding of changes</td><td>JSON: <code>{"e", "c"}</code> log lines of positional <code>[seq, fp, header, payload]</code> entries, CRC-32 checked; 19-slot arrays on the wire</td><td>binary updates: V1 (default) and V2 (columnar, RLE per field)</td><td>binary columnar chunks: document, change, DEFLATE-compressed change, bundle<sup>226</sup></td><td>binary FastSnapshot and FastUpdates (modes 3, 4); JSON updates</td></tr>
<tr><td>Format specification</td><td>✅ <code>docs/reference/wire.md</code>: the 19 slots, codes, payloads, signed header, files, procedures, bounds</td><td>❌ no written spec; the code defines the format<sup>227</sup></td><td>✅ published binary format spec on automerge.org (not in the clones)</td><td>✅ <code>docs/encoding.md</code>, a normative spec, plus JSON, LZ4 and xxHash docs</td></tr>
<tr><td>Snapshot of the whole state</td><td>✅ <code>snapshot()</code> pages records with their merge meta; <code>mergeSnapshot()</code> joins them<sup>228</sup></td><td>✅ <code>encodeStateAsUpdate(doc)</code>: all items and tombstones<sup>229</sup></td><td>✅ <code>save(doc)</code>: compressed doc with full history; no history-less save<sup>230</sup></td><td>✅ <code>export({ mode: "snapshot" })</code> with history; <code>"shallow-snapshot"</code> with little</td></tr>
<tr><td>Changes since a version</td><td>✅ a push sends ops past the host's vector; <code>changes</code> resumes from an event id<sup>231</sup></td><td>✅ <code>encodeStateAsUpdate(doc, stateVector)</code> sends what that peer lacks<sup>232</sup></td><td>✅ <code>saveSince(doc, heads)</code>, <code>getChangesSince(doc, heads)</code>, <code>saveIncremental()</code></td><td>✅ <code>export({ mode: "update", from: vv })</code></td></tr>
<tr><td>Merge updates without loading a document</td><td>✅ <code>mergeEntry(a, b)</code> joins two record states with no storage<sup>233</sup></td><td>✅ <code>mergeUpdates</code>, <code>diffUpdate</code>, <code>encodeStateVectorFromUpdate</code> on bytes<sup>234</sup></td><td>⚠️ saved chunks concatenate: <code>load(concat(a, b))</code> works; no compaction without loading<sup>235</sup></td><td>❌ no; <code>importBatch</code> the blobs into a doc, then export<sup>236</sup></td></tr>
<tr><td>Readable export of changes</td><td>✅ everything is JSON: snapshot pages, log entries, ops<sup>237</sup></td><td>⚠️ <code>decodeUpdate</code>/<code>logUpdate</code> show structs for inspection; no JSON import</td><td>⚠️ <code>decodeChange</code>/<code>encodeChange</code> (<code>@hidden</code>) map a change to and from JSON ops<sup>238</sup></td><td>✅ <code>exportJsonUpdates()</code> / <code>importJsonUpdates()</code></td></tr>
<tr><td>Fast or lazy load</td><td>⚠️ records load by id into a bounded cache; each one parsed whole<sup>239</sup></td><td>⚠️ compact V2 columns; loading decodes everything, no lazy load<sup>240</sup></td><td>✅ columnar doc chunk; 3.0 keeps it compressed in memory; no change replay<sup>241</sup></td><td>✅ lazy ~4 KB compressed blocks, decoded on demand; columnar encoding</td></tr>
<tr><td>Format compatibility</td><td>⚠️ a written policy (slots appended, a new type a <code>PROTOCOL</code> bump); unpublished, so no version kept yet</td><td>⚠️ no written promise; tests decode v13.2 documents<sup>242</sup></td><td>✅ 3.0 kept the 2.x file format; sync v2 still talks to v1 peers<sup>243</sup></td><td>✅ stable since 1.0; older readers refuse newer encodings<sup>244</sup></td></tr>
<tr class="sc-matrix-group"><td colspan="5"><strong>Sync</strong></td></tr>
<tr><td>Sync protocol</td><td>✅ built in: <code>hello</code>, <code>push</code>, <code>changes</code>, <code>snapshot</code> over an injected link</td><td>✅ <code>y-protocols/sync</code>: step 1 state vector, step 2 diff, updates<sup>245</sup></td><td>✅ core <code>generateSyncMessage</code> / <code>receiveSyncMessage</code> with a per-peer <code>SyncState</code><sup>246</sup></td><td>✅ none in core; the official Loro Protocol (<code>loro-websocket</code>, <code>loro-adaptors</code>)<sup>247</sup></td></tr>
<tr><td>What a reconnect exchanges</td><td>vectors and log epochs at hello, then ops past the vector; the feed resumes<sup>248</sup></td><td>state vectors; the reply resends missing items and the full delete set</td><td>heads + a Bloom filter of changes since the shared heads + needs<sup>249</sup></td><td>version vectors; each side exports the ops past the other's vector</td></tr>
<tr><td>Updates out of causal order</td><td>✅ a gap in one origin's stream is dropped and fetched again<sup>250</sup></td><td>✅ held as pending and applied when the missing parts arrive<sup>251</sup></td><td>✅ queued until dependencies arrive; <code>getMissingDeps</code> lists them<sup>252</sup></td><td>✅ held as pending until the deps arrive; <code>exportPendingUpdates()</code> saves them</td></tr>
<tr><td>The same update twice</td><td>✅ idempotent: the vector drops it, counted in <code>duplicates</code>; no event</td><td>✅ idempotent: no event, no observers; the cost is a decode</td><td>✅ idempotent: deduplicated by hash, no patches emitted</td><td>✅ idempotent: no event, empty <code>success</code></td></tr>
<tr><td>Transport</td><td>✅ an injected <code>SyncLink</code>; <code>@alexify/syncom/wrpc</code> for WebSocket and WebRTC<sup>253</sup></td><td>✅ transport-agnostic bytes; official y-websocket, y-webrtc providers<sup>254</sup></td><td>✅ bytes over any reliable channel; automerge-repo WebSocket, MessageChannel, BroadcastChannel<sup>255</sup></td><td>✅ bytes over any transport; WebSocket client in <code>loro-websocket</code></td></tr>
<tr><td>Official server</td><td>✅ no separate server: any storage hosts with <code>sync.unit()</code> on wrpc<sup>256</sup></td><td>✅ <code>y-websocket</code> ships a simple WebSocket backend<sup>257</sup></td><td>✅ <code>automerge-repo-sync-server</code> (reference, outside the clones): a plain <code>Repo</code>, validates nothing<sup>258</sup></td><td>⚠️ <code>loro-websocket</code>'s <code>SimpleServer</code> (for testing) and a Rust server<sup>259</sup></td></tr>
<tr><td>Persistence</td><td>✅ built in: <code>node:fs</code>, OPFS, IndexedDB (<code>/idb</code>), <code>/memory</code>, <code>/layered</code>, encrypted at rest (<code>/encryption</code>), or an injected <code>fsi</code></td><td>✅ official y-indexeddb and y-leveldb; others third-party<sup>260</sup></td><td>✅ automerge-repo IndexedDB and Node FS adapters over a key-range <code>StorageAdapter</code><sup>261</sup></td><td>❌ the app's job; docs give a snapshot plus updates recipe</td></tr>
<tr><td>Presence and awareness</td><td>✅ <code>/presence</code>: a state per node, signed, renewed and expired, relayed by a host's rooms, never logged</td><td>✅ <code>y-protocols/awareness</code>: per-client state, 30 s timeout</td><td>✅ automerge-repo <code>handle.broadcast()</code> / <code>ephemeral-message</code>; <code>Presence</code> class<sup>262</sup></td><td>✅ <code>EphemeralStore</code>: timestamped LWW keys that expire</td></tr>
<tr><td>Partial replication</td><td>✅ scopes: a <code>scope()</code> per record, peers granted scopes, the host enforcing<sup>263</sup></td><td>⚠️ per document via subdocuments; <code>intersectUpdateWithContentIds</code> filters by ids<sup>264</sup></td><td>⚠️ per document only: automerge-repo <code>shareConfig</code> <code>announce</code> / <code>access</code><sup>265</sup></td><td>❌ no; a peer receives the whole document</td></tr>
</tbody>
</table>

</div>

### Integrity and safety

<div class="sc-matrix sc-matrix-quad">

<table>
<thead>
<tr>
<th>Feature</th>
<th><a href="https://github.com/Alexis-Technologies/syncom">syncom</a><br><sub>sync engine</sub></th>
<th><a href="https://github.com/yjs/yjs">Yjs</a><br><sub>CRDT library</sub></th>
<th><a href="https://github.com/automerge/automerge">Automerge</a><br><sub>CRDT library</sub></th>
<th><a href="https://github.com/loro-dev/loro">Loro</a><br><sub>CRDT library</sub></th>
</tr>
</thead>
<tbody>
<tr class="sc-matrix-group"><td colspan="5"><strong>Integrity</strong></td></tr>
<tr><td>Hash-linked history</td><td>⚠️ with <code>/chain</code>, a per-node hash-linked chain of applied writes, checked on cold reads</td><td>❌ ids are client and clock; no content hashes</td><td>✅ SHA-256 change hashes; deps link them; heads checked on load</td><td>❌ no; ops are named by peer and counter<sup>266</sup></td></tr>
<tr><td>Signed changes</td><td>✅ with <code>/signing</code> (in <code>/all</code>): Ed25519 per op, the node id is the key, verified on receipt</td><td>❌ no signatures</td><td>❌ no signatures on changes in the core<sup>267</sup></td><td>❌ no</td></tr>
<tr><td>Checksums on encoded data</td><td>✅ every log file carries a CRC-32 of its entries, checked before they are parsed; a signed SHA-256 digest per op with <code>/signing</code></td><td>❌ no checksum in either format</td><td>✅ each chunk carries a 4-byte SHA-256-prefix checksum, checked on load</td><td>✅ xxHash32 over every blob, plus one per SSTable block</td></tr>
<tr><td>A malformed update</td><td>✅ dropped and counted, never thrown: not logged, not relayed (a gap)<sup>268</sup></td><td>⚠️ throws a plain <code>Error</code>; parts decoded before the failure stay applied<sup>269</sup></td><td>⚠️ undecodable bytes throw, nothing applied; nonsense ops panic and broke the doc<sup>270</sup></td><td>✅ throws; the import rolls back and the doc is unchanged<sup>271</sup></td></tr>
<tr><td>Limits against a hostile peer</td><td>✅ pending work, run and field slots, tree depth and index, counter range, skew, push limits<sup>272</sup></td><td>❌ no limits on size, depth or pending data<sup>273</sup></td><td>⚠️ 1 GB cap per decoded item, leb128 overflow checks; no queue or size caps<sup>274</sup></td><td>⚠️ decode caps (positions &lt; 2^30, value depth 128); no size or pending caps<sup>275</sup></td></tr>
<tr><td>Validation of a peer's change</td><td>✅ the entity validator and <code>beforeApply</code> run on every peer's op</td><td>❌ none; peers are assumed trusted</td><td>❌ none in the core; Keyhive's server policy (alpha) checks edit access only</td><td>❌ no schema or rule checks; structural checks only</td></tr>
<tr><td>End-to-end encryption</td><td>❌ no; an encrypted record stays local and does not sync</td><td>⚠️ none in core; <code>y-webrtc</code> encrypts signaling with a shared secret<sup>276</sup></td><td>⚠️ keyhive via <code>@automerge/automerge-repo-keyhive</code>, in alpha<sup>277</sup></td><td>⚠️ experimental, in the Loro Protocol (<code>%ELO</code> rooms, <code>EloLoroAdaptor</code>)</td></tr>
<tr><td>Convergence tested by fuzzing</td><td>✅ seeded mesh fuzz: 4 nodes, 80 ops of every kind; a hazard walk<sup>278</sup></td><td>✅ 5 peers, random disconnects and delivery order, up to 100,000 ops</td><td>✅ proptests, random fork/merge batch tests, a 3-repo fuzz, libFuzzer on <code>load</code><sup>279</sup></td><td>✅ cargo-fuzz, 14 targets, 5 peers compared; loro.js-vs-Rust differential fuzz</td></tr>
<tr><td>Formal model or proofs</td><td>❌ none; cites the papers, and <code>INVARIANTS.md</code> maps each guarantee to tests</td><td>⚠️ third-party lean-yjs (Lean) proves parts of YATA<sup>280</sup></td><td>❌ no proofs or model checker; the sync code cites one paper<sup>281</sup></td><td>❌ none in the repo; docs cite the Fugue, Eg-walker and tree-move papers<sup>282</sup></td></tr>
<tr class="sc-matrix-group"><td colspan="5"><strong>Developer surface</strong></td></tr>
<tr><td>Errors</td><td>✅ <code>SyncomError</code> with a <code>code</code> (44 codes); <code>TypeError</code> for a wrong argument</td><td>❌ plain <code>Error</code> messages, no classes or codes</td><td>⚠️ JS throws <code>RangeError</code> with messages; Rust has a typed <code>AutomergeError</code> enum<sup>283</sup></td><td>❌ JS: thrown message strings, no class or code; Rust: typed <code>LoroError</code><sup>284</sup></td></tr>
<tr><td>Inspector and debugging</td><td>⚠️ <code>/inspect</code>: a record's anatomy raw; <code>stats()</code>, an injected logger, OpenTelemetry; no visual inspector</td><td>⚠️ <code>logUpdate</code>, <code>logNode</code>, <code>obfuscateUpdate</code>; Yjs inspector site<sup>285</sup></td><td>⚠️ no inspector; <code>automerge-cli</code> (examine, export), <code>stats</code>, <code>dump</code>, <code>anonymize</code><sup>286</sup></td><td>✅ Loro Inspector (web); <code>setDebug()</code>, <code>debugHistory()</code></td></tr>
<tr><td>Anonymized copy for bug reports</td><td>✅ <code>anonymize(value, { salt, keys })</code> from <code>/inspect</code>: every string hashed, the shape kept</td><td>✅ <code>obfuscateUpdate</code> replaces content, keeps the CRDT structure</td><td>✅ <code>anonymize(doc)</code> replaces keys, values, actors and metadata, keeps history shape<sup>287</sup></td><td>⚠️ <code>redactJsonUpdates</code> blanks content in JSON updates over a version range</td></tr>
<tr><td>UI framework bindings</td><td>✅ <code>/store</code>: a query, a record or a presence as one store — Svelte's contract and React's <code>useSyncExternalStore</code>; Vue and Solid wrap it</td><td>⚠️ third-party only: react-yjs, SyncedStore, valtio-yjs, immer-yjs</td><td>✅ react hooks, Svelte store, Solid primitives (automerge-repo packages); no Vue<sup>288</sup></td><td>✅ <code>loro-mirror</code> (state mirror) and <code>loro-mirror-react</code><sup>289</sup></td></tr>
<tr><td>Documentation</td><td>✅ VitePress site: guides, API reference, architecture, benchmarks</td><td>⚠️ docs.yjs.dev: guides, API, ecosystem, internals, for v13<sup>290</sup></td><td>✅ automerge.org: tutorial, data model, merge rules, internals, cookbook, typedoc API<sup>291</sup></td><td>✅ loro.dev: tutorials, concepts, full JS API reference, benchmarks, blog</td></tr>
<tr><td>Test suite</td><td>1,228 <code>node:test</code> tests, 30 <code>tsd</code> files; CI on Node 22, 24</td><td>338 cases in 16 files (lib0/testing); CI on Node 26</td><td>Rust ~730 tests + proptests, JS 351, WASM 160, automerge-repo 711; GitHub CI<sup>292</sup></td><td>~2,000 Rust tests, 472 JS cases, 396 loro.js cases, fuzz, loom; CI</td></tr>
</tbody>
</table>

</div>

### Notes

1. Branch <code>features/enhance-crdt-engine-part2</code>. 0.0.1 is a development placeholder, so there is no npm <code>latest</code> to differ from.
2. v14 renames the package to <code>@y/y</code> and publishes release candidates under the npm <code>beta</code> tag; the README still says <code>npm i yjs</code> and documents mostly the v13 API.
3. The clone's main already carries unreleased APIs under the 3.5.0 label (<code>maskAuthor</code>/<code>revealAuthor</code>), which the npm 3.5.0 build lacks. automerge-repo is read at 3ab7c33 (2.6.0-alpha.5); npm <code>latest</code> there is 2.6.0-alpha.3.
4. The shallow clone has no CHANGELOG or tag history, so the first release year is not shown; the YATA paper it implements dates from 2016.
5. automerge-repo, which the sync, storage and framework rows lean on, has an alpha (2.6.0-alpha.3) as its npm <code>latest</code>.
6. Every block is a subpath of the one package, MIT like the rest: sync, the storage backends, undo, branches, presence and the ProseMirror and CodeMirror bindings.
7. One core file, <code>text_diff/myers.rs</code>, is copied from the <code>similar</code> crate under Apache-2.0 (its LICENSE sits beside it). The ProseMirror/CodeMirror bindings and Keyhive are outside the clones.
8. The licenses of <code>loro-prosemirror</code>, <code>loro-codemirror</code> and <code>loro-mirror</code> are not in the clones and were not checked.
9. yrs/y-crdt is co-maintained by Bartosz Sypytkowski, Kevin Jahns and John Waidhofer.
10. The same repo ships <code>loro.js</code>, an experimental pure-TypeScript port (0.4.0) that targets wire and API compatibility without WebAssembly.
11. <code>@alexify/wrpc</code> is a devDependency only: the application hands its client in.
12. In 13.6.33 (npm <code>latest</code>) the one dependency is <code>lib0</code> ^0.2.99.
13. The default <code>import</code> inlines the WASM as base64 and instantiates it synchronously; Node reads the file; the <code>browser</code> condition needs bundler WASM support (webpack <code>asyncWebAssembly</code>, Vite <code>vite-plugin-wasm</code> + top-level await); <code>/slim</code> + <code>initializeWasm()</code> is the manual async path. The repo has no CSP note; on Cloudflare Workers a doc cannot be created outside a handler.
14. The default browser entry fetches the .wasm with a synchronous XMLHttpRequest. With the <code>bundler</code> entry, Vite needs <code>vite-plugin-wasm</code> and <code>vite-plugin-top-level-await</code>, and plain esbuild/Rollup must use <code>loro-crdt/base64</code> or copy the asset. The repo says nothing about CSP.
15. yrs 0.28 follows the v13 type set (<code>Text</code>, <code>Map</code>, <code>Array</code>, <code>Xml*</code>) and both update formats, not v14 <code>Y.Node</code>.
16. Python (automerge-py) and Swift (automerge-swift) are automerge-org projects outside the clones; R is community-maintained (CRAN); Go (automerge-go) is named in the 2.0 blog; <code>samod</code> is a Rust automerge-repo.
17. Other bindings are built from <code>loro-ffi</code>, which is not in the clones. The repo also holds a MoonBit codec for the binary format (codec only) and the pure-TS <code>loro.js</code>.
18. Nothing in the repository tests or claims Deno, Bun or React Native. The browser half needs Web Crypto with Ed25519, and OPFS or IndexedDB (<code>@alexify/syncom/idb</code>).
19. Deno, Bun, React Native and workers are not mentioned. In 13.6.33 (npm <code>latest</code>) the package ships CommonJS and ESM builds and needs Node ≥ 16.
20. No <code>engines</code> field; automerge-repo needs Node ≥ 22.13. Deno has WASM tests but no CI job; React Native needs Metro package-exports config plus manual init; Bun is not mentioned.
21. The repo does not mention React Native / Hermes. The sync browser entry needs <code>XMLHttpRequest</code>; elsewhere use the <code>nodejs</code>, <code>web</code>, <code>base64</code> or <code>bundler</code> entry.
22. The type parameter is a compile-time shape only: <code>$node</code> checks the name at runtime, not the content.
23. The WASM layer's types are a hand-written TS block in <code>automerge-wasm/src/lib.rs</code>, copied to <code>wasm_types.d.ts</code> at build. <code>load&lt;T&gt;</code> does no runtime check of <code>T</code>.
24. Every read and write returns a promise; a write resolves once its op is in the log.
25. Every core call is synchronous except WASM init. A doc handed to <code>change</code> becomes outdated and cannot be changed again (<code>clone</code> first). automerge-repo wraps it in a <code>DocHandle</code> (<code>handle.change</code>, events); <code>repo.find()</code> is async.
26. Each top-level field of a record is one kind — register, counter, set, list, text or tree. A replica is a storage directory: records, the op log, the chain, the catalog.
27. Loading and syncing each subdocument is the provider's job; the docs say official providers treat subdocs as separate entities.
28. The core holds one document per instance; there are no subdocuments.
29. The Loro Protocol multiplexes many documents (rooms) over one WebSocket, but the app still names and keeps them. A blog post says the team's directory CRDT (Flock) will be open-sourced later; it is not in the repo.
30. v14 folds <code>Y.Map</code>, <code>Y.Array</code>, <code>Y.Text</code> and the XML types into <code>Y.Node</code>. In 13.6.33 (npm <code>latest</code>) they are separate classes. Neither has a counter, set, tree or movable list.
31. <code>Table</code> survives only as a legacy alias of map. No tree, movable list, set or XML type.
32. A node instance lives in one place; to place it elsewhere, insert a <code>clone()</code>.
33. A text holds characters and inline block-marker maps only. <code>from([1, 2])</code> gives a map with keys '0' and '1' (probed).
34. A child container gets a new id from the op that inserts it. Inserting an already-attached container copies it under a new id; no container moves between parents (tree nodes excepted).
35. A record is created by <code>insert()</code> (a minted UUID) or <code>set(id)</code>. Two nodes that create one field with the same kind at once merge into one field — there are no container ids; two <code>set(id)</code> of one id are whole-record writes and the newer wins.
36. A v14 root has one kind, so replicas cannot disagree on its type. In 13.6.33 (npm <code>latest</code>) <code>getMap('r')</code> on one replica and <code>getText('r')</code> on another each see only their own kind's content (checked by running it). Roots cannot be deleted.
37. Two replicas that each assign <code>d.list = []</code> hold two distinct lists: one wins by op id, the other's items are hidden (reachable through <code>getConflicts</code>). The docs say to sync the initial change first or hard-code its bytes.
38. Root ids are <code>cid:root-&lt;name&gt;:&lt;Type&gt;</code>, so two replicas get the same root and a map named x never clashes with a text named x. A child from <code>setContainer</code> gets an op-based id; <code>ensureMergeable*(key)</code> gives a deterministic id so lazy concurrent creation merges.
39. Checked in a probe: a <code>Date</code> reads back as an ISO string, a <code>Uint8Array</code> as an object of indexes, <code>NaN</code> and <code>Infinity</code> as <code>null</code>, a field set to <code>undefined</code> is dropped, a <code>BigInt</code> throws a <code>TypeError</code>. There is no binary type.
40. How <code>Date</code> and <code>bigint</code> round-trip depends on lib0 1.x <code>writeAny</code>, which is not cloned. In 13.6.33 (npm <code>latest</code>) a <code>Date</code> reaches peers as <code>{}</code> while the writer still reads a <code>Date</code>, and a <code>bigint</code> wraps to signed 64 bits.
41. <code>bigint</code> is accepted (uint above i64 max) and reads back as a number when safe, as <code>bigint</code> from 2^53; NaN and Infinity round-trip as f64; <code>undefined</code>, functions, symbols and <code>Map</code> throw <code>RangeError</code>; class instances are stored as plain maps (all probed).
42. A <code>Date</code> is stored as <code>{}</code>, bigint, functions and symbols throw, a JS <code>Map</code> becomes a map. Integers within ±2^53 are stored as i64, other numbers as f64.
43. Two nodes changing different keys of one nested object at once keep one side (probe confirmed); <code>update({ 'a.b': 1 })</code> writes a field named <code>a.b</code>.
44. Inserted JSON is not copied; in development mode it is deep-frozen, and the docs warn against mutating it.
45. Assigning a whole new object creates a new map; a concurrent edit inside the old one is lost (probed: <code>o = {a: 9}</code> beat a concurrent <code>o.b = 3</code>).
46. Where the winner arrives the loser's state is dropped; where the winner is held the loser's op is refused (<code>OP_REFUSED</code> error event). The loser's ops stay in the log, so <code>history()</code> on a node that applied them still shows them.
47. In v14 both sides are <code>Y.Node</code>s, so this is the ordinary register conflict. The loser is reachable only from a snapshot taken with <code>gc: false</code>.
48. The next write to the key resolves the conflict.
49. The losing container is hidden (<code>isDeleted()</code> is true) but <code>getContainerById</code> still reads it. With <code>ensureMergeable*</code>, the losing kind's state resurfaces if that kind is ensured again.
50. Validates local writes (defaults folded into the op) and every peer's op (an invalid one is skipped here, still relayed); schema versions with a lens and <code>migrate()</code>.
51. The JSDoc says to validate content as a value, e.g. <code>delta.$delta(conf).check(node.toDelta())</code> (lib0 schema); nothing checks remote changes.
52. The docs name Cambria as research that is not implemented.
53. loro-mirror (official, not in the clones) maps a declared schema onto containers; the docs do not describe it rejecting remote data.
54. Every new <code>Doc</code> (each session) gets a new id, so state vectors grow with sessions.
55. One actor's changes must be sequential. 3.5.0 adds an optional <code>author</code> (hex) mapped to one or more actors.
56. A host refuses a hello from its own id (409 <code>SELF</code>), and a node whose stream a host holds more of is told <code>REWOUND</code> and moves past it. Two live copies writing at once mint the same seqs: whichever op arrives second under a seq is dropped as a duplicate.
57. Ops already written under the shared id are dropped as known by the other side, so the replicas end up different for good; the FAQ warns of permanent corruption.
58. Probe: two clones given one actor each made a change; <code>merge</code>, <code>applyChanges</code> and sync all threw <code>RangeError</code>. Nothing regenerates the id, and the two histories cannot be merged.
59. Detection happens only where the two histories overlap, at import; the import is refused and the document left unchanged. The docs make avoiding reuse the app's job.
60. A claim the origin signs, not a proof of who the user is.
61. In 13.6.33 (npm <code>latest</code>) the experimental <code>PermanentUserData</code> maps them inside the document.
62. Stored in an actor's first change and kept through merge and save; changing the author mints a fresh actor.
63. Vector keys are <code>origin@scope</code>; list and text elements are named <code>ts:offset:origin</code>, runs <code>ts:origin</code>; a log position is an event id <code>&lt;epoch&gt;.&lt;seq&gt;</code>.
64. Deletes get no id: the clock counts inserts only.
65. Registers order by <code>(ts, origin)</code>. The clock never runs backwards nor behind a stamp it has seen, so convergence does not depend on clocks agreeing — only who wins does.
66. Concurrent order comes from YATA's <code>origin</code>/<code>rightOrigin</code>, ties broken by <code>clientID</code>. The README calls ids Lamport timestamps, but a client's clock never jumps on receive.
67. Reading at a version uses a per-actor vector of max op counters.
68. Skew changes who wins, never whether nodes agree; a stamp more than <code>sync.maxSkew</code> (24 h) ahead is refused as malformed.
69. Time is used only locally, by <code>UndoManager</code> capture grouping and awareness timeouts.
70. <code>time: undefined</code> stores 0 (probed).
71. Off by default; a change then takes the largest timestamp seen. Timestamps are forced ascending and decide whether consecutive commits merge into one change.
72. <code>get(id, { at })</code> takes an event id (<code>'&lt;epoch&gt;.&lt;seq&gt;'</code>, a position in this node's log), a stamp, <code>{ vector }</code> or <code>{ tag }</code>.
73. The README says the state vector describes local state and is not used to track causality.
74. JSON-able as is; automerge-repo also encodes heads for URLs (<code>UrlHeads</code>).
75. An app compares decoded state vectors itself.
76. <code>getMissingDeps</code> and <code>getChangesSince</code> help derive the rest.
77. Also <code>clearAttrs</code>, <code>attrKeys</code>, <code>attrValues</code>, <code>attrEntries</code>, <code>attrSize</code>, <code>forEachAttr</code>. In 13.6.33 (npm <code>latest</code>) the map is <code>Y.Map</code> with <code>set</code>/<code>get</code>/<code>delete</code>/<code>has</code>/<code>clear</code>.
78. A write that saw the other always wins over it; only truly concurrent writes fall to the <code>clientID</code> order.
79. With <code>gc: false</code> a lost value stays in the store and shows in an older snapshot, but there is no conflicts API.
80. Patches carry <code>conflict: true</code>; the next write to the key clears it.
81. A delete removes only the value it saw; a concurrent set is a new value it never covered.
82. The reset drops what is stamped below it in every kind: registers, counters, set tags, list and text runs, tree moves.
83. There is no whole-document clear, and roots cannot be deleted.
84. Reassigning creates a new object, so concurrent writes into the old one are dropped.
85. Not a single reset op: keys a peer adds concurrently survive, and each deleted key races a concurrent set by LWW. <code>deleteRootContainer</code> empties and hides a root.
86. In a probe a whole-record write merged with a concurrent update read <code>{ only, later }</code> on one node and <code>{ later, only }</code> on the other. A set field reads sorted by element JSON.
87. <code>toJSON()</code> returns a plain object, so integer-like keys come first there.
88. Probe: after a change <code>Object.keys</code> read <code>z, a, m</code>; after <code>load</code> it read <code>a, m, z</code>. Integer-like keys follow JS object rules.
89. A number in an attr is a register: concurrent increments lose all but one.
90. An <code>inc</code> that would take its origin's sum past <code>Number.MAX_SAFE_INTEGER</code> is refused as a bound (<code>detail: 'counter'</code>), the same on every node; the sums add up in origin order, so fractions read alike everywhere.
91. <code>increment(1.7)</code> adds 1 and <code>new Counter(1.5)</code> stores 1 (probed). The sum is a plain i64 <code>+</code> with no overflow check.
92. A peer's register write takes the field whatever its stamp (locally <code>update()</code> of a counter throws <code>FIELD_KIND</code>). A counter one origin incremented both before and after a concurrent reset does not converge — documented and left so.
93. An increment counts only while the counter's put has no other successor (probed: reset to 0 ‖ +3 → 0; delete ‖ +3 → key gone).
94. Rust <code>clear()</code> decrements by the observed value, so concurrent increments survive. Deleting the map key hides the counter; with <code>ensureMergeableCounter</code> re-ensuring resurfaces it with those increments.
95. A remove names the add stamps its node observed; elements are told apart by their JSON text and read sorted.
96. The docs suggest no model; keys with a dummy value work because a concurrent set beats a delete.
97. In 13.6.33 (npm <code>latest</code>) the list is <code>Y.Array</code>.
98. The placement rule is adapted from <code>fugue-simple</code> (MIT); the movable list follows Loro's MovableList.
99. A formal model of YATA exists in the third-party lean-yjs project, cited by the README.
100. Tested for forward runs, backward runs (typing at the start) and the Yjs-interleave case (<code>xab</code>, never <code>axb</code>). Two runs anchored after one element may swap order — the FugueMax difference.
101. Not tested in the repo. Run on 13.6.33 (same <code>Item.integrate</code>): two writers typing forward or backward at one spot never interleave, but with three replicas a concurrent insert can land inside a right-to-left run.
102. Probe: per-keystroke appends <code>abc</code> ‖ <code>xyz</code> → <code>xyzabc</code>; per-keystroke prepends → <code>xaybzc</code> (lists too). The docs admit reverse insertion is not preserved.
103. Many elements in one op only through <code>doc.applyDiff</code> with a list delta.
104. The value follows the element through a concurrent move.
105. Two replicas replacing one element concurrently leave both new values in the list.
106. <code>getConflicts(list, i)</code> shows both; an assign concurrent with a delete revives the element (probed).
107. Plain <code>LoroList</code> has no set.
108. At the newer move's place (tests and probe).
109. A move existed only on a side branch of yjs (y-crdt README); main has none. A moved element is delete plus re-insert.
110. The removal took the old slot, the move made a new one; a removal made after the move takes the element away (probe confirmed).
111. A concurrent <code>set</code> and delete go the other way: the element stays deleted.
112. <code>["ab", 3, "c"]</code>: items alternate with tombstone lengths (list-positions' form); an extension adds no key to the record.
113. Deleted runs and garbage-collected ranges merge too.
114. Text, embeds and child nodes can share one node's children. In 13.6.33 (npm <code>latest</code>) the type is <code>Y.Text</code>.
115. <code>ImmutableString</code> holds an atomic, non-collaborative string.
116. yrs defaults to UTF-8 byte offsets and can be set to UTF-16 (<code>OffsetKind</code>).
117. The WASM build hard-codes UTF-16; JS has no switch.
118. The document stays valid, but the character is lost on every replica.
119. Probe on <code>a😀b</code>: insert at 2 lands after 😀, <code>splice(1, 1)</code> removes 😀 whole; a lone surrogate inserted becomes U+FFFD.
120. Diffed inside the mutation queue after the common prefix and suffix; past 1 000 edit steps it is one splice replacing the middle.
121. Editor bindings compute the edits; <code>applyDelta</code> takes the result.
122. Marked beta; the docs warn it merges poorly when called rarely. <code>updateSpans</code> diffs block structure but not marks.
123. Docs warn <code>update</code> can be slow past ~50,000 characters and point to <code>updateByLine</code>; a timeout throws.
124. v14 uses lib0's delta (ops carry <code>type</code>, attrs and nested <code>modify</code>), not Quill's JSON. In 13.6.33 (npm <code>latest</code>) <code>Y.Text</code> reads and applies Quill-style deltas.
125. Benchmarks are for 13.6.11 (crdt-benchmarks, by the same author); B4×100 (10.5M chars) encodes to 16 MB. A per-keystroke update averaged 29 bytes in 13.3.0.
126. Our run, npm 3.5.0 under Node, on <code>rust/edit-trace/edits.json</code> in one change (5.6 s to apply). The 3.0 blog: pasting Moby Dick took 700 MB in 2.x and 1.3 MB in 3.0.
127. The benchmark ran on 1.0.0-beta.2; 100× the trace (10.5M chars) gave 21 MB and 66 ms parse. Sequences are capped at about 1.07e9 items.
128. Formats are start/end markers in the list; <code>null</code> clears a key.
129. Mark values are scalars only (an object value throws).
130. A key needs a style config; unknown keys throw unless <code>configDefaultTextStyle</code> is set (bold, italic, underline, link, highlight, comment, code are preset).
131. <code>'after'</code> is the default; <code>unmark</code> uses the reversed rule.
132. Read from the code (not run): unnamed formats at the spot are set to <code>null</code>. In 13.6.33 (npm <code>latest</code>) <code>Y.Text.insert</code> without attributes inherits the formats on its left.
133. <code>updateSpans</code> takes <code>defaultExpand</code> and <code>perMarkExpand</code>.
134. Without <code>many</code>, one value per name and character: the newest covering mark (Peritext's <code>allowMultiple</code> rule).
135. Overlapping comments need distinct keys, e.g. one key per comment id.
136. Probe: <code>comment=c1</code> on 0–5 and <code>comment=c2</code> on 3–8 read back as c1 0–3 and c2 3–8; overlapping comments need distinct mark names.
137. Two <code>comment</code> marks over overlapping ranges leave the overlap with one value; distinct keys like <code>comment:1</code> and <code>comment:2</code> (sharing <code>comment</code>'s expand rule) both survive.
138. A stacking mark goes only by its id: <code>unmarkById()</code>.
139. An unmark is a null-valued mark, so per character the greater op id wins (probed: the concurrent unmark won on its range).
140. A published rich-text schema (<code>type</code>, <code>parents</code>, <code>attrs</code>, <code>isEmbed</code>) models nesting.
141. In 13.6.33 (npm <code>latest</code>) these are <code>Y.XmlFragment</code>, <code>Y.XmlElement</code>, <code>Y.XmlText</code>, <code>Y.XmlHook</code>; v14 still decodes them.
142. Bindings live in their own repos (not cloned); which already target v14 is not visible here. Third-party: slate-yjs, y-ace; BlockSuite and Superdoc bind natively.
143. Both are named by the docs and blog but are not in the clones; no Tiptap, Quill, Monaco, Lexical or Slate binding is named.
144. Both are official loro-dev packages outside the clones. A Quill example lives in the repo (<code>examples/loro-quill</code>).
145. v14 adds converters between lib0 delta positions and relative positions.
146. In JS cursors work on text only; the Rust core also takes lists.
147. Inserting at the cursor's index pushes it right (probed). <code>'start'</code>/<code>'end'</code> cursors stay pinned to the ends.
148. In a list a cursor anchors the slot, not the element: a move leaves it behind.
149. It follows undo's re-inserted copies by default (<code>followUndoneDeletions</code>), which only the undoing peer can see.
150. Resolving a deleted anchor replays history, so storing the <code>update</code> cursor keeps later lookups fast.
151. A separate package in the same repo, not exported by <code>loro-crdt</code>.
152. Nested <code>Y.Node</code>s form a tree, but a node cannot move: it is deleted and a clone inserted.
153. The older move stands on every node; the lost move is kept and can count later. Locally a move under a descendant throws <code>CYCLE</code>.
154. The loser's node stays where the other move put it; no event reports the dropped move.
155. The tutorial says to call <code>enableFractionalIndex</code>, but the code and 1.16.4 have it on by default (jitter 0). Concurrent inserts at one spot can interleave, which the docs accept for trees.
156. A move into a subtree removed concurrently is hidden with it (probe).
157. For nested nodes: an insert into a concurrently deleted node is deleted on arrival; undo can re-create a deleted node.
158. A child moved out of a deleted subtree comes back. The deleted node itself cannot be moved; <code>revertTo</code> and undo re-create it with new ids.
159. No rollback: if <code>fn</code> throws, the edits made so far stay and are sent.
160. Rust also offers an explicit <code>Transaction</code> with commit and rollback.
161. Not ACID: there is no rollback, and an op that throws leaves earlier ops in place. Consecutive local commits can merge into one change (<code>setChangeMergeInterval</code>, default 1000 s).
162. <code>open({ defer })</code> lets record files lag; the log is written at once.
163. Nested <code>transact</code> calls join the outer one; the update is emitted when it ends.
164. No timer; a callback with no ops makes no change.
165. Change metadata exposes <code>extraBytes</code> read-only; an author is stored in its actor's first change.
166. No custom fields beyond the message string. <code>subscribePreCommit</code> can rewrite the message and timestamp.
167. Origins reach observers, the <code>update</code> event and <code>UndoManager.trackedOrigins</code>.
168. Sources include <code>change</code>, <code>merge</code>, <code>applyChanges</code>, <code>receiveSyncMessage</code>; the change <code>message</code> is replicated, not local.
169. In JS <code>import()</code> takes no origin (Rust has <code>import_with</code>).
170. Third-party <code>y-utility</code> offers undo across docs, not atomic changes.
171. Runs inside the mutation queue before the op is stamped; an entity validator then folds defaults into the op.
172. Observers may add edits in a follow-up transaction, but cannot cancel one.
173. A skipped op is still logged and relayed. A host refuses outright what is out of scope, malformed, skewed, forged, or unsigned under <code>'require'</code>.
174. The threat model calls server-side update filtering an antipattern and suggests a separate fork for untrusted writers.
175. No per-change rule. On main only (unreleased), <code>maskAuthor(doc, author, heads)</code> hides an author's later changes in this replica's view.
176. The doc also emits <code>beforeTransaction</code>, <code>beforeObserverCalls</code>, <code>afterAllTransactions</code>, <code>updateV2</code>, <code>subdocs</code>.
177. No per-container observers in the core; automerge-repo <code>sub()</code> handles get scoped events.
178. In 13.6.33 (npm <code>latest</code>) map events also list each key's <code>oldValue</code> in <code>event.changes.keys</code>.
179. No raw bytes in the event; <code>getLastLocalChange()</code> returns them.
180. No old values, except a tree move's old parent and index. Update bytes come from <code>subscribeLocalUpdates</code>.
181. One per field by kind (<code>put</code>, <code>inc</code>, <code>add</code>, <code>remove</code>, <code>splice</code>, <code>treeMove</code>…); a text's marks are not diffed.
182. <code>node.delta</code> is a maintained live copy of the deep state.
183. It returns a corrective delta when part of the input addressed rendered-but-deleted content.
184. A map-key <code>del</code> patch throws ('index is not a number for patch'), so round-trips that delete keys fail (probed).
185. <code>getPathTo(parent, child)</code> computes a path for an event target.
186. None in the core. The docs' Refs page (<code>handle.ref()</code>, <code>findRef</code>) describes an API the repo source at 3ab7c33 no longer has.
187. Listeners are contained: a throw is logged and never fails the write.
188. Edits made by observers run as further transactions, one after another.
189. The doc keeps current state plus tombstone ids. With <code>gc: false</code> deleted content stays, but not when or by whom.
190. Per record, newest first, 50 by default; <code>log.entriesOf(id)</code> gives the raw entries.
191. Per-client insert ranges are available (<code>createInsertSetFromStructStore</code>), not grouped into changes.
192. <code>getHistory</code> and <code>topoHistoryTraversal</code> are <code>@hidden</code>; automerge-repo <code>handle.history()</code> lists heads in topological order.
193. v14 adds <code>SnapshotRenderer</code> to render the doc as it was.
194. Once compaction ran, a version is exact only from a reset stamped above <code>droppedTs</code>, else <code>HISTORY_GONE</code>; the cost is one <code>applyOp</code> per retained op of the record. A tag costs a copied file per record changed after it.
195. A past version cannot be named afterwards: deletes carry no clock, so only snapshots the app kept can be restored.
196. <code>view</code> throws if a head is unknown.
197. Marks are not diffed, and a list's moves come back as splices.
198. Arbitrary versions need docs for both (e.g. from snapshots). In 13.6.33 (npm <code>latest</code>) diffs come from <code>Y.Text.toDelta(snapshot, prevSnapshot)</code>.
199. <code>diffPath</code> (experimental) limits it to one object.
200. A text's marks are not restored, since they are not diffed.
201. No <code>revertTo(version)</code>; the app computes the ids changed since a version, and the code warns it may fail with GC on.
202. That recipe threw on a map-key deletion in our probe.
203. Local to the node: tags do not replicate.
204. Yjs records only <code>clientID</code>s; mapping changes to users is collected by the app or server, e.g. from each update's <code>createContentIdsFromUpdate</code>. In 13.6.33 (npm <code>latest</code>) only the experimental <code>PermanentUserData</code>.
205. 3.5.0 maps authors to actors (<code>getAuthors</code>, <code>getActorsForAuthor</code>); op ids name each value's actor (<code>getConflicts</code> keys).
206. Attribution is by peer id; map peers to users yourself (e.g. with <code>subscribeFirstCommitFromPeer</code>).
207. Before what compaction dropped a version is <code>HISTORY_GONE</code>, and a peer behind the floor bootstraps from a snapshot. <code>compact()</code> lays a text's marks again; it names the elements anew, so old cursors read <code>null</code> and a stacking mark has a new id.
208. No shallow snapshot. A collected doc can no longer restore snapshots.
209. The trimmed doc cannot check out before its root, and rejects updates from peers whose edits are based on an older version.
210. A purge wins at any stamp; signatures and digests stay so the headers still verify, and the tags drop their copies. Per record, not per field; a peer that never comes back keeps what it had.
211. A peer with <code>gc: false</code>, or stored raw updates not yet compacted, keep the bytes; <code>mergeUpdates</code> keeps the first encoding it sees.
212. <code>anonymize()</code> makes a scrubbed copy for sharing, not an in-place purge.
213. Only exported bytes are cleaned (reload from them), and deleted tree nodes' data stays because a later move can revive them. <code>redactJsonUpdates</code> blanks content in exported JSON updates.
214. The fork has its own key pair and log, and forks the whole storage, not one record.
215. In 13.6.33 (npm <code>latest</code>) there is no <code>cloneDoc</code>: <code>applyUpdate(new Y.Doc(), encodeStateAsUpdate(doc))</code>.
216. Needs <code>gc: false</code> on the source.
217. Joins as state when the source compacted past what the other needs (<code>joined: true</code>).
218. Rust exposes the same as <code>isolate(heads)</code> / <code>integrate()</code>.
219. Edits made while detached get a new peer id per checkout and form a concurrent branch; imports go to the log only until <code>attach()</code>.
220. New in v14; the threat model recommends a separate doc for suggestion-only users.
221. On main at 5bae775 only: not in the npm 3.5.0 build.
222. An update applied without an origin has origin <code>null</code> and is tracked as local; providers pass themselves as origin.
223. Changing the peer id clears both stacks.
224. A peer's edit of the same list or text blocks undoing it; a whole-record step with a conflict is skipped whole.
225. <code>ignoreRemoteAttributeChanges</code> lets undo overwrite a peer's attr change.
226. Each chunk: magic <code>85 6f 4a 83</code>, 4-byte checksum, type, length. Sync messages are v1 (<code>0x42</code>) or v2 (<code>0x43</code>); v2 may carry a whole document.
227. yrs reimplements both formats, a second implementation to read against.
228. State without history, tombstones included; <code>at(tag).snapshot()</code> pages a past state.
229. Yjs keeps no history to leave out; deleted content is included only with <code>gc: false</code>.
230. <code>toJS(doc)</code> gives the plain JSON value.
231. <code>log.since(eventId)</code> is the public reader; the selection by vector (<code>src/sync/outbound.js</code>) is internal.
232. The whole delete set always goes along.
233. Ops need no merging: a batch is a list deduplicated by <code>(origin, seq)</code>, and <code>applyOp(entry, op)</code> is pure too.
234. v14 adds <code>intersectUpdateWithContentIds</code> and marks <code>diffUpdate</code> deprecated.
235. automerge-cli <code>merge</code> loads several files and writes one compacted document.
236. <code>decodeImportBlobMeta(bytes)</code> reads a blob's versions and mode without a doc.
237. Imported back with <code>mergeSnapshot()</code> and <code>applyRemote(ops)</code>.
238. automerge-cli <code>examine</code> prints changes as JSON; <code>export</code>/<code>import</code> move state, not changes.
239. A catalog file indexes ids, and a sequence's index is cached per entry; no lazy or columnar encoding.
240. Subdocuments are the way to load parts on demand. B4 parses in 39 ms (13.6.11, crdt-benchmarks).
241. Load verifies heads by default (hidden <code>unchecked</code> skips it). The 3.0 blog cites a 17-hour load cut to 9 s.
242. v14 reads v13 updates; it writes new nodes with the XML type refs, so a v13 reader sees them as <code>Y.XmlFragment</code>/<code>Y.XmlElement</code>.
243. No written policy beyond 'we try and respect semver'; 0.11 began rejecting documents with misordered marks (<code>rescue</code> recovers their value).
244. The decoder error says the format is backward compatible but not forward compatible; container kinds a reader does not know are kept as Unknown.
245. v14 tests use <code>@y/protocols</code> 1.0.6-rc.1 (not cloned).
246. Based on arXiv:2012.00472; it assumes a reliable in-order stream.
247. The protocol repo is not in the clones; this comes from its announcement post.
248. The subscription resumes from the saved last event id; a node below the host's log floor bootstraps from a snapshot. Duplicates are dropped by vector.
249. A persisted <code>SyncState</code> (<code>encodeSyncState</code>) keeps the shared heads across sessions; when over a third of the doc is due, v2 sends the whole compressed doc.
250. Across origins, a list or text op whose anchor has not arrived is held as pending work, 4 096 per field.
251. v14 also stores gaps in one client's stream as skips. Pending data is re-sent by <code>encodeStateAsUpdate</code>.
252. <code>load()</code> throws on missing changes unless <code>allowMissingChanges</code>.
253. Messages are JSON values over call and subscribe, not raw bytes; WebRTC goes through wrpc's peer links. No BroadcastChannel adapter.
254. Providers are not cloned; many third-party ones exist.
255. No official WebRTC adapter in the clones.
256. The host checks <code>authorize</code>, scopes, push limits, op shape, skew and signatures, and runs its own validators and hooks.
257. Not cloned, so described from the README only; the threat model calls server-side update filtering an antipattern. Third-party: Hocuspocus, y-sweet, y-redis.
258. The public <code>wss://sync.automerge.org</code> is not meant for production; Keyhive (alpha) adds an access policy for Subduction servers.
259. It validates only what its <code>authenticate</code> hook checks; persistence goes through <code>onLoadDocument</code>/<code>onSaveDocument</code>. Not in the clones.
260. Both store updates and compact them after 500.
261. Safe for concurrent writers: chunks are keyed by heads or hash, and compaction deletes only what it loaded.
262. <code>Presence</code> (heartbeats, per-peer state) ships in the 2.6 alphas.
263. A subset of records, never part of one.
264. No sync of a subtree per peer; the FAQ splits data into docs where permissions differ.
265. Within a document everything syncs.
266. The <code>subscribePreCommit</code> docs show building a Merkle DAG yourself by hashing <code>exportJsonInIdSpan</code> into the commit message.
267. Keyhive (alpha) signs sync traffic and contact cards, not individual changes; <code>emptyChange</code> is suggested for signing merged heads yourself.
268. A payload <code>applyOp</code> cannot admit — of any op type — is <code>OP_REFUSED</code> (malformed) and logged as a no-op; a page that throws is retried from its cursor.
269. Items are integrated before the delete set is read, so a truncated update leaves its items in the doc.
270. Probe: a change with an op on an unknown object (built with <code>encodeChange</code>) threw <code>PanicError</code> from Rust, via <code>applyChanges</code> and via a sync message; the same doc then panicked on its next <code>change</code>.
271. Many of these paths trapped the WASM instance until 1.16.4. A Rust panic still kills the instance (e.g. <code>configTextStyle</code> with ':' in a key).
272. <code>pendingMax</code> 4 096 per field (snapshot blocks too), a run 2^20 and a field 2^22 slots, trees 512 levels and 1 024-character indexes, an origin's counter sum ±2^53−1, <code>maxSkew</code> 24 h, per-peer <code>opsPerPush</code>, <code>bytesPerPush</code> and <code>opsPerSecond</code>. Nothing else caps a set's size or a tree's move count.
273. The decoder sizes arrays from wire counts; the threat model leaves size limits to the app.
274. A libFuzzer target and crash fixtures (<code>too_many_ops</code>, <code>overflow_in_length</code>…) cover loading.
275. Nothing bounds the size of an update or the pending queue; a WASM out-of-memory traps the instance.
276. Third-party: secsync, Matrix-CRDT, managed services.
277. The docs say Keyhive is still in development and details will change.
278. Also every arrival order of small op sets in the op, sequence and tree tests. The fuzz compares the blocks and move logs, not only the reading; one seed each.
279. <code>write_frontier_parity</code> drives two peers and checks patches against hydrate and reload; the batch tests apply random edits from forks; the repo fuzz (3 repos, 100k changes) is a script, not CI.
280. The README says preservation and commutativity are proven so far and that the paper's pseudocode has errors.
281. <code>sync.rs</code> names arXiv:2012.00472 as the protocol's basis; nothing about the CRDT is verified in the repo.
282. The repo runs loom, a model checker for thread interleavings of the Rust doc, which tests thread safety rather than convergence.
283. Rust panics surface in JS as <code>PanicError</code>.
284. In JS a <code>LoroError</code> becomes a plain string (no class or code); a few paths throw <code>Error</code>, and a Rust panic traps the instance.
285. Other devtools listed (y-sweet, Liveblocks, Velt) are third-party.
286. automerge-repo logs through <code>debug</code> (<code>DEBUG=automerge-repo:*</code>).
287. Best-effort, not cryptographic: the change graph, types, sizes and string lengths remain.
288. <code>@automerge/react</code> bundles the hooks with the repo and common adapters.
289. Official loro-dev packages outside the clones; no Vue, Svelte or Solid binding is named.
290. v14's <code>Y.Node</code> API is in JSDoc and two repo notes; the site and most of the README describe v13.
291. The README calls the Rust API low level and not well documented; the binary format has its own spec page.
292. CI builds and tests on Linux, macOS and Windows, runs the WASM and JS suites and a Node 18 packaging test; the C API has cmocka tests.

<!-- comparison:end -->

## Speed

The four run the same text scenarios on the [Benchmarks](/guide/benchmarks) page, in a fresh
process each, on one machine and in memory: one character typed at the end of a text, at its start,
and at a random place, while the text grows past ten thousand characters. The other libraries are
the published packages (`yjs` 13.6.33, `@automerge/automerge` 3.5.0, `loro-crdt` 1.16.4), not the
cloned commits.

<BenchCompare :only="['syncom', 'syncom-secure', 'yjs', 'automerge', 'loro']" kind="append" line="memory" />

A syncom keystroke is an op: stamped, appended to the log, applied to the text's rope in
O(log n), and the record file written once per deferred window — in the secure build signed too.
The pure build types two to three times Automerge's rate; Yjs and Loro stay ahead, five to ten
times at the end, Loro most of all. The keystroke that extends the writer's own run at the end is
the cheapest (about 74 000 a second); one at the start or at random places a new run (38 000 to
48 000). On disk, every keystroke awaited until it is stored, syncom types 21 000 to 30 000 a
second, Automerge about 2 900, Yjs 12 000 to 21 000 and Loro about 40 000 (the `disk` line of the
same chart on [Benchmarks](/guide/benchmarks)).

<BenchFigure chart="cores" :only="['syncom', 'syncom-text', 'syncom-all', 'yjs', 'automerge', 'loro']" />

The three CRDT libraries' whole packages, against syncom's core, the core with the `text` plugin
(what an editor's CRDT needs) and everything (`/all`). Automerge and Loro carry a
WebAssembly module of 3.2 to 3.5 MB (about 1.1 MB gzipped); Yjs and syncom are plain JavaScript.

## Which to choose

- **Yjs** for a collaborative editor in the browser: the most editor bindings (ProseMirror, Tiptap,
  CodeMirror, Monaco, Quill, Lexical), presence, providers for WebSocket and WebRTC, and a small,
  fast core. Its 14.0 release adds diffs, attribution and suggestions; check which bindings already
  support it.
- **Automerge** when every change must be kept and traced: a hash-linked history that every
  replica checks, readable conflicts, a sync protocol in the core, `automerge-repo` for many
  documents with storage and network adapters, and bindings for Rust, C, Python and Swift.
- **Loro** for the richest document model and the fastest large documents: movable lists, movable
  trees, rich text with per-key expand rules, time travel and `revertTo`, shallow snapshots,
  undo that transforms over peers' edits, and lazy loading.
- **syncom** when the data is many records rather than one document, and nodes must check what
  they receive: a peer's op is signed and validated, scopes decide what each peer gets, limits
  stop a hostile peer, `purge()` erases a payload everywhere, and tags, branches and undo work
  over the whole storage. Its lists, texts and trees merge like Loro's, with embeds, block
  markers, deltas and ProseMirror and CodeMirror bindings, typing past Automerge and Yjs on a
  real editing trace.
- **Together.** One of the three can hold the long documents many people type into at once, and
  syncom the records around them: who owns a document, its title, its tags, who may read it.

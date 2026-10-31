# Third-party notices

syncom has no runtime dependencies. A few of its algorithms were adapted from
other MIT- and BSD-licensed projects, read at the commits named below; this
file keeps their notices, as those licenses ask, and says which syncom files
carry the adaptation. Nothing was copied from json-joy (AGPL-3.0), Collabs or the
`fugue/` directory of the Fugue repository (Apache-2.0): those were read as
specifications only. The `automerge-perf` editing trace (CC-BY-4.0,
https://github.com/automerge/automerge-perf) is not redistributed: `pnpm
bench:compare` downloads it at bench time into a git-ignored cache
(bench/compare/trace.js) and replays it in the `trace` scenario.

## Fugue — `fugue-simple` (reference implementation)

Repository: https://github.com/mweidner037/fugue — `fugue-simple/src/index.ts`
(commit 31e74fe). The placement rule (`placeInsert`, `src/text/state.js`), the
sibling order (`rankAmong`, `src/text/splice.js`) and the iterative walk
(`walkSubtree`, `src/text/state.js`) of the sequence engine (`src/text/sequence.js`)
are adapted from it. The paper:
Matthew Weidner and Martin Kleppmann, "The Art of the Fugue: Minimizing
Interleaving in Collaborative Text Editing" (2023), arXiv:2305.00583.

> The MIT License (MIT)
>
> Copyright (c) 2023 Matthew Weidner and Martin Kleppmann.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Yjs

Repository: https://github.com/yjs/yjs (commit 0e0dc34). Three ideas of
the sequence engine (`src/text/sequence.js`, its op path in `src/text/splice.js`)
follow Yjs: deleted content collapsed to a length that
keeps the place (`ContentDeleted`; the run-length form is `src/text/rle.js`), consecutive inserts by one writer stored
as one run (`Item.mergeWith`), and an op whose dependency has not arrived
kept until it does (`pendingStructs`). The undo manager of `src/undo/undo.js`
follows the rules of Yjs's `UndoManager` (`src/utils/UndoManager.js`):
changes tracked by origin, merged into one step within a capture timeout,
an undo that refuses to overwrite what others changed since. No code was
copied.

> The MIT License (MIT)
>
> Copyright (c) 2023
>   - Kevin Jahns <kevin.jahns@protonmail.com>.
>   - Chair of Computer Science 5 (Databases & Information Systems), RWTH Aachen University, Germany
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Loro and loro-js

Repository: https://github.com/loro-dev/loro (commit 75e4bf2). Three rules of
the sequence engine follow Loro's: the movable list (`src/text/splice.js`) (a move cuts the slot the
element showed at, adds a one-element position run and points the element's
position register at it; `crates/loro-internal/src/state/movable_list_state.rs`,
`context/loro-js-movable-list.md`), the expand rule that picks a mark's anchor
sides and reverses under removal (`src/text/marks.js`; `crates/loro-internal/src/container/richtext.rs`),
and the stable cursor (`src/text/state.js`) as an element id with a side (`crates/loro-internal/src/cursor.rs`).
`src/order/order.js` is an adaptation of `loro-js/src/runtime/fractional-index.ts`
from bytes to a 62-letter alphabet. `src/tree/moves.js` follows Loro's movable tree
(`crates/loro-internal/src/state/tree_state.rs`, `loro-js/src/runtime/tree-moves.ts`)
in its rules — a removal is a move under a trash node, siblings order by a
fractional index then by stamp, a move that would make a cycle is kept and
skipped — over the algorithm of Kleppmann, Mulligan, Beresford and Gomes, "A
highly-available move operation for replicated trees" (2021); the fold itself
— kept per block, a move older than others landed by the paper's undo–do–redo —
is written for syncom's stamped move log and shares no code with Loro's. The rope under a block — `src/text/rope.js`, read by
`src/text/state.js` — follows the rules of `loro-js/src/runtime/ordered-index.ts`
and `sequence-index.ts`: a tree whose nodes carry the measures of what hangs
under them (here slots and visible slots), found by descending the measures
and positioned by climbing the hints an item keeps to its node and a node to
its parent, spans of a sequence as its leaves. The structure is syncom's — a
copy-on-write B+-tree by owner, its hints by a handle a node shares with its
copies and checked as they are climbed — and shares no code with Loro's treap.

> MIT License
>
> Copyright (c) 2023 Loro
>
> Copyright (c) Loro Developers (loro-js)
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Peritext

Repository: https://github.com/inkandswitch/peritext (commit 89c162d). The
stacking marks of `src/text/marks.js` — a mark flagged `many` that never
replaces another of its key and goes only by its own id — follow Peritext's
`allowMultiple` (`src/schema.ts`, `src/peritext.ts`). No code was copied.

> MIT License
>
> Copyright (c) 2021 Ink & Switch LLC
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## xxHash

Repository: https://github.com/Cyan4973/xxHash — `doc/xxhash_spec.md` (the
XXH32 algorithm, read as a specification; no code was copied). `src/hash.js`
implements XXH32 from it, in JavaScript, for the hash `anonymize` makes of a
string (src/inspect/inspect.js). xxHash's code is BSD-2-Clause; its notice, kept here as the
algorithm's author asks:

> Copyright (c) 2012-2021 Yann Collet
> All rights reserved.
>
> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
>
> * Redistributions of source code must retain the above copyright notice, this
>   list of conditions and the following disclaimer.
> * Redistributions in binary form must reproduce the above copyright notice,
>   this list of conditions and the following disclaimer in the documentation
>   and/or other materials provided with the distribution.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
> AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
> IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
> DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
> FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
> DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
> SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
> CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
> OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
> OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## list-positions

Repository: https://github.com/mweidner037/list-positions (commit 383b844).
The run-length form of a sequence's content in `src/text/rle.js` (read by
`src/text/state.js` and `src/text/splice.js`) — `["ab", 3, "c"]`, present items alternating with gap lengths — is the save
format of its `List` and `Text` (`src/lists/list.ts`, `src/lists/text.ts`),
and the rule that a writer extends its own run instead of anchoring a new one
follows `Order.createPositions` (`src/order/order.ts`).

> The MIT License (MIT)
>
> Copyright © 2024 Matthew Weidner
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## quill-delta

Repository: https://github.com/slab/delta — `src/Delta.ts` and
`src/OpIterator.ts`. The delta format the editor bindings exchange
(`[{ retain, attributes? }, { insert, attributes? }, { delete }]`) is Quill's,
and its algebra follows quill-delta's: the iterator that hands a delta out in
pieces (`hasNext`, `peekLength`, `peekType`, `next(n)`), `compose`,
`transform` with its priority at a tie and `transformIndex` (quill-delta's
`transformPosition`) in `src/text/quill.js`, which the editor binding
(`src/editor/editor.js`) and the text plugin's `toDelta` (`src/text/deltas.js`)
both stand on. syncom's versions are its own
JavaScript over the same rules (an embed is one unit, an attribute set to
null removes it). The license:

> BSD 3-Clause License
>
> Copyright (c) 2022, Slab, Inc.
>
> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
>
> 1. Redistributions of source code must retain the above copyright notice, this
>    list of conditions and the following disclaimer.
>
> 2. Redistributions in binary form must reproduce the above copyright notice,
>    this list of conditions and the following disclaimer in the documentation
>    and/or other materials provided with the distribution.
>
> 3. Neither the name of the copyright holder nor the names of its
>    contributors may be used to endorse or promote products derived from
>    this software without specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
> AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
> IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
> DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
> FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
> DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
> SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
> CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
> OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
> OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

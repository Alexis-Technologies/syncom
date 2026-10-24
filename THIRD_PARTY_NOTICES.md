# Third-party notices

syncom has no runtime dependencies. A few of its algorithms were adapted from
other MIT-licensed projects, read at the commits named below; this file keeps
their notices, as the MIT license asks, and says which syncom files carry the
adaptation. Nothing was copied from json-joy (AGPL-3.0), Collabs or the
`fugue/` directory of the Fugue repository (Apache-2.0), or from the
`automerge-perf` editing trace (CC-BY-4.0): those were read as specifications
only.

## Fugue — `fugue-simple` (reference implementation)

Repository: https://github.com/mweidner037/fugue — `fugue-simple/src/index.ts`
(commit 31e74fe). The placement rule (`placeInsert`), the sibling order and
the iterative walk of `src/sequence.js` are adapted from it. The paper:
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
`src/sequence.js` follow Yjs: deleted content collapsed to a length that
keeps the place (`ContentDeleted`), consecutive inserts by one writer stored
as one run (`Item.mergeWith`), and an op whose dependency has not arrived
kept until it does (`pendingStructs`). No code was copied.

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

## list-positions

Repository: https://github.com/mweidner037/list-positions (commit 383b844).
The run-length form of a sequence's content in `src/sequence.js` —
`["ab", 3, "c"]`, present items alternating with gap lengths — is the save
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

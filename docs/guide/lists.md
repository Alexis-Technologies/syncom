# Lists and text

A field can be a **list** — an array that nodes edit by position — or a
**text** — a string they type into. Two nodes that insert at the same spot
both keep what they wrote, each writer's run whole, and a deleted element
keeps its place so the anchors into it still resolve. The merge rule is
Fugue (Weidner & Kleppmann, 2023), the one Loro and list-positions use; the
same engine, `src/sequence.js`, carries both kinds, and a record with a text
field is still a record: it has a schema, it is queried, indexed and
searched like any other, and its ops travel in the same signed log.

```js
const id = await storage.insert({ title: 'Notes' });

await storage.splice(id, 'body', 0, 0, 'helo');   // a text field: insert at 0
await storage.splice(id, 'body', 3, 0, 'l');      // insert inside
await storage.push(id, 'body', ' world');         // append
await storage.splice(id, 'body', 5, 6);           // remove 6 from index 5
await storage.get(id);                            // { title: 'Notes', body: 'hello' }

await storage.push(id, 'items', [{ n: 1 }, 'two']); // a list field holds JSON values
await storage.splice(id, 'items', 1, 1, [2, 3]);    // replace 'two' with 2, 3
await storage.get(id);                              // { …, items: [{ n: 1 }, 2, 3] }
```

`splice(id, key, index, count, content)` removes `count` elements at `index`
and inserts `content` there — a string for a text, an array for a list; `push`
is a splice at the end. A live `Record` has the same two methods with its own
id. The first write decides the field's kind, and a call that only removes
takes it from the field.

Three things are refused (the same for `setAt()` and `move()`):

- **Past the end.** An index, or an index plus a count, beyond the field's
  length rejects with `code: 'OUT_OF_RANGE'` and `{ id, field, index, count,
  length }`. The check runs inside the mutation queue, against the field as
  it is at that moment — a concurrent peer's op cannot shift it between the
  check and the write.
- **Another kind.** A field is a register, a counter, a set, a list or a text,
  never two: `splice()` on a field a register holds throws `FIELD_KIND` with
  `kind: 'register'`, `update()` on a text throws with `kind: 'text'`, and a
  peer's op that breaks the rule is refused for that field (an `error` event,
  `OP_REFUSED`). A validator default for the field — `body: ''`, `items: []`
  — is folded into the write that creates the record and makes the field a
  register; leave list and text fields out of the defaults.
- **Arguments.** A non-string key, a negative index or count, content that is
  neither a string nor an array, an element JSON cannot carry, or a call that
  neither removes nor inserts are `TypeError`s.

## How it merges

Every element has one place in a tree, chosen by its writer and carried on
the op. A new run — the elements one `splice` inserted — is the right child
of the element before the insertion point when that element has no right
children (deleted elements included), otherwise the left child of the
leftmost descendant of its first right child. Siblings on one side are
ordered by origin. A run's own continuation is one of those right children,
so a writer typing on at the end of its run extends the run instead of
anchoring a new one: a keystroke costs no new key in the record. The reading
is the walk of that tree — left children, the element if alive, right
children — and the tree is a function of the *set* of runs, never of their
order of arrival. A run whose anchor has not arrived yet stays out of the
walk, with everything anchored on it, until the anchor lands; a cut is a
union of ranges per run, held the same way for a run not yet here; both are
bounded (`PENDING_MAX`, 4096 per field) against hostile input. Deleted
content is dropped and its place kept, as a length.

What that gives you, concretely:

- Two nodes typing at one spot both keep their text; the runs come out one
  after the other, ordered by the writers' ids, never letter by letter.
- A node that deletes a range while another types inside it keeps the typed
  text; the deletion takes only what it named.
- A reset — `set()` or `delete()` on the record — drops every run stamped
  below it. A run stamped above the reset but anchored on an element the
  reset dropped reads from the head: concurrent typing survives a concurrent
  reset, at the start of the field.
- A list or a text touched after a `delete()` revives the record, like a set
  or a counter would.

The one case Fugue orders differently from FugueMax: when two writers insert
right after the same element while each sees a different element following
it, their two runs may come out in either order. The letters of a run never
mix with another's.

## Moving and assigning

A list's elements keep their names: `setAt(id, key, index, value)` gives the
element at `index` a new value, `move(id, key, from, to)` puts the element
at `from` where it reads as `to` once it is out. Both are registers per
element — last writer wins, by stamp — so the merge keeps the element once:

```js
await storage.push(id, 'todo', ['write', 'test', 'ship']);
await storage.setAt(id, 'todo', 1, 'test it');     // ['write', 'test it', 'ship']
await storage.move(id, 'todo', 2, 0);              // ['ship', 'write', 'test it']
```

- Two nodes that move the same element concurrently leave it at the newer
  move's place, not twice: the element shows where its position register
  points. A move is a cut of the slot it showed at and a new one-element
  position run that names it, so every node keeps every position and shows
  the element at the one the register names.
- A move concurrent with a removal of the element brings it back at the new
  place — the removal took the old slot, the move made a new one. A removal
  made after the move takes the element away.
- A value set with `setAt()` follows the element through a concurrent move;
  a value set concurrently by two nodes resolves by stamp.
- `setAt()` and `move()` are for lists; a text has neither.

## Rich text

A text carries **marks**: a style over a range, with a name and a value.
`mark(id, key, start, end, name, value)` sets one, `unmark` removes one,
and `spans(id, key)` reads the text as runs of equal style — what an editor
renders:

```js
await storage.updateText(id, 'body', 'hello world');
const bold = await storage.mark(id, 'body', 0, 5, 'bold', true);
await storage.spans(id, 'body');
// [{ text: 'hello', marks: { bold: true } }, { text: ' world', marks: {} }]

await storage.splice(id, 'body', 5, 0, '!');   // typed at the end of the range: bold
await storage.splice(id, 'body', 0, 0, '>');   // typed before it: not
// [{ text: '>', marks: {} }, { text: 'hello!', marks: { bold: true } }, { text: ' world', marks: {} }]

await storage.mark(id, 'body', 8, 13, 'link', 'https://x', { expand: 'none' });
await storage.unmark(id, 'body', 0, 7, 'bold');
```

- **Expand.** `expand` says whether text typed at the range's edges takes the
  style: `'after'` (the default — bold grows as you type on), `'before'`,
  `'both'`, `'none'` (a link does not grow). A mark is two anchors, each an
  element and a side, and the rule picks the sides; a character typed after
  an element is its right child in the tree, before it its left child, so the
  same rule that places the text decides whether it is inside the mark —
  concurrently or not.
- **Resolution.** Per name, the newest mark covering a character wins and a
  null value is none; `unmark` over a range is a null mark under the
  reversed expand rule, so the removal grows where the style would not.
- **Many.** `{ many: true }` makes a mark stack with every other of its name
  instead of replacing it — comments, suggestions — and `spans` lists them
  as `[{ id, value }]`, oldest first. Such a mark goes only by its id:
  `unmark(id, key, markId)` with what `mark()` resolved to.
- The field still reads as the plain string; `spans` is raw — no lens, no
  read hooks. Blocks (paragraphs, headings) are records: a document is a
  list of block ids, each block a record with a text field.

## What travels

A `mark` op carries the two anchors, the name, the value and whether it
stacks — or the id of a mark to switch off. A `splice` op carries the cut ranges, `[run, offset, length]` per run, and
either the anchor of its new run (`at`: `^` the head, `>e` or `<e` the right
or left child of element `e`, named `ts:offset:origin`) or the writer's own
run to extend (`run`, `from`); `content` is the inserted string or array and,
empty, names the kind of a call that only removes. One call is one op, signed
and logged like any other — an editor that types a word sends one op per
keystroke unless it batches them (see below). A keystroke extending the
writer's run adds a few bytes of content to the record and nothing to its
metadata; a new run adds one key, about a hundred bytes.

```js
storage.on('change', (op) => {
  if (op.type === 'splice') console.log(op.key, op.value);
  // body { content: 'l', at: '<1792831354856:3:3oyEvh7q…' }
  // body { content: ' world', run: '1792831354856:3oyEvh7q…', from: 4 }
  // body { content: '', cut: [['1792831354856:3oyEvh7q…', 4, 6]] }
});
```

## Binding an editor

An editor holds its own string; syncom holds the record's. Hand the whole
new string over with `updateText()` and re-read the record on every
`change` of it:

```js
await storage.updateText(id, 'body', 'the quick brown fox'); // 1 — one op created the field
await storage.updateText(id, 'body', 'the slow brown dog');  // 3 — one op per hunk
await storage.updateText(id, 'body', 'the slow brown dog');  // 0 — nothing to do
```

`updateText` diffs the field against the new string *inside the mutation
queue* — Myers' algorithm over UTF-16 units, after the common prefix and
suffix are set aside — and sends one `splice` per hunk, last first, in one
turn of the queue, so a peer's op cannot land between the diff and the
splices. It resolves to how many ops it took; a difference deeper than a
thousand edit steps (a paste that replaces most of the text) is one op that
replaces the middle. Batch keystrokes into one call where you can — a word,
or a pause — so a burst of typing is one op rather than ten. Indices are UTF-16 code units, as
`String#slice` counts them; a splice that splits a surrogate pair is the
caller's to avoid.

## Costs and limits

- A record is read and written whole on every op, and a text lives three
  times on the node: as the field's string, as the runs in the record's
  metadata, and as the ops in the log. Keep a text to what a record is for —
  a note, a comment, a description, a block of a document — and make a long
  document a list of block records rather than one field.
- A `splice` larger than a host's `bytesPerPush` is refused for the whole
  page it rides in; a paste of megabytes belongs in several calls.
- A move adds a position run to the record's metadata — one key, about a
  hundred bytes — and the old slot stays as a tombstone: a list reordered
  thousands of times carries that history until a reset.
- Queries see a list as the array it reads as: an index on the field posts
  every element (`select({ tags: 'bug' })` finds a list holding `'bug'`), an
  equality against a whole array compares it in order, and a unique key over
  a list changes when the list does.

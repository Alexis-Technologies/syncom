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

Three things are refused:

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

## What travels

A `splice` op carries the cut ranges, `[run, offset, length]` per run, and
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

An editor holds its own string; syncom holds the record's. Send what changed
as one splice — the common prefix and suffix of the old and new text give the
index, the count and the inserted text — and re-read the record on every
`change` of it:

```js
const diffSplice = (before, after) => {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  return [start, endB - start, after.slice(start, endA)];
};

const [index, count, text] = diffSplice('hello', 'hallo'); // [1, 1, 'a']
await storage.splice(id, 'body', index, count, text);
```

Batch keystrokes into one call where you can — a word, or a pause — so a
burst of typing is one op rather than ten. Indices are UTF-16 code units, as
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
- Lists have no `move` yet: moving an element is a cut and an insert, and two
  nodes moving the same element concurrently leave it twice. Elements have no
  identity across that; `setAt` and `move` with per-element registers are
  the next step.
- Queries see a list as the array it reads as: an index on the field posts
  every element (`select({ tags: 'bug' })` finds a list holding `'bug'`), an
  equality against a whole array compares it in order, and a unique key over
  a list changes when the list does.

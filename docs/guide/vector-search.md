---
title: Vector search
description: Find the records nearest to an embedding with cursor.nearest(), by cosine, euclidean, manhattan or dot distance, and know where a scan stops scaling.
---

# Vector search

A vector search finds the records whose embedding lies closest to the embedding of a question: notes similar to
the one open, a search that matches meaning rather than words, recommendations. syncom does the search part with
`nearest()` on a query cursor. It does not compute embeddings, and it keeps no vector index: `nearest()` measures
every record the query matches, which suits thousands of records, not millions.

## Store embeddings

An embedding is an array of numbers in a field of the record, written like any other value:

<<< @/examples/vector-search.mjs#store

The vectors come from your model: a library such as transformers.js in the browser, or an embedding API called from
a server. Every vector of one field should have the same length, the length of the model's output. A record without
the field, or with a vector of another length, is skipped by every search rather than failing it, so drafts and
records written before you added embeddings stay out of the results until they get one.

The field is a plain register: it is written whole, the last write wins, and it replicates to every node like any
other field (see [Fields that merge](./fields)).

## Find the nearest records

`nearest(field, vector, k)` returns the `k` matches closest to `vector`, nearest first, each with its distance:

<<< @/examples/vector-search.mjs#nearest

By default the distance is the cosine distance, one minus the cosine of the angle between the two vectors: 0 for
vectors pointing the same way, 1 for unrelated ones.

## Search inside a query

`nearest()` is a method of the cursor, so the query decides which records are measured. An equality on an
[indexed](./query-optimizer) field narrows the candidates before a single vector is read, and `projection()` keeps
the vector out of the rows you get back:

<<< @/examples/vector-search.mjs#filter

The rows are copies of the records, read the same way `fetch()` reads them; a `limit()` or an `order()` on the
cursor plays no part, since `k` is the window and the distance is the order.

## Choose a distance

`distance` takes a name or a function:

<<< @/examples/vector-search.mjs#distance

`'cosine'` (the default) compares directions and ignores length, which is what most text embeddings want.
`'euclidean'` is the straight-line distance and `'manhattan'` the sum of the differences per dimension, for vectors
whose magnitude means something. `'dot'` is the negated dot product, so the largest product ranks first; for
vectors normalized to length 1 it ranks the same as cosine and costs less.

A function of two vectors that returns a number, smaller meaning nearer, is a distance too. The four built-in ones
are exported from `@alexify/syncom/search`, so a custom measure can build on them:

<<< @/examples/vector-search.mjs#custom

## Search a large collection faster

Every record the query matches is read and measured, and the `k` best are kept as they go by. The time grows with
the number of matches times the length of the vectors, and memory stays at `k` rows. The cheapest speed-up is a
condition that narrows: search the notes of one board, one language, one user.

When no such condition exists, you can build one. Pick a reference vector, keep each record's distance to it in an
indexed field, and narrow by that field before measuring. With the euclidean distance a record can only lie within
`radius` of the question if its distance to the reference is within `radius` of the question's, so the range
removes records without losing any that matter:

<<< @/examples/vector-search.mjs#prefilter

This is a radius search: records farther than `radius` are never measured, so pick a radius that holds at least
`k` records. Several reference vectors narrow further, one indexed field each.

## Limitations

- No vector index (no HNSW, no product quantization): `nearest()` is an exact scan over the matches. Plan on
  thousands of records per search, tens of thousands with a narrowing condition.
- `k` is at most 1000 and a vector at most 4096 numbers; past either `nearest()` rejects with a `TypeError`.
- syncom does not make embeddings, and it does not re-embed a record when its text changes: write the new vector
  in the same [transaction](./transactions-conflicts) as the text if they must stay in step.
- An embedding replicates with its record. A few hundred numbers per record is a few kilobytes on every node and in
  every op that rewrites it, so store embeddings where every node needs them.

## Coming from RxDB

RxDB ships the distance functions (`rxdb/plugins/vector`) and leaves the search to your code: read the candidates,
measure each, sort, slice. Its article on local vector databases builds both a full scan and an index of distances
to reference vectors by hand. In syncom the scan and the top `k` are one call on the cursor, and the
reference-vector narrowing above uses an ordinary index and range query.

::: code-group

<<< @/examples/vector-search.mjs#filter [syncom]

<<< @/examples/rxdb/vector-search.mjs#nearest [RxDB]

:::

<FromRxdb page="articles/javascript-vector-database" :rows="['vector', 'topK']" />

`nearest()` is in the [cursor reference](../reference/api#cursor).

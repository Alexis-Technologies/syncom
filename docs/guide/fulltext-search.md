---
title: Full-text search
description: Search the text of a collection with $text inside an ordinary query, typo-tolerant and ranked best first, from createSearch() of @alexify/syncom/search.
---

# Full-text search

A collection can name the fields that hold its words, and a query can then search them with `$text`. The search
runs on the node, over the records it holds, so it works offline and needs no search server. It is part of a
normal query: `$text` combines with equalities, `order()`, `limit()`, `count()` and `watch()` like any other
condition.

## Search a collection

Name the fields to search in the entity's `search` list, and give `createDatabase()` the index that searches them.
`createSearch()` comes from its own subpath, `@alexify/syncom/search`, so a node that never searches ships none of
it.

<<< @/examples/fulltext-search.mjs#open

Then put `$text` in a [query](./query):

<<< @/examples/fulltext-search.mjs#search

Rows come back best first unless the cursor has an `order()`. "Fox hunting" outranks "Quick brown fox" because a
short record holding the word scores above a long one. The scores themselves are not handed out.

An entity that declares `search` fields while `createDatabase()` has no `search` option is refused at open with a
`TypeError`, and so is a `$text` query on a collection without `search` fields: the mistake shows up the first time
the code runs, not as an empty result.

## Find words with accents, case and typos

The index ignores accents and case, and it tolerates small typos:

<<< @/examples/fulltext-search.mjs#fuzzy

The text is decomposed and its combining marks stripped (`Crème` becomes `creme`), lower-cased, and cut into words
at anything that is not a letter or a digit. Each word becomes a set of three-letter pieces, padded with a space at
either end, so `quick` is ` qu`, `qui`, `uic`, `ick` and `ck `. A record matches when it holds at least a share of
the query's distinct pieces, 0.3 by default. A typo touches only a few pieces of a word, so the rest still match;
the padding means a whole word outranks the same letters inside a longer one.

Ranking is TF-IDF over the shared pieces, divided by the square root of the record's length: a rare word weighs
more than a common one, and a short record holding the words outranks a long one. Ties go to the smaller id, so
every node ranks the same records the same way.

### Make matching stricter or looser

`minOverlap` sets the share of the query's pieces a record must hold, from 0 (one shared piece is a match) to 1
(every piece):

<<< @/examples/fulltext-search.mjs#strict

Raise it when short queries match too much; lower it for a corpus full of misspellings.

## Combine text with other conditions

`$text` sits at the top level of a query beside the other conditions. An equality narrows the ranked matches
without changing their order, `order()` sorts them by a field instead, and `limit()` and `one()` stop reading once
they have enough:

<<< @/examples/fulltext-search.mjs#combine

`count()` counts every match, not a page of them.

## Keep search results live

A `watch()` of a `$text` query hears every write that changes the matches, local or from another node:

<<< @/examples/fulltext-search.mjs#watch

A live `$text` query runs again after each change to its collection, because a new record can move every rank
below it. That is cheap for a search box over a few thousand notes; for a large collection that changes often,
search on demand instead of keeping a watch open.

## What gets searched

The text of a record is the strings in its `search` fields, as the record reads after the
[lens](./migration-schema): a string field, the strings of an array field (a [set](./fields) of tags, a list), and
the strings of objects a few levels down, joined by a space. Numbers and booleans are not words. A deleted record
never matches, and neither does an [encrypted](./encryption) one: the index never saw its text.

## What it costs

A write joins the record's text into the catalog row it updates anyway. The index takes the waiting texts at the
next `$text` query, so a field typed into a hundred times is indexed once, when someone searches. The index lives
in memory. The text is saved with the catalog, so a reopen rebuilds the index from it without reading a record; the
catalog grows with the text, which is why `search` suits titles and short bodies better than whole documents.
Changing an entity's `search` fields rebuilds the catalog once, from the records. Measured costs are on the
[Benchmarks](./benchmarks) page.

An index that throws is logged (`catalog.search`) and the write lands all the same: search is derived state and
never fails a write.

## Use an index of your own

`createSearch()` is one implementation of a small contract. The `search` option takes a function that receives an
entity name and returns an object with `put(id, text)`, `remove(id)` and `query(text)`, where `query` returns every
match as `{ id, score }`, best first. Any object with those three methods works, from a few lines of exact-word
matching to a wrapper around a search library:

<<< @/examples/fulltext-search.mjs#own-index

The catalog decides when to call `put` and `remove`. Your index never sees a deleted or encrypted record, and it
holds nothing that must survive a restart: every row is handed to it again at open.

## Limitations

- No phrases, no field-scoped terms and no boolean text operators: `$text` is a bag of words.
- One `$text` per query, at the top level, and at most 1000 characters. Inside `$and`, `$or` or `$not` it is a
  `TypeError` at `select()`.
- A `$text` query without an `order()` has no edge for `page()` to page by. Order it, or take the first matches
  with `limit()`.
- A view at a [tag](./versions) keeps no text index, so `$text` there is a `TypeError`.
- The index is per node and in memory. It is fine for the tens of thousands of short records a local-first app
  holds; for millions of long documents, search on a server.

## Coming from RxDB

In RxDB full-text search is a premium plugin built on FlexSearch: you create a search instance over a collection
and call its own `find()`, apart from the query language, with an index persisted in the collection. In syncom
`$text` is an operator of the ordinary query, so it combines with equalities, sorting, counting and live queries,
and the index is rebuilt in memory from the catalog at open. The built-in index has no phrase or field-scoped
search; where you need them, bring an [index of your own](#use-an-index-of-your-own) that has.

<FromRxdb page="fulltext-search" :rows="['fulltext', 'fulltextInQuery']" />

Every export of the subpath is in [the reference](../reference/api#search-subpath).

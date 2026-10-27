# src/tree/CLAUDE.md — The tree kind

The movable tree and its kept fold. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/tree/tree.js          @alexify/syncom/tree — the tree kind as a plugin, over src/tree/moves.js and src/order/order.js
src/tree/moves.js         the tree engine: per node its stamped moves, the fold in stamp order with the cycle check (Kleppmann
                          2021, Loro) walking MAX_WALK ancestors at most, MAX_DEPTH levels read, MAX_MOVES a field, prune and
                          join; the fold kept per block in a WeakMap and handed to the block an op makes (the head of its
                          lineage), an older move landed by undo–do–redo, the reading path-copied, the change report read
                          from what moved — requires vector.js, order.js (a place is a fractional index or the move is
                          malformed) and args.js
```

# src/prosemirror/CLAUDE.md — The ProseMirror adapter

The document as one text with block markers. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/prosemirror/prosemirror.js  the @alexify/syncom/prosemirror subpath — ProseMirror (injected `{ model, state, transform, view? }`)
                          over the editor binding: the document as one text with a marker per block-level node, the replace
                          step, cursors as decorations, undo commands over /undo; requires editor/editor.js only
```

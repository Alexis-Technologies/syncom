# src/codemirror/CLAUDE.md — The CodeMirror adapter

A ChangeSet as a delta, line breaks fitted. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/codemirror/codemirror.js  the @alexify/syncom/codemirror subpath — CodeMirror 6 (injected `{ state, view? }`) over the editor
                          binding: a ChangeSet as a delta and back, line breaks fitted, cursors as decorations, undo commands;
                          requires editor/editor.js only
```

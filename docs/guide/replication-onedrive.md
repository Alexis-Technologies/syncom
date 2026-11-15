---
title: OneDrive replication
description: Sync a collection between a user's devices through one JSON file in their OneDrive, over Microsoft Graph with the file's eTag as the compare-and-set.
---

# OneDrive replication

Choose the OneDrive adapter for the same job as [Google Drive](./replication-google-drive) when your users have
Microsoft accounts: no server of yours, and a user's devices share a collection through one JSON file in the user's
OneDrive. Every write goes up under the file's eTag, so a device that wrote first is never overwritten. It is a
[connector](./connectors) over `fetch` and a Microsoft Graph token, about 2.5 KB, with no Microsoft library bundled.

<div class="sc-steps">

### Get a token

Register an app in Microsoft Entra ID and sign the user in with MSAL, asking for the `Files.ReadWrite` permission
(delegated). The adapter takes the access token; refresh it with your own `fetch` that sets the current
`authorization` header, or create the connector again with a new token.

### Connect the collection

<<< @/examples/replication-onedrive.mjs#replicate

`path` is the file's path from the root of the drive. With `poll`, the adapter reads the file's eTag that often and
asks the connector to pull when it moved; without it, a live connector pulls every `retryTime`.

### Write, and add another device

The first push creates the file, and only if no file exists at that path yet. A second device replicates the same
path and reads everything with its first pull.

<<< @/examples/replication-onedrive.mjs#use

</div>

## How two devices stay apart

The item's metadata (`root:/<path>`) gives the eTag, `/content` the text, and `PUT root:/<path>:/content` writes the
whole file under `If-Match`. When another device wrote in between, Graph answers `412`: the adapter reads the file
again, judges each row against it (a document changed since this device last saw it is a conflict, which the file's
version wins unless you pass `resolve`), and writes again, up to three more times before the push fails and the
connector retries it later. Where this device knows no file yet, it creates one with
`@microsoft.graph.conflictBehavior=fail`, so a file another device created first is a `409`, read and judged like a
`412` rather than overwritten.

The file has the same shape as Google Drive's: `{ seq, docs }`, each document with the position `n` of its newest
write, deletions kept as `deleted` ([the format](./replication-google-drive#how-two-devices-stay-apart)).

## Options that matter

| Option | Default | Meaning |
| --- | --- | --- |
| `token` | `null` | The Graph access token, sent as a bearer token |
| `headers` | `{}` | Sent with every request, for an `authorization` of your own |
| `path` | (required) | The file's path in the drive, such as `Apps/TaskBoard/tasks.json` |
| `drive` | `'me/drive'` | The drive: the user's own, or `drives/<id>` |
| `poll` | `0` | How often to probe the file's eTag, in ms; `0` for none |
| `fetch` | the global `fetch` | The `fetch` the adapter calls |
| `endpoint` | `'https://graph.microsoft.com/v1.0'` | Graph's base url |

The adapter also answers `positionOf(id)`, a document's position as the file was last read. A pull downloads the file
only when its eTag moved since the last read.

## Limitations

- **4 MB per collection.** The adapter writes with Graph's simple upload, which takes files up to 4 MB, and every push
  uploads the whole file. Keep a replicated collection well under that.
- **A conflict is per document.** Two devices editing the same record offline end with one version: the one that
  wrote first, unless `resolve` merges them.
- **Live means polling.** `poll` probes the eTag, one small request each time.
- **The file is visible.** Unlike Google Drive's hidden application data folder, the file sits at a path the user can
  see and edit in OneDrive. A file that is not a collection file is refused, never overwritten, and an empty file reads
  as an empty collection.

## Coming from RxDB

RxDB's OneDrive plugin keeps a file per document and a lock file, without an `If-Match` on document updates, and
learns of other devices through WebRTC signals. This adapter keeps one file guarded by its eTag, creates it only where
none exists, and learns of other devices' writes by probing the eTag.

<FromRxdb page="replication-microsoft-onedrive" :rows="['onedrive', 'foreignBackend']" />

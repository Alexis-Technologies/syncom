---
title: Google Drive replication
description: Sync a collection between a user's devices through one JSON file in their Google Drive, with the file's ETag as the compare-and-set.
---

# Google Drive replication

Choose the Google Drive adapter when you have no server at all and want a user's devices to share their data through
the user's own Drive: a personal task list, an app's settings, notes. The adapter keeps one collection in one JSON
file, in the app's hidden application data folder by default, and every write goes up under the file's ETag, so a
device that wrote first is never overwritten. It is a [connector](./connectors) over `fetch` and an OAuth token,
about 2.5 KB, with no Google library bundled.

<div class="sc-steps">

### Get a token

Enable the Google Drive API for your Google Cloud project and sign the user in with Google Identity Services, asking
for the `https://www.googleapis.com/auth/drive.appdata` scope. That scope reaches only your app's own hidden folder,
which the user's Drive does not show among their files. The adapter takes the access token. Refreshing it is your
app's job: pass a `fetch` of your own that sets the current token's `authorization` header (and leave `token` out),
or create the connector again with the new token.

### Connect the collection

<<< @/examples/replication-google-drive.mjs#replicate

The adapter looks for `tasks.json` in the folder. With `poll`, it reads the file's ETag that often and asks the
connector to pull when it moved; without it, a live connector pulls every `retryTime`.

### Write

The file is created at the first push. It holds every document of the collection with the position of its newest
write, which is what a pull's checkpoint counts:

<<< @/examples/replication-google-drive.mjs#use

### Add another device

A second device replicates the same file. Its first pull reads everything; its writes go up under the ETag it last
read.

<<< @/examples/replication-google-drive.mjs#devices

</div>

## How two devices stay apart

Every push is a read, a change and a write of the whole file under `If-Match`. When another device wrote in between,
Drive answers `412`; the adapter reads the file again, judges each row against what it now holds (a row whose document
changed since this device last saw it is a conflict, which Drive's version wins unless you pass `resolve`), and writes
again, up to three more times before the push fails and the connector retries it later. A write is never
unconditional: a file whose metadata answers no ETag is refused with a `428` rather than written blind.

Two devices that start on an empty Drive at the same moment each create a file. After its create, a device lists the
files of that name again: the oldest by creation time is the collection's file, so the device whose file is newer
deletes it and writes into the older one. The two first pushes end in one file.

The file is plain JSON:

```json
{
  "seq": 3,
  "docs": {
    "t1": { "n": 2, "data": { "title": "Write the docs", "done": true } },
    "t2": { "n": 3, "deleted": true }
  }
}
```

`seq` is the newest position, and each document's `n` is the position of its newest write. A deletion stays in the
file as `deleted`, so a device that was away hears of it. An empty file reads as an empty collection, and a file that
is not a collection file is refused, never overwritten.

## Options that matter

| Option | Default | Meaning |
| --- | --- | --- |
| `token` | `null` | The OAuth access token, sent as a bearer token |
| `headers` | `{}` | Sent with every request, for an `authorization` of your own |
| `name` | | The file's name in the folder; required unless `fileId` is given |
| `fileId` | `null` | The file itself, when you know it: no search by name |
| `folder` | `'appDataFolder'` | The parent folder: the app's hidden folder, or a folder id (with a broader scope) |
| `poll` | `0` | How often to probe the file's ETag, in ms; `0` for none |
| `fetch` | the global `fetch` | The `fetch` the adapter calls |
| `endpoint` | `'https://www.googleapis.com'` | The API's base url |

The adapter also answers `fileId()`, the file's id once found or made, and `positionOf(id)`, a document's position as
the file was last read. A pull downloads the file only when its ETag moved since the last read.

## Limitations

- **One file per collection.** Every push uploads the whole file, so this suits a collection of hundreds of small
  records, not one that grows without bound.
- **A conflict is per document.** Two devices editing the same task offline end with one version: the one that wrote
  first, unless `resolve` merges them.
- **Live means polling.** Drive has no push notification the adapter uses; `poll` probes the ETag, one small request
  each time.
- **A file made after this device last read.** A device whose last read found no file, and which pushes after another
  device made it, is refused with a `428` (`REPLICATION_FAILED` on the `error` event) until its next pull reads the
  file: the live pull or the `poll` probe heals it within `retryTime` or `poll`, and with `live: false` only `reSync()`
  does.
- **Not yet run against Drive itself.** The adapter reads the ETag from the v2 metadata (v3 answers none) and sends it
  as `If-Match` to the v3 media upload, following the API's documentation; its tests run against a stand-in. If every
  upload answers `412`, the v2 upload endpoint takes the same `If-Match`.

## Coming from RxDB

RxDB's Google Drive plugin keeps a file per document and a lock file, and learns of other devices' writes through a
WebRTC signal between devices that are online at once. This adapter keeps the collection in one file guarded by its
ETag (no lock to release, no lock left behind by a crash) and learns of writes by probing that ETag, so a device
alone online still sees what another wrote.

<FromRxdb page="replication-google-drive" :rows="['gdrive', 'foreignBackend']" />

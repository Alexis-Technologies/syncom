# src/wrpc/CLAUDE.md — The wrpc adapter

WebRTC and wrpc are wrpc's, injected. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/wrpc/wrpc.js          the @alexify/syncom/wrpc subpath
```

## Rules

- **WebRTC is wrpc's.** There is no transport code in `src/` and must not
  be: a `PeerLink.remote` is a `WrpcClient`, `createWrpcLink(link.remote)`
  takes it, and `unit()` mounts on a `PeerHost`. The integration test runs
  over `tests/utils/fake-channel.js` (a fake data-channel pair) at the
  raw-channel level; a full `WrpcPeer` needs an RTC adapter and is checked
  by hand. Anything WebRTC-shaped that seems missing belongs in wrpc.
- **Streams are wrpc's.** The link's `stream(id)` and `createStream(name, size)` are the client's `getStream` and
  `createStream`, handed over as they are: a WrpcReadable the engine iterates (a snapshot page, a blob), a
  WrpcWritable it writes a blob's bytes into with the writable's own `writeAll` (src/sync/chunks.js `sendAll`:
  `writeAll`, `end`, `closed`), which takes wrpc 2.1 or later. Chunking, pacing, the frames and the stop are wrpc's:
  `writeAll` writes 64 KiB at a time as the transport takes it (its WebRTC framing splits a chunk further by itself),
  and a reader that lets go — `readable.terminate()` — stops its writer across the wire. Nothing here buffers,
  encodes, re-frames or keeps a stop of its own, and bytes never go as base64 where wrpc carries a stream.
- **wrpc is injected, never required.** Nothing under `src/` may
  `require('@alexify/wrpc')`; `scripts/size.js` fails on any bare import in a
  browser bundle anyway. `src/wrpc/wrpc.js` duck-types the client it is handed, and
  `unit()` (`src/sync/hosting.js`) builds plain `{ access, handler }` objects that
  `defineRouter` accepts without wrpc's `procedure()`. The `tracked` shape it emits is
  `Symbol.for('wrpc.tracked')` — part of wrpc's frozen wire protocol.

'use strict';

// A blob's bytes as they cross a link: a stream of the transport's (wrpc's binary streams — a writable on one end,
// a readable the other end iterates), in pieces of CHUNK_BYTES, never one message of the whole and never base64
// where the transport carries bytes. One message of a blob is what a transport's message limit refuses (16 MiB on
// most of wrpc's engines; a blob may be 64 MiB) and what nothing paces; a piece is written when the transport takes
// it. Both halves use both functions: the host pumps a download and collects an upload, the dialer the other way
// round. No requires.

// What wrpc's own uploader writes at a time, and what its WebRTC framing splits further by itself.
const CHUNK_BYTES = 64 * 1024;

const encoder = new TextEncoder();

/** Whether a host's client (wrpc's `context.client`) carries binary streams: a persistent, binary transport. */
const streams = (client) =>
  Boolean(client) &&
  client.binary !== false &&
  client.persistent !== false &&
  typeof client.createStream === 'function';

/**
 * Writes `bytes` into a writable of the transport's (`write(chunk)` answering false while it is full, `drain` once
 * it is not, `closed` after the connection went) in pieces of CHUNK_BYTES, then ends it. `stopped()` answering true
 * between two pieces — the other end answered already — terminates the stream instead. Resolves to whether every
 * byte went; never rejects for a closed transport.
 */
const pump = async (stream, bytes, stopped = null) => {
  for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
    if (stopped !== null && stopped()) {
      stream.terminate();
      return false;
    }
    const accepted = stream.write(bytes.subarray(at, at + CHUNK_BYTES));
    // A write refused by a closed transport is followed by no `drain`.
    if (stream.closed) return false;
    if (!accepted) {
      await new Promise((resolve) => stream.once('drain', resolve));
      if (stream.closed) return false;
    }
  }
  stream.end();
  return true;
};

/**
 * The chunks of a readable as one Uint8Array of `size` bytes, read no further than that: the stream's end is not
 * waited for (a sender that announced one size and sent another would be waited for for good). Fewer bytes than
 * `size` — the stream ended or was cut — are answered as they are, for the caller to refuse; more is `null`.
 */
const collect = async (chunks, size) => {
  const parts = [];
  let length = 0;
  if (size > 0) {
    for await (const chunk of chunks) {
      const part = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
      length += part.length;
      if (length > size) return null;
      parts.push(part);
      if (length === size) break;
    }
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], at);
    at += parts[i].length;
  }
  return out;
};

module.exports = { CHUNK_BYTES, streams, pump, collect };

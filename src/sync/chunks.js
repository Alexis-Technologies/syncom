'use strict';

// A blob's bytes as they cross a link: a stream of the transport's (wrpc's binary streams — a writable on one end,
// a readable the other end iterates), never one message of the whole and never base64 where the transport carries
// bytes. The pieces are the transport's own: `writeAll` (wrpc 2.1) writes 64 KiB at a time, each when the transport
// takes it, and stops once the transport closed or the reader let go. Both halves use both functions: the host
// sends a download and collects an upload, the dialer the other way round. No requires.

const encoder = new TextEncoder();

/** Whether a host's client (wrpc's `context.client`) carries binary streams: a persistent, binary transport. */
const streams = (client) =>
  Boolean(client) &&
  client.binary !== false &&
  client.persistent !== false &&
  typeof client.createStream === 'function';

/**
 * Writes every byte of `bytes` into a writable of the transport's (`writeAll`, wrpc's pieces paced by the
 * transport) and ends it once all of it went. Resolves to whether it did: false once the transport closed or the
 * reader let go of the stream (wrpc tells its sender), and the stream is then left as the transport left it.
 */
const sendAll = async (stream, bytes) => {
  const all = await stream.writeAll(bytes);
  if (all) stream.end();
  return all;
};

/**
 * The chunks of a readable as one Uint8Array of `size` bytes, read no further than that: a sender that sends more
 * than it announced is stopped there, never held in memory. Fewer bytes than `size` — the stream ended or was cut —
 * are answered as they are, for the caller to refuse; more is `null`. A transport that fails the stream (wrpc: cut
 * short, or past the size it announced) throws from the iteration.
 */
const collect = async (chunks, size) => {
  const parts = [];
  let length = 0;
  for await (const chunk of chunks) {
    const part = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    length += part.length;
    if (length > size) return null;
    parts.push(part);
    if (length === size) break;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], at);
    at += parts[i].length;
  }
  return out;
};

module.exports = { streams, sendAll, collect };

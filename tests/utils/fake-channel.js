'use strict';

// A connected pair of fake RTCDataChannels — what wrpc's WebRTC transport
// speaks on when an application negotiated the channel itself
// (`attachChannel` on the host, `connect(url, { transport: 'webrtc',
// channel })` on the client). The contract wrpc checks (`isRtcDataChannel`):
// `send`, `close`, `addEventListener`, `removeEventListener` and a string
// `readyState`; what it uses: `binaryType`, `bufferedAmount`,
// `bufferedAmountLowThreshold`, the `message`/`close`/`error`/
// `bufferedamountlow` events, and that `send(view)` copies the bytes of
// the view it was given before returning — the framing reuses one buffer
// for every fragment. Not a *.test.js: a helper.

const copyOf = (data) => {
  if (typeof data === 'string') return data;
  const view =
    data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return view.slice().buffer;
};

class FakeChannel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'blob';
  peer = null;
  sent = 0;

  constructor(label, id) {
    super();
    this.label = label;
    this.id = id;
    this.negotiated = true;
    this.ordered = true;
  }

  send(data) {
    if (this.readyState !== 'open') throw new Error('RTCDataChannel.send: channel is not open');
    this.sent++;
    const copy = copyOf(data);
    const { peer } = this;
    queueMicrotask(() => {
      if (peer.readyState !== 'open') return;
      peer.dispatchEvent(new MessageEvent('message', { data: copy }));
    });
  }

  close() {
    if (this.readyState !== 'open') return;
    const { peer } = this;
    for (const channel of [this, peer]) channel.readyState = 'closing';
    queueMicrotask(() => {
      for (const channel of [this, peer]) {
        channel.readyState = 'closed';
        channel.dispatchEvent(new Event('close'));
      }
    });
  }
}

/** Two open channels wired to each other: `[a, b]`. */
const createChannelPair = ({ label = 'wrpc', id = 0 } = {}) => {
  const a = new FakeChannel(label, id);
  const b = new FakeChannel(label, id);
  a.peer = b;
  b.peer = a;
  return [a, b];
};

module.exports = { createChannelPair, FakeChannel };

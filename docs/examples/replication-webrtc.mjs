// docs-examples: browser-only (needs RTCPeerConnection and a signaling hub; follows wrpc's WebRTC API and the raw-channel scenarios of tests/wrpc.integration.test.js)
// The WebRTC page (docs/guide/replication-webrtc.md) shows the regions of this file. It is only parsed by
// tests/package/docs-examples.test.js; replication-webrtc-hub.mjs runs the hub's side in Node.
// What the app already has: its signed-in user and token, and its STUN/TURN servers.
const user = { id: 'ada' };
const token = localStorage.getItem('token');
const iceServers = [{ urls: 'stun:stun.example.com:3478' }];
// For the last region: the two ends of a data channel the app negotiated itself, one on each peer.
const myChannel = new RTCPeerConnection({ iceServers }).createDataChannel('syncom');
const theirChannel = myChannel; // on the other peer: what its RTCPeerConnection's `datachannel` event handed over

// #region peer
import { createDatabase } from '@alexify/syncom/all';
import { createWrpcLink } from '@alexify/syncom/wrpc';
import { connect } from '@alexify/wrpc';
import { WrpcPeer, wrpcSignaler, defineRouter } from '@alexify/wrpc/webrtc';

const HUB = 'wss://board.example.com/api';
const myBoards = ['design'];
const client = await connect(HUB, { headers: { authorization: `Bearer ${token}` } });
let peer = null; // made after createDatabase(): its router mounts the database's unit

const db = await createDatabase({
  path: 'board',
  schema: { entities: { Task: {} } },
  sync: {
    scope: (id, data) => data.board ?? '*',
    // A node's url says where it is: the hub's WebSocket, or a peer's id.
    connect: async (node) => createWrpcLink(node.url.startsWith('ws') ? client : (await peer.connect(node.url)).remote),
    // The registry is on disk and may hold peer ids from the last run: dial once `peer` exists.
    autoStart: false,
  },
});
// #endregion peer

// #region authorize
// Under wrpc's default trust ('link') a peer's session names the peer the hub admitted.
const authorize = (context, hello) =>
  context.session?.data?.peer === hello.node && hello.scopes.every((board) => myBoards.includes(board));
// #endregion authorize

// #region start
peer = new WrpcPeer({
  router: defineRouter({ syncom: db.sync.unit({ access: 'session', authorize }) }),
  signaler: wrpcSignaler(client, { identity: () => user.id }),
  iceServers,
});
await peer.start();
if (!db.sync.listNodes().some((node) => node.url === HUB)) {
  await db.sync.addNode({ url: HUB, scopes: myBoards });
}
await db.sync.start();
// #endregion start

// #region room
const attach = async (id, board) => {
  if (db.sync.listNodes().some((node) => node.url === id)) {
    await db.sync.enableNode(id, false); // the edge came back: a fresh link
    await db.sync.enableNode(id, true);
  } else await db.sync.addNode({ url: id, scopes: [board] });
};

for (const board of myBoards) {
  const mesh = peer.join(`board:${board}`);
  // One link per pair is enough; the peer with the lower id dials, as wrpc's initiator does.
  mesh.on('join', ({ id }) => peer.id < id && attach(id, board));
  mesh.on('leave', ({ id }) => db.sync.removeNode(id).catch(() => {}));
}
// #endregion room

// #region raw-channel
import { PeerHost, RtcPeerTransport } from '@alexify/wrpc/webrtc';

// On the peer that dials: the RTCDataChannel your app negotiated is a wrpc client, so a syncom link.
const dialer = await createDatabase({
  path: 'dialer',
  sync: {
    connect: async () =>
      createWrpcLink(await connect('webrtc:host', { transport: 'webrtc', channel: myChannel, reconnect: false })),
  },
});
await dialer.sync.addNode({ url: 'webrtc:host' });

// On the peer that hosts: a PeerHost over its end of the channel mounts the unit.
const host = new PeerHost({ router: defineRouter({ syncom: db.sync.unit({ access: 'session', authorize }) }) });
host.attach(new RtcPeerTransport(theirChannel, { peer: 'dialer' }), { peer: 'dialer' });
// #endregion raw-channel

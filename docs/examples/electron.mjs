// docs-examples: browser-only (Electron's main process, preload and renderer; docs/examples/electron-threads.mjs runs the same wiring in Node)
// The Electron page (docs/guide/electron.md) shows the regions of this file: three files of an Electron app, side
// by side. They follow Electron's documented MessageChannelMain API and cannot run here.

// #region main
// main.mjs: the main process owns the storage and serves it to the window
import { join } from 'node:path';
import { app, BrowserWindow, MessageChannelMain } from 'electron';
import { sqliteEngine } from '@alexify/syncom/sqlite';
import { serveEngine } from '@alexify/syncom/engines';

// MessagePortMain is an EventEmitter that hands listeners a MessageEvent: shape it as a web MessagePort.
const asPort = (port) => ({
  postMessage: (message) => port.postMessage(message),
  addEventListener: (type, listener) => port.on(type, listener),
  removeEventListener: (type, listener) => port.off(type, listener),
  start: () => port.start(),
  close: () => port.close(),
});

await app.whenReady();
const engine = sqliteEngine({ file: join(app.getPath('userData'), 'app.sqlite') }); // node:sqlite, or `driver`

const win = new BrowserWindow({
  webPreferences: { preload: join(import.meta.dirname, 'preload.mjs'), sandbox: false }, // an ESM preload
});
const { port1, port2 } = new MessageChannelMain();
serveEngine(engine, asPort(port1), { allow: ['board'] }); // this window opens 'board' and nothing else
win.webContents.once('did-finish-load', () => win.webContents.postMessage('syncom:engine', null, [port2]));
await win.loadFile('index.html');
// #endregion main

// #region preload
// preload.mjs: hands the port from the main process to the page
import { ipcRenderer } from 'electron';

ipcRenderer.on('syncom:engine', (event) => window.postMessage('syncom:engine', '*', event.ports));
// #endregion preload

// #region renderer
// renderer.js: the database lives in the window, its storage in the main process
import { createDatabase } from '@alexify/syncom/all';
import { connectEngine } from '@alexify/syncom/engines';

const port = await new Promise((resolve) => {
  window.addEventListener('message', (event) => {
    if (event.source === window && event.data === 'syncom:engine') resolve(event.ports[0]);
  });
});
const board = await createDatabase({ path: 'board', engine: await connectEngine(port) });
await board.insert({ title: 'Written in the window, stored by the main process' });
// #endregion renderer

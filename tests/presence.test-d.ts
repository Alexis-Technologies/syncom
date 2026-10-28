import { expectError, expectType } from 'tsd';
import type { Storage } from '../index.js';
import type { SyncManager } from '../src/sync/sync.js';
import { createPresence, Presence, isEntry, sized, MAX_AHEAD } from '../src/presence/presence.js';
import type { PresenceUpdate, PresenceApplied } from '../src/presence/presence.js';

declare const storage: Storage & { sync: SyncManager };
const presence = createPresence(storage, { scope: 'Doc', timeout: 10_000 });
expectType<Presence>(presence);
expectType<Promise<PresenceUpdate>>(presence.set({ name: 'ada', cursor: 3 }));
expectType<Promise<PresenceUpdate>>(presence.delete());
expectType<Record<string, unknown> | null>(presence.local);
expectType<Record<string, unknown> | undefined>(presence.get('node'));
expectType<Map<string, Record<string, unknown>>>(presence.states());
expectType<PresenceUpdate>(presence.encode());
expectType<Promise<PresenceApplied>>(presence.apply({ p: 1, scope: 'Doc', s: [] }, { from: 'node' }));
presence.on('change', ({ added, removed }) => {
  expectType<string[]>(added);
  expectType<string[]>(removed);
});
presence.on('update', (update) => expectType<PresenceUpdate>(update));
expectType<() => void>(storage.sync.presence(presence));
expectError(createPresence(storage, { timeout: 'long' }));
expectType<boolean>(isEntry(['node', 1, 1, null]));
expectType<boolean>(sized({ name: 'ada' }));
expectType<60000>(MAX_AHEAD);

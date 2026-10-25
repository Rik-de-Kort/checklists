// Two-way sync with the server: push everything local, then pull back the checklists we hold.
import * as store from './store.ts';
import { now } from './time.ts';
import { parseRecords } from './validate.ts';
import type { Records } from './types.ts';

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(new URL(path, location.href), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText} ${await res.text()}`.trim());
  return res.json();
}

export async function sync(): Promise<void> {
  // Changes stamped before this are in the snapshot we push; later ones (made while the
  // request is in flight) are not, and must still count as unsynced for undo.
  const snapshotAt = now();
  const local = store.exportData();
  await post('api/push', local);
  const remote = parseRecords(await post('api/pull', { ids: local.checklists.map((c) => c.id) }));
  // Don't resurrect checklists deleted locally while the request was in flight.
  const kept: Records = { checklists: remote.checklists.filter((c) => store.getChecklist(c.id)), items: remote.items };
  store.merge(kept);
  store.setSyncedThrough(snapshotAt);
  store.save();
}

// Fetch checklists this device doesn't have yet (e.g. from a shared link).
// Resolves to true if at least one was found on the server.
export async function pull(ids: string[]): Promise<boolean> {
  const remote = parseRecords(await post('api/pull', { ids }));
  if (store.merge(remote)) store.save();
  return remote.checklists.length > 0;
}

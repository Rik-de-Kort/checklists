// Two-way sync with the server: push everything local, then pull back the checklists we hold.
import * as store from './store.js';

async function post(path, body) {
  const res = await fetch(new URL(path, location.href), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export async function sync() {
  const local = store.exportData();
  await post('api/push', local);
  const remote = await post('api/pull', { ids: local.checklists.map((c) => c.id) });
  // Don't resurrect checklists deleted locally while the request was in flight.
  remote.checklists = remote.checklists.filter((c) => store.getChecklist(c.id));
  store.merge(remote);
  store.setLastSync(Date.now());
  store.save();
}

// Fetch checklists this device doesn't have yet (e.g. from a shared link).
// Resolves to true if at least one was found on the server.
export async function pull(ids) {
  const remote = await post('api/pull', { ids });
  if (store.merge(remote)) store.save();
  return remote.checklists.length > 0;
}

// Local data store: the whole database is one JSON blob in localStorage.
export const KEY = 'checklist-db';

const listeners = new Set();
let db = load();
let lastTs = 0;

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && d.checklists && d.items) return d;
  } catch {}
  return { checklists: {}, items: {}, lastSync: 0 };
}

function notify() {
  listeners.forEach((fn) => fn());
}

export function save() {
  localStorage.setItem(KEY, JSON.stringify(db));
  notify();
}

// Re-read after another tab changed the data.
export function reload() {
  db = load();
  notify();
}

export function subscribe(fn) {
  listeners.add(fn);
}

// Strictly increasing, so records created in one burst (e.g. a clone) keep their order,
// and never behind a timestamp we've seen from another device (keeps last-writer-wins sane).
export function now() {
  lastTs = Math.max(Date.now(), lastTs + 1);
  return lastTs;
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // randomUUID needs a secure context; fall back for plain-http LAN use.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const getChecklist = (id) => db.checklists[id];
export const getItem = (id) => db.items[id];

export function putChecklist(c) {
  db.checklists[c.id] = c;
}

export function putItem(i) {
  db.items[i.id] = i;
}

export function itemsFor(checklistId) {
  return Object.values(db.items)
    .filter((i) => i.checklist_id === checklistId && !i.deleted)
    .sort((a, b) => a.created_at - b.created_at);
}

// Checklists ordered by most recent item, falling back to the checklist's own creation time.
export function listChecklists() {
  const stats = {};
  for (const i of Object.values(db.items)) {
    if (i.deleted) continue;
    const s = (stats[i.checklist_id] ??= { last: null, total: 0, done: 0 });
    s.total++;
    if (i.status === 'checked') s.done++;
    if (!s.last || i.created_at > s.last.created_at) s.last = i;
  }
  return Object.values(db.checklists)
    .map((checklist) => {
      const s = stats[checklist.id] ?? { last: null, total: 0, done: 0 };
      return { checklist, ...s, activity: s.last ? s.last.created_at : checklist.created_at };
    })
    .sort((a, b) => b.activity - a.activity);
}

// Local-only delete: drops the checklist and its items from this device, leaves no tombstone.
export function removeChecklistLocal(id) {
  const snapshot = {
    checklist: db.checklists[id],
    items: Object.values(db.items).filter((i) => i.checklist_id === id),
  };
  delete db.checklists[id];
  for (const i of snapshot.items) delete db.items[i.id];
  return snapshot;
}

export function restoreChecklist({ checklist, items }) {
  if (!checklist) return;
  db.checklists[checklist.id] = checklist;
  for (const i of items) db.items[i.id] = i;
}

export function exportData() {
  return { checklists: Object.values(db.checklists), items: Object.values(db.items) };
}

// Last-writer-wins merge of remote/imported records. Items are only accepted for
// checklists present locally (after merging the incoming checklists).
export function merge(data) {
  let changed = false;
  for (const c of arr(data.checklists)) changed = mergeRecord(db.checklists, c) || changed;
  for (const i of arr(data.items)) {
    if (db.checklists[i.checklist_id]) changed = mergeRecord(db.items, i) || changed;
  }
  return changed;
}

function arr(x) {
  if (x == null) return [];
  if (!Array.isArray(x)) throw new Error('expected a list of records');
  return x;
}

function mergeRecord(table, rec) {
  lastTs = Math.max(lastTs, rec.updated_at);
  const cur = table[rec.id];
  if (cur && cur.updated_at >= rec.updated_at) return false;
  table[rec.id] = rec;
  return true;
}

export function setLastSync(ts) {
  db.lastSync = ts;
}

// Local data store: the whole database is one JSON blob in localStorage.
import { observe } from "./time.ts";
import { message } from "./errors.ts";
import { parseDb, placed } from "./validate.ts";
import type {
  Checklist,
  Db,
  EpochMs,
  Item,
  Records,
  Snapshot,
} from "./types.ts";

export const KEY = "checklist-db";
export const CORRUPT_KEY = `${KEY}-corrupt`;

export interface ChecklistSummary {
  checklist: Checklist;
  last: Item | null;
  total: number;
  done: number;
  activity: EpochMs;
}

const listeners = new Set<() => void>();
let db: Db | null = null;
let recording: Snapshot | null = null;

function emptyDb(): Db {
  return {
    checklists: {},
    items: {},
    syncedThrough: 0 as EpochMs,
    listOrder: [],
  };
}

// Unreadable data is never replaced by an empty database: we keep a copy and refuse to start,
// because the next save would otherwise overwrite it.
function load(): Db {
  const raw = localStorage.getItem(KEY);
  if (raw === null) return emptyDb();
  try {
    return parseDb(JSON.parse(raw));
  } catch (e) {
    if (localStorage.getItem(CORRUPT_KEY) === null) {
      localStorage.setItem(CORRUPT_KEY, raw);
    }
    throw new Error(
      `Stored checklists are unreadable (${
        message(e)
      }). A copy was kept in localStorage["${CORRUPT_KEY}"].`,
      { cause: e },
    );
  }
}

function data(): Db {
  if (!db) throw new Error("store.init() has not been called");
  return db;
}

function notify(): void {
  listeners.forEach((fn) => fn());
}

export function init(): void {
  db = load();
  for (
    const rec of [...Object.values(db.checklists), ...Object.values(db.items)]
  ) observe(rec.updated_at);
}

export function save(): void {
  persist();
  notify();
}

// Write to storage without re-rendering, for bookkeeping nobody sees (e.g. syncedThrough).
export function persist(): void {
  localStorage.setItem(KEY, JSON.stringify(data()));
}

// Re-read from storage, e.g. after another tab changed the data or a save failed.
export function reload(): void {
  init();
  notify();
}

export function subscribe(fn: () => void): void {
  listeners.add(fn);
}

export function uuid(): string {
  // randomUUID only exists in secure contexts (https, localhost); fall back for plain-http LAN use.
  if (globalThis.isSecureContext !== false) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

export const getChecklist = (id: string): Checklist | undefined =>
  data().checklists[id];
export const getItem = (id: string): Item | undefined => data().items[id];

// ---------- writes (tracked while recording) ----------

/** Runs fn and returns the state of every record it wrote, before and after. */
export function record(fn: () => void): { before: Snapshot; after: Snapshot } {
  if (recording) throw new Error("store.record() calls cannot be nested");
  recording = { checklists: {}, items: {} };
  try {
    fn();
    const before = recording;
    const after: Snapshot = { checklists: {}, items: {} };
    for (const id of Object.keys(before.checklists)) {
      after.checklists[id] = getChecklist(id) ?? null;
    }
    for (const id of Object.keys(before.items)) {
      after.items[id] = getItem(id) ?? null;
    }
    if (before.listOrder) after.listOrder = data().listOrder;
    return { before, after };
  } finally {
    recording = null;
  }
}

function trackChecklist(id: string): void {
  if (recording && !(id in recording.checklists)) {
    recording.checklists[id] = getChecklist(id) ?? null;
  }
}

function trackItem(id: string): void {
  if (recording && !(id in recording.items)) {
    recording.items[id] = getItem(id) ?? null;
  }
}

export function setListOrder(ids: string[]): void {
  if (recording && !recording.listOrder) {
    recording.listOrder = data().listOrder;
  }
  data().listOrder = ids;
}

export function putChecklist(c: Checklist): void {
  trackChecklist(c.id);
  data().checklists[c.id] = c;
}

export function putItem(i: Item): void {
  trackItem(i.id);
  data().items[i.id] = i;
}

export function deleteItemRecord(id: string): void {
  trackItem(id);
  delete data().items[id];
}

// Local-only delete: drops the checklist and its items from this device, leaves no tombstone.
export function removeChecklistLocal(id: string): void {
  trackChecklist(id);
  delete data().checklists[id];
  if (data().listOrder.includes(id)) {
    setListOrder(data().listOrder.filter((other) => other !== id));
  }
  for (const i of Object.values(data().items)) {
    if (i.checklist_id === id) deleteItemRecord(i.id);
  }
}

// ---------- queries ----------

// Ordered by position. Two devices can give items the same position (both adding one at the end
// while offline), so ties go by creation, then id, for every device to show the same order.
export function itemsFor(checklistId: string): Item[] {
  return Object.values(data().items)
    .filter((i) => i.checklist_id === checklistId && !i.deleted)
    .sort((a, b) =>
      compare(a.position, b.position) || a.created_at - b.created_at ||
      compare(a.id, b.id)
    );
}

// Plain code-unit order, which is what positions are designed for (localeCompare isn't).
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Checklists in the order they were dragged into. Those not placed yet, which is all of them until
// the first drag, go first, by most recent item or else the checklist's own creation time.
export function listChecklists(): ChecklistSummary[] {
  const stats: Record<
    string,
    { last: Item | null; total: number; done: number }
  > = {};
  for (const i of Object.values(data().items)) {
    if (i.deleted) continue;
    const s = (stats[i.checklist_id] ??= { last: null, total: 0, done: 0 });
    s.total++;
    if (i.status === "checked") s.done++;
    if (!s.last || i.created_at > s.last.created_at) s.last = i;
  }
  const rank = new Map(data().listOrder.map((id, i) => [id, i]));
  const rankOf = (id: string) => rank.get(id) ?? -1;
  return Object.values(data().checklists)
    .map((checklist) => {
      const s = stats[checklist.id] ?? { last: null, total: 0, done: 0 };
      return {
        checklist,
        ...s,
        activity: s.last ? s.last.created_at : checklist.created_at,
      };
    })
    .sort((a, b) =>
      rankOf(a.checklist.id) - rankOf(b.checklist.id) ||
      b.activity - a.activity
    );
}

// ---------- sync / export ----------

export function exportData(): Records {
  return {
    checklists: Object.values(data().checklists),
    items: Object.values(data().items),
  };
}

// Last-writer-wins merge of remote/imported records. Items are only accepted for
// checklists present locally (after merging the incoming checklists).
export function merge(incoming: Records): boolean {
  let changed = false;
  for (const c of incoming.checklists) {
    changed = mergeRecord(data().checklists, c) || changed;
  }
  for (const i of incoming.items) {
    if (data().checklists[i.checklist_id]) {
      changed = mergeRecord(data().items, placed(i)) || changed;
    }
  }
  return changed;
}

function mergeRecord<T extends Checklist | Item>(
  table: Record<string, T>,
  rec: T,
): boolean {
  observe(rec.updated_at);
  const cur = table[rec.id];
  if (cur && cur.updated_at >= rec.updated_at) return false;
  table[rec.id] = rec;
  return true;
}

export const syncedThrough = (): EpochMs => data().syncedThrough;

export function setSyncedThrough(ts: EpochMs): void {
  data().syncedThrough = ts;
}

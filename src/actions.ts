// Action stack: every user change goes through dispatch() and can be undone.
// dispatch() records every record an action writes, before and after. Undoing a change that
// hasn't been synced yet puts those records back exactly as they were; undoing a synced
// change writes a new change (fresh updated_at, tombstones) so it propagates like any other.
import * as store from "./store.ts";
import { now } from "./time.ts";
import type { Checklist, EpochMs, Item, Snapshot } from "./types.ts";

const KEY = "checklist-undo";
const MAX = 100;

export type ActionInput =
  | { type: "createChecklist"; id: string; name: string }
  | { type: "renameChecklist"; id: string; name: string }
  | { type: "deleteChecklist"; id: string }
  | { type: "cloneChecklist"; sourceId: string; id: string }
  | { type: "addItem"; id: string; checklistId: string; label: string }
  | { type: "editItem"; id: string; label: string }
  | { type: "toggleItem"; id: string }
  | { type: "deleteItem"; id: string };

export type Action = ActionInput & {
  at: EpochMs;
  before: Snapshot;
  after: Snapshot;
};

type Handlers = {
  [T in ActionInput["type"]]: {
    label: string;
    do(a: Extract<ActionInput, { type: T }>): void;
  };
};

let stack: Action[] = [];

export function init(): void {
  stack = loadStack();
}

function loadStack(): Action[] {
  const raw = sessionStorage.getItem(KEY);
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isAction)) {
    throw new Error(`Undo history in sessionStorage["${KEY}"] is unreadable`);
  }
  return parsed;
}

function isAction(x: unknown): x is Action {
  return typeof x === "object" && x !== null &&
    "type" in x && typeof x.type === "string" && x.type in handlers &&
    "at" in x && typeof x.at === "number" &&
    "before" in x && "after" in x;
}

function persist(): void {
  sessionStorage.setItem(KEY, JSON.stringify(stack));
}

function found<T>(rec: T | undefined, what: string): T {
  if (rec === undefined) throw new Error(`${what} not found`);
  return rec;
}

function changed<T extends Checklist | Item>(rec: T, fields: Partial<T>): T {
  return { ...rec, ...fields, updated_at: now() };
}

function newItem(
  checklistId: string,
  label: string,
  id: string = store.uuid(),
): Item {
  const t = now();
  return {
    id,
    checklist_id: checklistId,
    label,
    status: "unchecked",
    created_at: t,
    updated_at: t,
    deleted: false,
  };
}

const handlers: Handlers = {
  createChecklist: {
    label: "Checklist created",
    do(a) {
      const t = now();
      store.putChecklist({
        id: a.id,
        name: a.name,
        created_at: t,
        updated_at: t,
      });
    },
  },
  renameChecklist: {
    label: "Checklist renamed",
    do(a) {
      store.putChecklist(
        changed(found(store.getChecklist(a.id), `Checklist ${a.id}`), {
          name: a.name,
        }),
      );
    },
  },
  deleteChecklist: {
    label: "Checklist deleted",
    do(a) {
      store.removeChecklistLocal(a.id);
    },
  },
  cloneChecklist: {
    label: "Checklist cloned",
    do(a) {
      const src = found(
        store.getChecklist(a.sourceId),
        `Checklist ${a.sourceId}`,
      );
      const t = now();
      store.putChecklist({
        id: a.id,
        name: `${src.name} (copy)`,
        created_at: t,
        updated_at: t,
      });
      for (const i of store.itemsFor(a.sourceId)) {
        store.putItem(newItem(a.id, i.label));
      }
    },
  },
  addItem: {
    label: "Item added",
    do(a) {
      store.putItem(newItem(a.checklistId, a.label, a.id));
    },
  },
  editItem: {
    label: "Item edited",
    do(a) {
      store.putItem(
        changed(found(store.getItem(a.id), `Item ${a.id}`), { label: a.label }),
      );
    },
  },
  toggleItem: {
    label: "Item toggled",
    do(a) {
      const i = found(store.getItem(a.id), `Item ${a.id}`);
      store.putItem(
        changed(i, {
          status: i.status === "checked" ? "unchecked" : "checked",
        }),
      );
    },
  },
  deleteItem: {
    label: "Item deleted",
    do(a) {
      store.putItem(
        changed(found(store.getItem(a.id), `Item ${a.id}`), { deleted: true }),
      );
    },
  },
};

function run(a: ActionInput): void {
  // TypeScript can't correlate handlers[a.type] with a's narrowed type; the mapped type guarantees it.
  (handlers[a.type].do as (a: ActionInput) => void)(a);
}

export function dispatch(input: ActionInput): void {
  const at = now();
  let snapshots;
  try {
    snapshots = store.record(() => run(input));
  } catch (e) {
    store.reload(); // drop any half-applied writes
    throw e;
  }
  stack.push({ ...input, at, ...snapshots });
  try {
    store.save();
  } catch (e) {
    stack.pop();
    store.reload();
    throw e;
  }
  if (stack.length > MAX) stack.shift();
  persist();
}

/** Undoes the newest action. Returns it, and whether it was reverted locally (it hadn't synced yet). */
export function undo(): { action: Action; local: boolean } | null {
  const action = stack.pop();
  if (!action) return null;
  const local = action.at > store.syncedThrough();
  try {
    revert(action, local);
  } catch (e) {
    stack.push(action);
    store.reload();
    throw e;
  }
  persist();
  store.save();
  return { action, local };
}

function same(
  cur: Checklist | Item | null,
  after: Checklist | Item | null,
): boolean {
  return cur === null || after === null
    ? cur === after
    : cur.updated_at === after.updated_at;
}

// Put back the fields the action changed, leaving fields changed elsewhere (e.g. by a sync) alone.
function restoreFields<T extends Checklist | Item>(
  cur: T,
  prev: T,
  after: T | null,
): T {
  const out: Record<string, unknown> = { ...cur };
  for (const k of Object.keys(prev) as (keyof T & string)[]) {
    if (k !== "updated_at" && (after === null || prev[k] !== after[k])) {
      out[k] = prev[k];
    }
  }
  out["updated_at"] = now();
  return out as unknown as T;
}

function revert(a: Action, unsynced: boolean): void {
  for (const [id, prev] of Object.entries(a.before.checklists)) {
    const after = a.after.checklists[id] ?? null;
    const cur = store.getChecklist(id) ?? null;
    if (unsynced && same(cur, after)) {
      if (prev) store.putChecklist(prev);
      else store.removeChecklistLocal(id);
    } else if (prev === null) {
      store.removeChecklistLocal(id); // creating a checklist is only ever undone locally…
    } else if (cur === null) {
      store.putChecklist(prev); // …and so is deleting one
    } else {
      store.putChecklist(restoreFields(cur, prev, after));
    }
  }
  for (const [id, prev] of Object.entries(a.before.items)) {
    const after = a.after.items[id] ?? null;
    const cur = store.getItem(id) ?? null;
    if (unsynced && same(cur, after)) {
      if (prev) store.putItem(prev);
      else store.deleteItemRecord(id);
    } else if (prev === null) {
      if (cur) store.putItem(changed(cur, { deleted: true }));
    } else if (cur === null) {
      if (store.getChecklist(prev.checklist_id)) store.putItem(prev);
    } else {
      store.putItem(restoreFields(cur, prev, after));
    }
  }
}

export const canUndo = (): boolean => stack.length > 0;
export const describe = (action: Action): string => handlers[action.type].label;

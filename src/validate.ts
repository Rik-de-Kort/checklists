// Shape checks for data crossing a boundary (storage, import, network). They throw instead of guessing.
import type { Checklist, Db, EpochMs, Item, Records } from "./types.ts";

type Obj = Record<string, unknown>;

/** Checklist IDs are five lowercase words (see words.ts), e.g. "tiger-lamp-ocean-plum-hat". */
export const CHECKLIST_ID = /^[a-z]+(?:-[a-z]+){4}$/;

function fail(what: string, value: unknown): never {
  const shown = JSON.stringify(value) ?? String(value);
  throw new Error(
    `Invalid ${what}: ${
      shown.length > 200 ? `${shown.slice(0, 200)}…` : shown
    }`,
  );
}

function obj(x: unknown, what: string): Obj {
  if (typeof x !== "object" || x === null || Array.isArray(x)) fail(what, x);
  return x as Obj;
}

function str(o: Obj, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== "string") fail(`${what}.${key}`, v);
  return v;
}

function checklistId(o: Obj, key: string, what: string): string {
  const v = str(o, key, what);
  if (!CHECKLIST_ID.test(v)) fail(`${what}.${key}`, v);
  return v;
}

function ms(o: Obj, key: string, what: string): EpochMs {
  const v = o[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    fail(`${what}.${key}`, v);
  }
  return v as EpochMs;
}

function list(x: unknown, what: string): unknown[] {
  if (x === undefined) return [];
  if (!Array.isArray(x)) fail(what, x);
  return x;
}

export function parseChecklist(x: unknown): Checklist {
  const o = obj(x, "checklist");
  return {
    id: checklistId(o, "id", "checklist"),
    name: str(o, "name", "checklist"),
    created_at: ms(o, "created_at", "checklist"),
    updated_at: ms(o, "updated_at", "checklist"),
  };
}

export function parseItem(x: unknown): Item {
  const o = obj(x, "item");
  const status = o["status"];
  if (status !== "checked" && status !== "unchecked") {
    fail("item.status", status);
  }
  const deleted = o["deleted"] ?? false;
  if (typeof deleted !== "boolean") fail("item.deleted", deleted);
  return {
    id: str(o, "id", "item"),
    checklist_id: checklistId(o, "checklist_id", "item"),
    label: str(o, "label", "item"),
    status,
    created_at: ms(o, "created_at", "item"),
    updated_at: ms(o, "updated_at", "item"),
    deleted,
  };
}

export function parseRecords(x: unknown): Records {
  const o = obj(x, "records");
  return {
    checklists: list(o["checklists"], "checklists").map(parseChecklist),
    items: list(o["items"], "items").map(parseItem),
  };
}

export function parseDb(x: unknown): Db {
  const o = obj(x, "database");
  const checklists: Db["checklists"] = {};
  for (
    const c of Object.values(obj(o["checklists"], "database.checklists")).map(
      parseChecklist,
    )
  ) checklists[c.id] = c;
  const items: Db["items"] = {};
  for (
    const i of Object.values(obj(o["items"], "database.items")).map(parseItem)
  ) items[i.id] = i;
  // Data from before syncedThrough existed counts as never synced.
  const syncedThrough = o["syncedThrough"] === undefined
    ? (0 as EpochMs)
    : ms(o, "syncedThrough", "database");
  return { checklists, items, syncedThrough };
}

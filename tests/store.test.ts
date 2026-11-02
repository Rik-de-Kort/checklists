import assert from "node:assert/strict";
import * as store from "../src/store.ts";
import { dispatch } from "../src/actions.ts";
import { now } from "../src/time.ts";
import { parseRecords } from "../src/validate.ts";
import { keyFromTime } from "../src/order.ts";
import type { EpochMs } from "../src/types.ts";
import { fresh, freshStorage, item, seed } from "./helpers.ts";

Deno.test("missing storage starts empty", () => {
  fresh();
  assert.deepEqual(store.exportData(), { checklists: [], items: [] });
});

Deno.test("unreadable storage throws, keeps a copy, and is never overwritten", () => {
  const { local } = freshStorage();
  local.setItem(store.KEY, '{"checklists": {}, "items": {"x": {"id": "x"}}}');
  assert.throws(() => store.init(), /unreadable.*checklist-db-corrupt/);
  assert.equal(
    local.getItem(store.CORRUPT_KEY),
    '{"checklists": {}, "items": {"x": {"id": "x"}}}',
  );
  local.setItem(store.KEY, "not json");
  assert.throws(() => store.init(), /unreadable/);
  assert.equal(local.getItem(store.KEY), "not json");
});

Deno.test("data saved before syncedThrough existed still loads", () => {
  const { local } = freshStorage();
  local.setItem(
    store.KEY,
    JSON.stringify({ checklists: {}, items: {}, lastSync: 5 }),
  );
  store.init();
  assert.equal(store.syncedThrough(), 0);
});

Deno.test("merge keeps the newer copy of each record and ignores orphans", () => {
  fresh();
  const { itemIds: [eggs] } = seed(["eggs"]);
  assert.ok(eggs);
  const local = item(eggs);
  store.merge({
    checklists: [],
    items: [{
      ...local,
      label: "stale",
      updated_at: (local.updated_at - 1) as typeof local.updated_at,
    }],
  });
  assert.equal(item(eggs).label, "eggs");
  const ahead = (local.updated_at + 1_000_000) as typeof local.updated_at;
  store.merge({
    checklists: [],
    items: [{ ...local, label: "newer", updated_at: ahead }],
  });
  assert.equal(item(eggs).label, "newer");
  dispatch({ type: "editItem", id: eggs, label: "mine" });
  assert.ok(
    item(eggs).updated_at > ahead,
    "our clock jumps past a fast remote clock",
  );
  store.merge({
    checklists: [],
    items: [{ ...local, id: "orphan", checklist_id: "not-in-this-list-here" }],
  });
  assert.equal(store.getItem("orphan"), undefined);
});

Deno.test("incoming records are validated", () => {
  assert.throws(
    () =>
      parseRecords({
        items: [{
          id: "a",
          checklist_id: "tiger-lamp-ocean-plum-hat",
          label: "x",
          status: "maybe",
          created_at: 1,
          updated_at: 1,
        }],
      }),
    /item\.status/,
  );
  assert.throws(
    () =>
      parseRecords({
        checklists: [{
          id: "tiger-lamp-ocean-plum-hat",
          name: "x",
          created_at: "2026-01-01",
          updated_at: 1,
        }],
      }),
    /checklist\.created_at/,
  );
  for (
    const id of ["c1", "Tiger-lamp-ocean-plum-hat", "tiger-lamp-ocean-plum"]
  ) {
    assert.throws(
      () =>
        parseRecords({
          checklists: [{ id, name: "x", created_at: 1, updated_at: 1 }],
        }),
      /checklist\.id/,
      id,
    );
  }
  assert.throws(() => parseRecords({ checklists: "nope" }), /checklists/);
  assert.deepEqual(parseRecords({}), { checklists: [], items: [] });
});

Deno.test("now() is strictly increasing", () => {
  const a = now();
  const b = now();
  assert.ok(b > a);
});

Deno.test("items saved before positions keep their order, and new ones go after them", () => {
  const { local } = freshStorage();
  const id = "tiger-lamp-ocean-plum-hat";
  const old = (label: string, created_at: number) => ({
    id: label,
    checklist_id: id,
    label,
    status: "unchecked",
    created_at,
    updated_at: created_at,
    deleted: false,
  });
  local.setItem(
    store.KEY,
    JSON.stringify({
      checklists: { [id]: { id, name: "x", created_at: 1, updated_at: 1 } },
      items: { b: old("b", 20), a: old("a", 10), c: old("c", 30) },
    }),
  );
  store.init();
  assert.deepEqual(store.itemsFor(id).map((i) => i.label), ["a", "b", "c"]);
  assert.equal(item("a").position, keyFromTime(10 as EpochMs));
  dispatch({ type: "addItem", id: "d", checklistId: id, label: "d" });
  assert.deepEqual(store.itemsFor(id).map((i) => i.label), [
    "a",
    "b",
    "c",
    "d",
  ]);
});

Deno.test("items are ordered by position, then creation, then id", () => {
  fresh();
  const { checklistId } = seed([]);
  const at = (position: string | null, created_at: number, id: string) => ({
    id,
    checklist_id: checklistId,
    label: id,
    status: "unchecked" as const,
    created_at: created_at as EpochMs,
    updated_at: created_at as EpochMs,
    deleted: false,
    position,
  });
  store.merge({
    checklists: [],
    items: [
      at("a1", 5, "x"),
      at("a0", 9, "w"),
      at("a1", 2, "z"),
      at("a1", 2, "y"),
      at(null, 3, "v"), // from an app version before positions
    ],
  });
  assert.deepEqual(store.itemsFor(checklistId).map((i) => i.id), [
    "w",
    "y",
    "z",
    "x",
    "v",
  ]);
  assert.equal(item("v").position, keyFromTime(3 as EpochMs));
  assert.ok(
    !store.merge({ checklists: [], items: [at(null, 3, "v")] }),
    "the server's copy without a position is the same item",
  );
});

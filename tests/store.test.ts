import assert from "node:assert/strict";
import * as store from "../src/store.ts";
import { dispatch } from "../src/actions.ts";
import { now } from "../src/time.ts";
import { parseRecords } from "../src/validate.ts";
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
    items: [{ ...local, id: "orphan", checklist_id: "nowhere" }],
  });
  assert.equal(store.getItem("orphan"), undefined);
});

Deno.test("incoming records are validated", () => {
  assert.throws(
    () =>
      parseRecords({
        items: [{
          id: "a",
          checklist_id: "c",
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
          id: "c",
          name: "x",
          created_at: "2026-01-01",
          updated_at: 1,
        }],
      }),
    /checklist\.created_at/,
  );
  assert.throws(() => parseRecords({ checklists: "nope" }), /checklists/);
  assert.deepEqual(parseRecords({}), { checklists: [], items: [] });
});

Deno.test("now() is strictly increasing", () => {
  const a = now();
  const b = now();
  assert.ok(b > a);
});

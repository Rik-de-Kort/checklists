import assert from "node:assert/strict";
import * as store from "../src/store.ts";
import { dispatch, undo } from "../src/actions.ts";
import { pull, push } from "../src/sync.ts";
import { fresh, item, seed } from "./helpers.ts";

Object.defineProperty(globalThis, "location", {
  value: new URL("http://checklist.test/"),
  configurable: true,
});

/** Fakes the server; `onPush` runs while the push request is "in flight". */
function fakeServer(onPush: () => void = () => {}): void {
  globalThis.fetch = (input, init) =>
    Promise.try(() => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/push") {
        onPush();
        return Response.json({ ok: true });
      }
      if (path === "/api/pull") {
        const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
        const data = store.exportData();
        return Response.json({
          checklists: data.checklists.filter((c) => ids.includes(c.id)),
          items: data.items.filter((i) => ids.includes(i.checklist_id)),
        });
      }
      return new Response("not found", { status: 404 });
    });
}

Deno.test("changes made before a push are undone as synced changes", async () => {
  fresh();
  const { itemIds: [milk] } = seed(["milk"]);
  assert.ok(milk);
  fakeServer();
  await push();
  assert.equal(undo()?.local, false);
  assert.equal(item(milk).deleted, true);
});

Deno.test("a change made while a push is in flight still counts as unsynced", async () => {
  fresh();
  const { itemIds: [milk] } = seed(["milk"]);
  assert.ok(milk);
  fakeServer(() => dispatch({ type: "toggleItem", id: milk }));
  await push();
  assert.equal(item(milk).status, "checked");
  assert.equal(undo()?.local, true);
  assert.equal(item(milk).status, "unchecked");
});

Deno.test("a pull that brings nothing new doesn't re-render or write", async () => {
  fresh();
  seed(["milk"]);
  fakeServer();
  await push();
  let renders = 0;
  store.subscribe(() => renders++);
  const setItem = localStorage.setItem;
  let writes = 0;
  localStorage.setItem = (k, v) => {
    writes++;
    setItem.call(localStorage, k, v);
  };
  try {
    await pull();
  } finally {
    localStorage.setItem = setItem;
  }
  assert.equal(renders, 0);
  assert.equal(writes, 0);
});

Deno.test("a failed push leaves everything unsynced and reports the error", async () => {
  fresh();
  seed(["milk"]);
  globalThis.fetch = () =>
    Promise.resolve(
      new Response('{"error": "db locked"}', {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );
  await assert.rejects(
    push(),
    /api\/push: 500 Internal Server Error \{"error": "db locked"\}/,
  );
  assert.equal(store.syncedThrough(), 0);
  assert.equal(undo()?.local, true);
});

Deno.test("a pull doesn't mark anything as pushed", async () => {
  fresh();
  seed(["milk"]);
  fakeServer();
  await pull();
  assert.equal(store.syncedThrough(), 0);
  assert.equal(undo()?.local, true);
});

Deno.test("a pull doesn't resurrect a checklist deleted while it was in flight", async () => {
  fresh();
  const { checklistId } = seed(["milk"]);
  const data = store.exportData();
  globalThis.fetch = () => {
    store.removeChecklistLocal(checklistId);
    return Promise.resolve(Response.json(data));
  };
  await pull();
  assert.equal(store.getChecklist(checklistId), undefined);
});

Deno.test("a pull fetches a checklist this device doesn't have yet", async () => {
  fresh();
  const { checklistId } = seed(["milk"]);
  const data = store.exportData();
  store.removeChecklistLocal(checklistId);
  globalThis.fetch = () => Promise.resolve(Response.json(data));
  assert.equal(await pull([checklistId]), true);
  assert.ok(store.getChecklist(checklistId));
});

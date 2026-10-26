import assert from "node:assert/strict";
import { openDb, serve } from "../server/server.ts";
import * as store from "../src/store.ts";
import { dispatch } from "../src/actions.ts";
import { pull, sync } from "../src/sync.ts";
import { fresh, item, seed } from "./helpers.ts";

let server: Deno.HttpServer<Deno.NetAddr>;
let base: string;

Deno.test.beforeAll(() => {
  server = serve(openDb(":memory:"), {
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  });
  base = `http://127.0.0.1:${server.addr.port}`;
  Object.defineProperty(globalThis, "location", {
    value: new URL(`${base}/`),
    configurable: true,
  });
});

Deno.test.afterAll(() => server.shutdown());

const post = (path: string, body: string) =>
  fetch(base + path, { method: "POST", body });

const checklist = {
  id: "tiger-lamp-ocean-plum-hat",
  name: "Groceries",
  created_at: 1,
  updated_at: 10,
};
const milk = {
  id: "i1",
  checklist_id: "tiger-lamp-ocean-plum-hat",
  label: "milk",
  status: "unchecked",
  created_at: 1,
  updated_at: 10,
  deleted: false,
};

Deno.test("push then pull returns the records; older writes lose", async () => {
  assert.equal(
    (await post(
      "/api/push",
      JSON.stringify({ checklists: [checklist], items: [milk] }),
    )).status,
    200,
  );
  const stale = { ...milk, label: "stale", updated_at: 5 };
  const newer = { ...milk, deleted: true, updated_at: 20 };
  await post("/api/push", JSON.stringify({ items: [stale] }));
  let res = await (await post(
    "/api/pull",
    JSON.stringify({ ids: ["tiger-lamp-ocean-plum-hat"] }),
  ))
    .json();
  assert.deepEqual(res, { checklists: [checklist], items: [milk] });
  await post("/api/push", JSON.stringify({ items: [newer] }));
  res = await (await post(
    "/api/pull",
    JSON.stringify({ ids: ["tiger-lamp-ocean-plum-hat", "unknown"] }),
  ))
    .json();
  assert.deepEqual(res, { checklists: [checklist], items: [newer] });
});

Deno.test("bad requests get a 400 with a reason, and nothing is stored", async () => {
  const cases: [string, string, RegExp][] = [
    ["/api/push", "not json", /JSON/],
    ["/api/push", "[]", /JSON object/],
    [
      "/api/push",
      JSON.stringify({
        checklists: [{ ...checklist, id: "acid-acorn-acre-acts-afar" }],
        items: [{ ...milk, status: "maybe" }],
      }),
      /item\.status/,
    ],
    ["/api/pull", JSON.stringify({ ids: "tiger-lamp-ocean-plum-hat" }), /ids/],
  ];
  for (const [path, body, reason] of cases) {
    const res = await post(path, body);
    assert.equal(res.status, 400, body);
    assert.match(((await res.json()) as { error: string }).error, reason);
  }
  const res = await (await post(
    "/api/pull",
    JSON.stringify({ ids: ["acid-acorn-acre-acts-afar"] }),
  ))
    .json();
  assert.deepEqual(
    res,
    { checklists: [], items: [] },
    "a rejected push stores none of its records",
  );
  assert.equal((await post("/api/nope", "{}")).status, 404);
});

Deno.test("serves the app, and nothing outside public/", async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await index.text(), /<html/i);
  const js = await fetch(`${base}/js/app.js`);
  assert.equal(js.status, 200, "run deno task build first");
  assert.match(js.headers.get("content-type") ?? "", /text\/javascript/);
  assert.equal(
    (await fetch(`${base}/manifest.webmanifest`)).headers.get("content-type"),
    "application/manifest+json",
  );
  assert.equal((await fetch(`${base}/..%2Fdeno.json`)).status, 404);
  const link = await fetch(`${base}/Tiger-lamp-ocean-plum-hat`, {
    redirect: "manual",
  });
  assert.equal(link.status, 302, "share links redirect to the app's route");
  assert.equal(link.headers.get("location"), "./#/c/tiger-lamp-ocean-plum-hat");
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.equal(
    (await fetch(`${base}/3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f`)).status,
    404,
    "only word IDs are share links",
  );
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
});

Deno.test("the app syncs against the real server", async () => {
  fresh();
  const { checklistId, itemIds: [eggs] } = seed(["eggs"]);
  assert.ok(eggs);
  await sync();
  // Another device changes the item; this device's next sync picks it up.
  const remote = {
    ...item(eggs),
    status: "checked",
    updated_at: item(eggs).updated_at + 1,
  };
  await post("/api/push", JSON.stringify({ items: [remote] }));
  await sync();
  assert.equal(item(eggs).status, "checked");
  // And a change here reaches a device that only has the link.
  dispatch({ type: "editItem", id: eggs, label: "free-range eggs" });
  await sync();
  fresh();
  await pull([checklistId]);
  assert.equal(item(eggs).label, "free-range eggs");
  assert.equal(store.getChecklist(checklistId)?.name, "Groceries");
});

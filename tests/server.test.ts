import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, openDb, serve } from "../server/server.ts";
import * as store from "../src/store.ts";
import { dispatch } from "../src/actions.ts";
import { latestVersion, pull, sync } from "../src/sync.ts";
import { VERSION } from "../src/version.ts";
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
  position: null,
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
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.equal(
    (await fetch(`${base}/3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f`)).status,
    404,
    "only word IDs are share links",
  );
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
});

Deno.test("share links carry the checklist's name for link previews, and open the app", async () => {
  const id = "bless-bride-cloak-dwell-harm";
  const fish = { id, name: `Fish & "chips" <b>`, created_at: 1, updated_at: 1 };
  await (await post("/api/push", JSON.stringify({ checklists: [fish] }))).body
    ?.cancel();
  // Capitalized, as a phone might type it.
  const res = await fetch(`${base}/Bless-bride-cloak-dwell-harm`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const page = await res.text();
  const title = "Fish &#38; &#34;chips&#34; &#60;b&#62; - Seznam";
  assert.ok(page.includes(`<title>${title}</title>`), page);
  assert.ok(page.includes(`<meta property="og:title" content="${title}">`));
  assert.ok(page.includes(`content="0; url=./#/c/${id}"`), page);

  const unknown = await fetch(`${base}/acid-acorn-acre-acts-afar`);
  assert.equal(unknown.status, 200, "the app may still have it locally");
  assert.ok((await unknown.text()).includes("<title>Seznam</title>"));
});

Deno.test("opening a database from before item positions adds the column", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE items (
        id TEXT PRIMARY KEY,
        checklist_id TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO items VALUES ('i1', 'tiger-lamp-ocean-plum-hat', 'milk', 'unchecked', 1, 10, 0);
  `);
  migrate(db);
  migrate(db); // and again on the next start
  assert.deepEqual(
    { ...db.prepare("SELECT * FROM items").get() },
    { ...milk, deleted: 0 },
  );
});

Deno.test("pushes without a position, from older app versions, keep the stored one", async () => {
  const id = "plum-tiger-hat-lamp-ocean";
  const list = { ...checklist, id };
  const placed = { ...milk, id: "i2", checklist_id: id, position: "a0" };
  const pullList = async () =>
    await (await post("/api/pull", JSON.stringify({ ids: [id] }))).json();
  await post(
    "/api/push",
    JSON.stringify({ checklists: [list], items: [placed] }),
  );
  const old: Record<string, unknown> = {
    ...placed,
    status: "checked",
    updated_at: 20,
  };
  delete old["position"];
  await post("/api/push", JSON.stringify({ items: [old] }));
  assert.deepEqual(await pullList(), {
    checklists: [list],
    items: [{ ...old, position: "a0" }],
  });
  const moved = { ...placed, position: "a0V", updated_at: 30 };
  await post("/api/push", JSON.stringify({ items: [moved] }));
  assert.deepEqual(await pullList(), { checklists: [list], items: [moved] });
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

Deno.test("the app can ask which version the server has", async () => {
  const res = await fetch(`${base}/api/version`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: VERSION });
  assert.equal(await latestVersion(), VERSION);
});

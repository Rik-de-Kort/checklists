import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.ts';
import { dispatch, undo } from '../src/actions.ts';
import { sync } from '../src/sync.ts';
import { fresh, item, seed } from './helpers.ts';

Object.defineProperty(globalThis, 'location', { value: new URL('http://checklist.test/'), configurable: true });

/** Fakes the server; `onPush` runs while the push request is "in flight". */
function fakeServer(onPush: () => void = () => {}): void {
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/push') {
      onPush();
      return Response.json({ ok: true });
    }
    if (path === '/api/pull') {
      const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
      const data = store.exportData();
      return Response.json({
        checklists: data.checklists.filter((c) => ids.includes(c.id)),
        items: data.items.filter((i) => ids.includes(i.checklist_id)),
      });
    }
    return new Response('not found', { status: 404 });
  };
}

test('changes made before a sync are undone as synced changes', async () => {
  fresh();
  const { itemIds: [milk] } = seed(['milk']);
  assert.ok(milk);
  fakeServer();
  await sync();
  assert.equal(undo()?.local, false);
  assert.equal(item(milk).deleted, true);
});

test('a change made while a sync is in flight still counts as unsynced', async () => {
  fresh();
  const { itemIds: [milk] } = seed(['milk']);
  assert.ok(milk);
  fakeServer(() => dispatch({ type: 'toggleItem', id: milk }));
  await sync();
  assert.equal(item(milk).status, 'checked');
  assert.equal(undo()?.local, true);
  assert.equal(item(milk).status, 'unchecked');
});

test('a failed sync leaves everything unsynced and reports the error', async () => {
  fresh();
  seed(['milk']);
  globalThis.fetch = async () => new Response('{"error": "db locked"}', { status: 500, statusText: 'Internal Server Error' });
  await assert.rejects(sync(), /api\/push: 500 Internal Server Error \{"error": "db locked"\}/);
  assert.equal(store.syncedThrough(), 0);
  assert.equal(undo()?.local, true);
});

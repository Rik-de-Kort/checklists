import assert from 'node:assert/strict';
import * as store from '../src/store.ts';
import { dispatch, undo, canUndo } from '../src/actions.ts';
import { now } from '../src/time.ts';
import type { Item } from '../src/types.ts';
import { fresh, item, seed } from './helpers.ts';

/** Pretend everything so far has been pushed to the server. */
function markSynced(): void {
  store.setSyncedThrough(now());
}

Deno.test('items are ordered by creation, checklists by latest item', () => {
  fresh();
  const a = seed(['milk', 'eggs', 'bread']);
  const b = seed([]);
  assert.deepEqual(store.itemsFor(a.checklistId).map((i) => i.label), ['milk', 'eggs', 'bread']);
  assert.equal(store.listChecklists()[0]?.checklist.id, b.checklistId, 'empty newer list uses its own created_at');
  dispatch({ type: 'addItem', id: store.uuid(), checklistId: a.checklistId, label: 'jam' });
  assert.equal(store.listChecklists()[0]?.checklist.id, a.checklistId);
});

Deno.test('undoing an unsynced add removes the item entirely', () => {
  fresh();
  const { itemIds: [milk] } = seed(['milk']);
  assert.ok(milk);
  undo();
  assert.equal(store.getItem(milk), undefined);
});

Deno.test('undoing a synced add leaves a tombstone so the removal syncs', () => {
  fresh();
  const { itemIds: [milk] } = seed(['milk']);
  assert.ok(milk);
  markSynced();
  const before = item(milk).updated_at;
  undo();
  assert.equal(item(milk).deleted, true);
  assert.ok(item(milk).updated_at > before);
});

Deno.test('undoing an unsynced toggle restores the record exactly, timestamp included', () => {
  fresh();
  const { itemIds: [eggs] } = seed(['eggs']);
  assert.ok(eggs);
  const original: Item = item(eggs);
  dispatch({ type: 'toggleItem', id: eggs });
  assert.equal(item(eggs).status, 'checked');
  const result = undo();
  assert.equal(result?.local, true);
  assert.deepEqual(item(eggs), original);
});

Deno.test('undoing a synced toggle is a new change and keeps fields changed elsewhere', () => {
  fresh();
  const { itemIds: [eggs] } = seed(['eggs']);
  assert.ok(eggs);
  dispatch({ type: 'toggleItem', id: eggs });
  markSynced();
  // Another device renamed it and we pulled that in.
  const toggled = item(eggs);
  store.merge({ checklists: [], items: [{ ...toggled, label: 'free-range eggs', updated_at: now() }] });
  const result = undo();
  assert.equal(result?.local, false);
  assert.equal(item(eggs).status, 'unchecked');
  assert.equal(item(eggs).label, 'free-range eggs');
  assert.ok(item(eggs).updated_at > toggled.updated_at);
});

Deno.test('an unsynced action on a record changed by a later merge falls back to a synced-style undo', () => {
  fresh();
  const { itemIds: [eggs] } = seed(['eggs']);
  assert.ok(eggs);
  dispatch({ type: 'editItem', id: eggs, label: 'brown eggs' });
  store.merge({ checklists: [], items: [{ ...item(eggs), status: 'checked', updated_at: now() }] });
  undo();
  assert.equal(item(eggs).label, 'eggs');
  assert.equal(item(eggs).status, 'checked', 'the merged change survives');
});

Deno.test('delete, edit and rename undo', () => {
  fresh();
  const { checklistId, itemIds: [milk, bread] } = seed(['milk', 'bread']);
  assert.ok(milk && bread);
  dispatch({ type: 'deleteItem', id: milk });
  assert.equal(store.itemsFor(checklistId).length, 1);
  undo();
  assert.equal(store.itemsFor(checklistId).length, 2);
  dispatch({ type: 'editItem', id: bread, label: 'rye bread' });
  dispatch({ type: 'renameChecklist', id: checklistId, name: 'Shop' });
  undo();
  undo();
  assert.equal(item(bread).label, 'bread');
  assert.equal(store.getChecklist(checklistId)?.name, 'Groceries');
});

Deno.test('clone resets every item, and undoing it removes the copy locally even after a sync', () => {
  fresh();
  const { checklistId, itemIds: [, eggs] } = seed(['milk', 'eggs', 'bread']);
  assert.ok(eggs);
  dispatch({ type: 'toggleItem', id: eggs });
  const copy = store.uuid();
  dispatch({ type: 'cloneChecklist', sourceId: checklistId, id: copy });
  const copied = store.itemsFor(copy);
  assert.deepEqual(copied.map((i) => i.label), ['milk', 'eggs', 'bread']);
  assert.ok(copied.every((i) => i.status === 'unchecked'));
  assert.equal(item(eggs).status, 'checked', 'source untouched');
  markSynced();
  undo();
  assert.equal(store.getChecklist(copy), undefined);
  assert.equal(store.itemsFor(copy).length, 0);
});

Deno.test('deleting a checklist is local-only and undo restores it as it was, synced or not', () => {
  for (const synced of [false, true]) {
    fresh();
    const { checklistId, itemIds: [milk] } = seed(['milk']);
    assert.ok(milk);
    const original = item(milk);
    dispatch({ type: 'deleteChecklist', id: checklistId });
    if (synced) markSynced();
    assert.equal(store.getChecklist(checklistId), undefined);
    assert.equal(store.getItem(milk), undefined, 'no tombstone, items are just gone');
    undo();
    assert.ok(store.getChecklist(checklistId));
    assert.deepEqual(item(milk), original);
  }
});

Deno.test('a failed save rolls back memory and the undo stack', () => {
  const { local } = fresh();
  const { itemIds: [milk] } = seed(['milk']);
  assert.ok(milk);
  local.failWrites = true;
  assert.throws(() => dispatch({ type: 'toggleItem', id: milk }), /Quota/);
  assert.equal(item(milk).status, 'unchecked');
  local.failWrites = false;
  undo(); // undoes the add, not the failed toggle
  assert.equal(store.getItem(milk), undefined);
});

Deno.test('actions on missing records throw instead of doing nothing', () => {
  fresh();
  assert.throws(() => dispatch({ type: 'toggleItem', id: 'nope' }), /Item nope not found/);
  assert.equal(canUndo(), false);
});

Deno.test('the undo stack survives a reload of the same tab', async () => {
  const { session } = fresh();
  seed(['milk']);
  const actions = await import('../src/actions.ts');
  actions.init();
  assert.equal(actions.canUndo(), true);
  session.setItem('checklist-undo', '{"not": "a list"}');
  assert.throws(() => actions.init(), /unreadable/);
});

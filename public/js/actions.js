// Action stack: every user change goes through dispatch() and can be undone.
// Actions are plain objects so the stack can be persisted; each handler records
// whatever it needs to invert itself on the action object during do().
import * as store from './store.js';

const KEY = 'checklist-undo';
const MAX = 100;

let stack = loadStack();

function loadStack() {
  try {
    return JSON.parse(sessionStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

function persist() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(stack));
  } catch {}
}

function touch(rec, fields) {
  Object.assign(rec, fields, { updated_at: store.now() });
}

function newItem(checklistId, label, status = 'unchecked', id = store.uuid()) {
  const t = store.now();
  return { id, checklist_id: checklistId, label, status, created_at: t, updated_at: t, deleted: false };
}

const handlers = {
  createChecklist: {
    label: 'Checklist created',
    do(a) {
      const t = store.now();
      store.putChecklist({ id: a.id, name: a.name, created_at: t, updated_at: t });
    },
    undo(a) {
      store.removeChecklistLocal(a.id);
    },
  },
  renameChecklist: {
    label: 'Checklist renamed',
    do(a) {
      const c = store.getChecklist(a.id);
      a.prev = c.name;
      touch(c, { name: a.name });
    },
    undo(a) {
      const c = store.getChecklist(a.id);
      if (c) touch(c, { name: a.prev });
    },
  },
  deleteChecklist: {
    label: 'Checklist deleted',
    do(a) {
      a.snapshot = store.removeChecklistLocal(a.id);
    },
    undo(a) {
      store.restoreChecklist(a.snapshot);
    },
  },
  cloneChecklist: {
    label: 'Checklist cloned',
    do(a) {
      const src = store.getChecklist(a.sourceId);
      const t = store.now();
      store.putChecklist({ id: a.id, name: `${src.name} (copy)`, created_at: t, updated_at: t });
      for (const i of store.itemsFor(a.sourceId)) store.putItem(newItem(a.id, i.label));
    },
    undo(a) {
      store.removeChecklistLocal(a.id);
    },
  },
  addItem: {
    label: 'Item added',
    do(a) {
      store.putItem(newItem(a.checklistId, a.label, 'unchecked', a.id));
    },
    undo(a) {
      const i = store.getItem(a.id);
      if (i) touch(i, { deleted: true });
    },
  },
  editItem: {
    label: 'Item edited',
    do(a) {
      const i = store.getItem(a.id);
      a.prev = i.label;
      touch(i, { label: a.label });
    },
    undo(a) {
      const i = store.getItem(a.id);
      if (i) touch(i, { label: a.prev });
    },
  },
  toggleItem: {
    label: 'Item toggled',
    do(a) {
      const i = store.getItem(a.id);
      a.prev = i.status;
      touch(i, { status: i.status === 'checked' ? 'unchecked' : 'checked' });
    },
    undo(a) {
      const i = store.getItem(a.id);
      if (i) touch(i, { status: a.prev });
    },
  },
  deleteItem: {
    label: 'Item deleted',
    do(a) {
      touch(store.getItem(a.id), { deleted: true });
    },
    undo(a) {
      const i = store.getItem(a.id);
      if (i) touch(i, { deleted: false });
    },
  },
};

export function dispatch(action) {
  handlers[action.type].do(action);
  stack.push(action);
  if (stack.length > MAX) stack.shift();
  persist();
  store.save();
  return action;
}

export function undo() {
  const action = stack.pop();
  if (!action) return null;
  handlers[action.type].undo(action);
  persist();
  store.save();
  return action;
}

export const canUndo = () => stack.length > 0;
export const describe = (action) => handlers[action.type].label;

// View layer: hash router, the overview and checklist pages, and UI event handling.
// Every store change triggers a full re-render of the current page; data is small.
import * as store from './store.js';
import { dispatch, undo, canUndo, describe } from './actions.js';
import { sync, pull } from './sync.js';

const SWIPE_THRESHOLD = 80;
const LONG_PRESS_MS = 500;
const TOAST_MS = 4000;

const ICONS = {
  back: '<polyline points="15 18 9 12 15 6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  sync: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
  clone: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
};

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const importInput = document.getElementById('import-file');

let route = parseRoute();
let renderedRoute = null;
let rendering = false;
let renderQueued = false;
let editingId = null;
let pendingFocus = null; // data-key of an input to focus and select after the next render
let scrollToBottom = false;
let syncStatus = 'idle'; // 'idle' | 'busy' | 'error'
const remoteLookups = new Map(); // checklist id -> 'loading' | 'missing'
let toastTimer;

export function init() {
  store.subscribe(render);
  window.addEventListener('hashchange', () => {
    route = parseRoute();
    editingId = null;
    if (route.name === 'checklist' && remoteLookups.get(route.id) === 'missing') remoteLookups.delete(route.id);
    render();
  });
  window.addEventListener('storage', (e) => {
    if (e.key === store.KEY) store.reload();
  });
  window.addEventListener('online', () => runSync({ quiet: true }));
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !e.target.closest('input, textarea')) {
      e.preventDefault();
      doUndo();
    }
  });
  document.addEventListener('click', (e) => {
    for (const d of document.querySelectorAll('details.menu[open]')) if (!d.contains(e.target)) d.open = false;
  });
  importInput.addEventListener('change', importJson);
  render();
  runSync({ quiet: true });
}

function parseRoute() {
  const m = location.hash.match(/^#\/c\/([\w-]+)$/);
  return m ? { name: 'checklist', id: m[1] } : { name: 'overview' };
}

// ---------- rendering ----------

function render() {
  if (rendering) {
    renderQueued = true;
    return;
  }
  rendering = true;
  try {
    // The checklist we're looking at vanished (deleted, or its creation undone): go back.
    if (route.name === 'checklist' && location.hash === renderedRoute && !store.getChecklist(route.id) && !remoteLookups.has(route.id)) {
      history.replaceState(null, '', '#/');
      route = parseRoute();
    }
    const sameRoute = location.hash === renderedRoute;
    const focus = sameRoute ? saveFocus() : null;
    const oldScroll = sameRoute ? app.querySelector('main')?.scrollTop : null;

    app.replaceChildren(...(route.name === 'checklist' ? checklistView(route.id) : overviewView()));
    renderedRoute = location.hash;

    const main = app.querySelector('main');
    if (scrollToBottom || (!sameRoute && route.name === 'checklist')) main.scrollTop = main.scrollHeight;
    else if (oldScroll != null) main.scrollTop = oldScroll;
    scrollToBottom = false;

    const toFocus = pendingFocus && app.querySelector(`[data-key="${pendingFocus}"]`);
    if (toFocus) {
      toFocus.focus();
      toFocus.select();
      pendingFocus = null;
    } else if (focus) {
      restoreFocus(focus);
    }
  } finally {
    rendering = false;
  }
  if (renderQueued) {
    renderQueued = false;
    render();
  }
}

function saveFocus() {
  const el = document.activeElement;
  if (!el?.dataset?.key) return null;
  return { key: el.dataset.key, value: el.value, start: el.selectionStart, end: el.selectionEnd };
}

function restoreFocus(f) {
  const el = app.querySelector(`[data-key="${f.key}"]`);
  if (!el) return;
  el.value = f.value;
  el.focus();
  try {
    el.setSelectionRange(f.start, f.end);
  } catch {}
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  return t.content.firstChild;
}

function iconButton(name, label, onclick, extraClass = '') {
  return h('button', { class: `icon-btn ${extraClass}`, title: label, 'aria-label': label, onclick }, icon(name));
}

function undoButton() {
  const b = iconButton('undo', 'Undo', doUndo);
  b.disabled = !canUndo();
  return b;
}

function syncButton() {
  return iconButton('sync', syncStatus === 'error' ? 'Sync (last attempt failed)' : 'Sync', () => runSync(), `sync ${syncStatus}`);
}

function menu(...entries) {
  return h('details', { class: 'menu' },
    h('summary', { class: 'icon-btn', title: 'More', 'aria-label': 'More' }, icon('more')),
    h('div', { class: 'menu-panel' }, entries));
}

function menuItem(label, fn, cls = '') {
  return h('button', {
    class: cls,
    onclick: (e) => {
      e.currentTarget.closest('details').open = false;
      fn();
    },
  }, label);
}

// ---------- overview ----------

function overviewView() {
  const lists = store.listChecklists();
  return [
    h('header', { class: 'topbar' },
      h('h1', {}, 'Checklists'),
      undoButton(),
      syncButton(),
      menu(
        menuItem('Export all (JSON)', exportJson),
        menuItem('Import JSON…', () => importInput.click()),
      )),
    h('main', { class: 'chats' },
      lists.length ? lists.map(chatRow) : h('p', { class: 'empty' }, 'No checklists yet. Tap + to start one.')),
    h('button', { class: 'fab', title: 'New checklist', 'aria-label': 'New checklist', onclick: newChecklist }, icon('plus')),
  ];
}

function chatRow({ checklist, last, total, done, activity }) {
  return h('a', { class: 'chat-row', href: `#/c/${checklist.id}` },
    h('div', { class: 'avatar', 'aria-hidden': 'true' }, (checklist.name.trim()[0] || '?').toUpperCase()),
    h('div', { class: 'chat-body' },
      h('div', { class: 'chat-line' },
        h('span', { class: 'chat-name' }, checklist.name),
        h('time', { datetime: new Date(activity).toISOString() }, relTime(activity))),
      h('div', { class: 'chat-line' },
        h('span', { class: 'chat-preview' }, last ? last.label : 'No items yet'),
        total ? h('span', { class: `count${done === total ? ' complete' : ''}` }, `${done}/${total}`) : null)));
}

function relTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (today - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString();
}

// ---------- checklist ----------

function checklistView(id) {
  const c = store.getChecklist(id);
  if (!c) return missingView(id);
  const items = store.itemsFor(id);
  return [
    h('header', { class: 'topbar' },
      h('a', { class: 'icon-btn', href: '#/', title: 'Back', 'aria-label': 'Back' }, icon('back')),
      h('input', {
        class: 'title',
        'data-key': 'title',
        value: c.name,
        'aria-label': 'Checklist name',
        enterkeyhint: 'done',
        onkeydown: (e) => {
          if (e.key === 'Enter') e.target.blur();
          if (e.key === 'Escape') {
            e.target.value = c.name;
            e.target.blur();
          }
        },
        onblur: (e) => rename(c, e.target.value),
      }),
      undoButton(),
      iconButton('share', 'Share link', () => share(c)),
      iconButton('clone', 'Clone (all unchecked)', () => clone(c)),
      menu(
        menuItem('Export as text', () => exportText(c, items)),
        menuItem('Delete from this device', () => deleteChecklist(c), 'danger'),
      )),
    h('main', { class: 'items' },
      items.length ? items.map(itemView) : h('p', { class: 'empty' }, 'Add your first item below.')),
    h('form', { class: 'composer', onsubmit: (e) => addItem(e, c) },
      h('input', { name: 'label', 'data-key': 'composer', placeholder: 'Add an item', autocomplete: 'off', enterkeyhint: 'send', 'aria-label': 'New item' }),
      h('button', { type: 'submit', class: 'send', title: 'Add', 'aria-label': 'Add' }, icon('send'))),
  ];
}

function missingView(id) {
  const state = remoteLookups.get(id);
  if (!state) lookupRemote(id);
  return [
    h('header', { class: 'topbar' },
      h('a', { class: 'icon-btn', href: '#/', title: 'Back', 'aria-label': 'Back' }, icon('back')),
      h('h1', {}, 'Checklist')),
    h('main', { class: 'items' },
      h('p', { class: 'empty' }, state === 'missing'
        ? "This checklist isn't on this device and couldn't be fetched from the server."
        : 'Fetching checklist…')),
  ];
}

async function lookupRemote(id) {
  remoteLookups.set(id, 'loading');
  let found = false;
  try {
    found = await pull([id]);
  } catch {}
  if (found) remoteLookups.delete(id);
  else remoteLookups.set(id, 'missing');
  render();
}

function itemView(item) {
  if (editingId === item.id) {
    const finish = (save) => (e) => {
      if (rendering || editingId !== item.id) return;
      editingId = null;
      const label = e.target.value.trim();
      if (save && label && label !== item.label) dispatch({ type: 'editItem', id: item.id, label });
      else render();
    };
    return h('div', { class: 'bubble-row' },
      h('input', {
        class: 'bubble edit',
        'data-key': 'edit',
        value: item.label,
        'aria-label': 'Edit item',
        enterkeyhint: 'done',
        onkeydown: (e) => {
          if (e.key === 'Enter') finish(true)(e);
          if (e.key === 'Escape') finish(false)(e);
        },
        onblur: finish(true),
      }));
  }

  const checked = item.status === 'checked';
  const bubble = h('div', {
    class: `bubble${checked ? ' checked' : ''}`,
    role: 'checkbox',
    'aria-checked': String(checked),
    tabindex: '0',
  },
  h('span', { class: 'tick' }, icon('check')),
  h('span', { class: 'label' }, item.label));
  const row = h('div', { class: 'bubble-row' },
    h('div', { class: 'swipe-bg', 'aria-hidden': 'true' }, icon('trash')),
    bubble,
    h('div', { class: 'hover-actions' },
      iconButton('edit', 'Edit', () => startEdit(item.id)),
      iconButton('trash', 'Delete', () => deleteItem(item.id))));
  attachGestures(row, bubble, item);
  return row;
}

// Tap toggles. On touch: swipe left deletes, long-press edits. (Mouse gets hover buttons.)
function attachGestures(row, bubble, item) {
  let start = null;
  let dx = 0;
  let timer = null;
  let suppressClick = false;

  const reset = () => {
    clearTimeout(timer);
    start = null;
    bubble.style.transform = '';
    row.classList.remove('swiping', 'armed');
  };

  bubble.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    start = { x: e.clientX, y: e.clientY };
    dx = 0;
    suppressClick = false;
    timer = setTimeout(() => {
      reset();
      suppressClick = true;
      startEdit(item.id);
    }, LONG_PRESS_MS);
  });
  bubble.addEventListener('pointermove', (e) => {
    if (!start) return;
    const mx = e.clientX - start.x;
    const my = e.clientY - start.y;
    if (Math.abs(mx) > 8 || Math.abs(my) > 8) clearTimeout(timer);
    if (dx === 0 && Math.abs(my) > 8 && Math.abs(my) > Math.abs(mx)) {
      reset(); // vertical scroll; let the browser have it
      return;
    }
    dx = Math.min(0, mx);
    if (dx < -8) {
      suppressClick = true;
      bubble.setPointerCapture(e.pointerId);
      row.classList.add('swiping');
    }
    row.classList.toggle('armed', dx < -SWIPE_THRESHOLD);
    bubble.style.transform = `translateX(${dx}px)`;
  });
  bubble.addEventListener('pointerup', () => {
    if (start && dx < -SWIPE_THRESHOLD) deleteItem(item.id);
    else reset();
  });
  bubble.addEventListener('pointercancel', reset);
  bubble.addEventListener('contextmenu', (e) => e.preventDefault());
  bubble.addEventListener('click', () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    dispatch({ type: 'toggleItem', id: item.id });
  });
  bubble.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      dispatch({ type: 'toggleItem', id: item.id });
    }
  });
}

// ---------- actions ----------

function newChecklist() {
  const id = store.uuid();
  dispatch({ type: 'createChecklist', id, name: 'New checklist' });
  pendingFocus = 'title';
  location.hash = `#/c/${id}`;
}

function rename(c, value) {
  if (rendering) return;
  const name = value.trim();
  if (name && name !== c.name) dispatch({ type: 'renameChecklist', id: c.id, name });
  else render(); // restore the old name if the field was emptied
}

function addItem(e, c) {
  e.preventDefault();
  const input = e.target.elements.label;
  const label = input.value.trim();
  if (!label) return;
  input.value = '';
  scrollToBottom = true;
  dispatch({ type: 'addItem', id: store.uuid(), checklistId: c.id, label });
}

function startEdit(id) {
  editingId = id;
  pendingFocus = 'edit';
  render();
}

function deleteItem(id) {
  dispatch({ type: 'deleteItem', id });
  toast('Item deleted', true);
}

function deleteChecklist(c) {
  dispatch({ type: 'deleteChecklist', id: c.id });
  toast(`Deleted “${c.name}”`, true);
}

function clone(c) {
  const id = store.uuid();
  dispatch({ type: 'cloneChecklist', sourceId: c.id, id });
  location.hash = `#/c/${id}`;
  toast('Cloned with all items unchecked', true);
}

function doUndo() {
  const action = undo();
  toast(action ? `Undone: ${describe(action).toLowerCase()}` : 'Nothing to undo');
}

async function share(c) {
  const url = new URL(`#/c/${c.id}`, location.href).href;
  runSync({ quiet: true }); // make sure the server has it before someone opens the link
  if (navigator.share) {
    try {
      await navigator.share({ title: c.name, url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch {
    window.prompt('Copy this link', url);
  }
}

async function runSync({ quiet = false } = {}) {
  if (syncStatus === 'busy') return;
  syncStatus = 'busy';
  render();
  try {
    await sync();
    syncStatus = 'idle';
    if (!quiet) toast('Synced');
  } catch (e) {
    syncStatus = 'error';
    if (!quiet) toast(`Sync failed: ${e.message}`);
  }
  render();
}

// ---------- export / import ----------

function download(filename, text, type) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportJson() {
  const date = new Date().toISOString().slice(0, 10);
  download(`checklists-${date}.json`, JSON.stringify(store.exportData(), null, 2), 'application/json');
}

function exportText(c, items) {
  const lines = items.map((i) => `- [${i.status === 'checked' ? 'x' : ' '}] ${i.label}`);
  const safeName = c.name.replace(/[^\w -]+/g, '').trim() || 'checklist';
  download(`${safeName}.md`, `# ${c.name}\n\n${lines.join('\n')}\n`, 'text/markdown');
}

async function importJson() {
  const file = importInput.files[0];
  importInput.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    store.merge(data);
    store.save();
    toast('Imported');
  } catch (e) {
    toast(`Import failed: ${e.message}`);
  }
}

// ---------- toast ----------

function toast(message, withUndo = false) {
  toastEl.replaceChildren(
    h('span', {}, message),
    withUndo ? h('button', { onclick: doUndo }, 'Undo') : null,
  );
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), TOAST_MS);
}

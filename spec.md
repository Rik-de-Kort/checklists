# Checklist/capture app

A shared checklist is fully editable by both parties, except that deletion of
the whole checklist just deletes it for _you_. Unsure about technical
implementation here, would just a magic link work? There'll be some backend
server, how to take care of auth? Note: this is a home-cooked app.

All actions should be undoable for at least some time. App should be 100% usable
offline. Model: all data is local, gets synced with backend regularly. Start
with local, single-device application. Cloud sync (two ways) as an additional
feature.

No user accounts, only checklists.

Data should be easily exportable.

## Application architecture

Three components: user interface, action stack, data store. Plain HTML/CSS/JS.

### User interface

Very chat-like. View model on underlying data. Two pages: overview and
checklist.

Overview contains a list of checklists, similar to chat application interface.
Order by most recently updated (order by select max(created at) from item where
checklist = id) In bottom right button to create a new checklist. In top bar one
button to sync.

Checklist contains a single checklist. Items are sorted by created at. In the
bottom a message box to create a new checklist item. In the top a share button
to copy the link, and a button to clone the checklist. Cloning resets every item
in the list to be unchecked. Tap to check/uncheck an item on the checklist.
Swipe to delete. (On desktop, button on the right side).

### Action stack

Action in user interface pushes action on the stack. To undo an action, the
action is popped from the action stack, and the inverse transformation is
applied to the data.

### Data store

Data goes in localstorage or similar.

Model

- Checklist - id (uuid?), name (text), created at (timestamp)
- Item - id (int), label (text), created at (timestamp), status (unchecked,
  checked), containing checklist (id into Checklist)

### Sync mechanism

Server contains same data model, just with all the checklists its been sent.
Server should be very simple, no auth initially Routes: pull(list of checklist
ids): checklist data, push(list of checklist data): status,

## Notes

- Deleting a checklist deletes it only locally: the server copy persists.

## Questions

- How does share button work in a PWA? Can we copy the link? Get the share
  dialog from OS? How to make cross-compatible with desktop use?
- How do multiple pages work? Just fit in a SPA with a single static HTML file?

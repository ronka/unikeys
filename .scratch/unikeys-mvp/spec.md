# Spec: unikeys MVP

Status: ready-for-agent

## Problem Statement

I use several apps every day — VSCode, Cursor, WebStorm, and Ghostty — and each one has its own idea of which keys do what. The same conceptual action has a different chord in each app, because each app shipped different defaults and I've customised them at different times for different reasons. There is no single place where I can see this.

The result is friction I pay for constantly. I reach for the WebStorm chord in VSCode and nothing happens. I learn a new binding in Cursor and forget it in WebStorm. When I do decide to standardise on a chord, I have to open four different apps, find four different settings screens, and make four separate edits in four different notations — which is enough work that I mostly don't bother, and the divergence gets worse.

I can't even see the problem clearly. There is no view that says "here is the action, and here is what each of your four apps currently does for it." Without that view I can't tell which apps disagree, or how badly.

## Solution

unikeys is a macOS desktop app that shows all of my keybindings in one table and lets me edit them in one place.

Each **row** is an **action** — a thing I want to do, like "Save All" or "Split Pane Right". Each **column** is one of my apps. Each **cell** shows the chord that action is currently bound to in that app. At a glance I can see where my apps agree and where they've drifted.

I can edit any cell directly to change that app's chord. And when I want an action to feel the same everywhere, I click **link** on the row — the row collapses to a single shared chord, and from then on editing it changes every app at once. Linking is remembered, so the row stays in sync as I keep tweaking.

When I save, unikeys writes the changes into each app's real configuration file. It edits surgically — only the actions unikeys manages are touched, and everything else in those files is left exactly as it was. A backup is taken before the first write of each session, so a bad write is always recoverable.

On first run, unikeys reads my actual configuration from all four apps and fills the table in with what they do *today*, including each app's built-in defaults. So the very first thing I see is the true state of my divergence, not an empty grid.

## User Stories

### Seeing the table

1. As a developer using four apps, I want to see one table where each row is an action and each column is an app, so that I can see my whole keyboard setup in a single view.
2. As a developer, I want each cell to show the chord currently bound to that action in that app, so that I can tell at a glance which apps disagree.
3. As a developer, I want rows where all apps already agree to be visually distinct from rows where they diverge, so that I can find the problems without reading every cell.
4. As a developer, I want an action that has no equivalent in one of my apps to show an explicitly empty cell, so that I can tell "not bound" apart from "not applicable".
5. As a developer, I want chords rendered with the macOS symbols I actually see in menus (⌘ ⌥ ⇧ ⌃), so that I can compare them without mentally translating four different text notations.
6. As a developer, I want to know which chord came from an app's shipped default versus my own customisation, so that I understand why my apps diverged in the first place.
7. As a developer, I want to filter or search the table by action name, so that I can find a specific binding in a catalogue of dozens of rows.
8. As a developer, I want actions grouped by category (editing, navigation, terminal, window management), so that the table is scannable rather than one long alphabetical list.

### Configuring apps

9. As a developer, I want unikeys to detect which of the four supported apps are installed on my Mac, so that I don't have to tell it what I already have.
10. As a developer, I want unikeys to find each app's configuration file at its standard macOS location, so that setup requires no work from me in the common case.
11. As a developer, I want to point unikeys at a config file manually when auto-detection fails, so that a non-standard install doesn't block me entirely.
12. As a developer, I want to turn an app off in unikeys, so that its column disappears and unikeys never writes to it.
13. As a developer, I want to see clearly when unikeys could not find or could not parse an app's config, so that I don't mistake a parse failure for "this app has no bindings".

### Editing

14. As a developer, I want to click a cell and record a new chord by pressing the keys, so that I don't have to type a notation I'd have to look up.
15. As a developer, I want to type a chord as text as an alternative to pressing it, so that I can set bindings the OS would otherwise intercept.
16. As a developer, I want to clear a cell, so that I can remove a binding I don't want.
17. As a developer, I want to be told when I've entered a chord that the target app's format cannot express, so that I don't save something that will silently fail to apply.
18. As a developer, I want to cancel an in-progress edit, so that a mis-pressed key doesn't commit a binding.

### Linking

19. As a developer, I want to click "link" on a row, so that the action becomes the same chord across every app that supports it.
20. As a developer, I want to see clearly which rows are linked and which are not, so that I know which edits will propagate.
21. As a developer, when I link a row whose apps currently disagree, I want to choose which of the existing chords becomes the shared one, so that linking doesn't silently discard the binding I actually wanted.
22. As a developer, I want editing any cell in a linked row to update every app in that row, so that one edit keeps my setup consistent.
23. As a developer, I want to unlink a row, so that I can go back to per-app chords when an app genuinely needs something different.
24. As a developer, I want unlinking to leave each app holding the last shared chord rather than reverting to what it was before, so that unlinking doesn't undo work I meant to keep.
25. As a developer, I want linked state to persist across restarts, so that unikeys stays a sync tool rather than a one-off bulk-edit button.
26. As a developer, I want linking to skip apps that have no mapping for that action, so that a linked row doesn't try to bind an editor action in my terminal.

### Saving and writing

27. As a developer, I want to see which changes are pending before I save, so that I know exactly what is about to be written to my real config files.
28. As a developer, I want unikeys to write to every affected app's config in one action, so that saving is a single decision rather than four.
29. As a developer, I want unikeys to leave every binding it does not manage untouched, so that I can keep hand-editing my apps for anything unikeys doesn't cover.
30. As a developer, I want unikeys to back up each config file before its first write in a session, so that I can recover if a write goes wrong.
31. As a developer, I want to know where the backups are, so that I can restore one myself.
32. As a developer, I want a write that fails partway to tell me exactly which apps were written and which were not, so that I'm never guessing about the state of my machine.
33. As a developer, I want to be reminded that an app must be restarted or its config reloaded before changes take effect, so that I don't think unikeys failed when it actually worked.
34. As a developer, I want to discard my unsaved edits, so that I can abandon an experiment without touching my apps.

### First run

35. As a developer, on first launch I want unikeys to import my current bindings from all four apps, so that the table reflects reality immediately.
36. As a developer, I want the import to include each app's shipped defaults, not just my explicit overrides, so that most cells are populated rather than blank.
37. As a developer, I want the import to be non-destructive, so that simply opening unikeys never changes my apps.
38. As a developer, I want to see a summary after import of how many actions were found and how many apps disagree, so that I know the tool works and where to start.

## Implementation Decisions

### Domain vocabulary

This spec establishes the project's vocabulary; there is no existing glossary.

- **Action** — a conceptual operation a user wants to perform, identified by a stable unikeys id and a human-readable name. One table row. Independent of any app.
- **App** — one of the supported applications. One table column.
- **Command** — an app's own identifier for an operation (`workbench.action.files.save`, `SaveAll`, `new_split:right`). An action maps to at most one command per app.
- **Chord** — a key combination, held internally in a canonical form and serialised per app.
- **Binding** — a chord bound to a command within a specific app. One table cell.
- **Catalogue** — the shipped, hand-authored set of actions and their per-app command mappings.
- **Adapter** — the per-app module that parses and merges that app's config format.
- **Store** — unikeys' own persisted state: chosen chords, linked rows, app configuration.

### Architecture

- unikeys is the source of truth. It maintains its own store of actions, chords, and linked state; apps are write targets. There is no two-way sync and no drift detection.
- All filesystem and config access happens in the Electron main process. The renderer is pure UI and talks to main over a small typed IPC surface. Nothing in the renderer touches `fs`.
- The store persists as a single JSON document in Electron's `userData` directory, versioned with a schema version field so future migrations are possible.
- macOS only. Path detection, chord notation, and modifier rendering may all assume macOS.

### The action catalogue

- The catalogue ships with the app as static data — roughly 30 actions, hand-authored, covering editing, navigation, window/pane management, and terminal operations.
- Each catalogue entry carries a unikeys action id, a display name, a category, and a mapping to zero-or-one command per supported app. Absence of a mapping is meaningful: it renders as a not-applicable cell and is skipped when linking.
- The catalogue is data, not code, and is validated at startup so a malformed entry fails loudly rather than producing a broken row.
- Because Ghostty is a terminal, a significant share of catalogue rows will map to only one or two apps. This is accepted for the MVP. See Further Notes.

### The chord model

- A canonical internal chord representation is defined once, covering modifiers, the base key, and multi-keystroke sequences (VSCode and JetBrains both support two-keystroke chords).
- Each adapter owns the translation between the canonical form and its app's notation. Notation differences are an adapter concern and never leak into the store or the UI.
- A chord that cannot be expressed in a given app's format is a first-class outcome, surfaced to the user, not a silent failure.

### Adapters

- One adapter per app, behind a single shared interface. Cursor reuses the VSCode adapter with a different config path — the fork shares the `keybindings.json` format.
- The adapter interface is defined over **strings, not files**: `parse(contents) → Binding[]` and `merge(contents, managedBindings) → contents`. Adapters are pure and know nothing about the filesystem, which is what makes the format risk testable. A thin file layer above them handles reading, writing, and backup.
- `merge` performs a surgical edit: it modifies only entries corresponding to managed actions, and preserves all other content, ordering, comments, and formatting as faithfully as the format allows.
- Adapters also expose that app's shipped defaults, so first-run import can populate cells the user has never overridden. **How defaults are obtained differs per app and is the largest open technical risk in this spec** — VSCode's defaults are compiled into the application rather than stored as a readable file. Resolving this per app is part of the implementation work; if defaults prove unobtainable for an app, that app's unoverridden cells start empty and the app is still shipped.

### Writing

- Writes are transactional in intent: unikeys computes the full new contents for every affected file first, and only then begins writing. A failure partway is reported per app with a precise account of what was and was not written.
- Before the first write to a given file in a session, unikeys copies it to a timestamped backup alongside the store, and surfaces the backup location in the UI.
- Files are written atomically (write to temp, then rename) so an interrupted write cannot truncate a real config.

### Table state

- Table interaction state — pending edits, link/unlink, chord assignment — is modelled as a pure reducer over the store. The reducer is the only place linked-row propagation is implemented.
- Linking a divergent row requires the user to pick the winning chord; the reducer does not choose. Unlinking leaves every app holding the last shared chord.
- Pending edits are held separately from the saved store, so the UI can show a diff before saving and discard cleanly.

### UI

- A single-window app: a settings/app-configuration surface and the main table.
- Chord entry uses a capture control that records real key presses, with a text-entry fallback.
- No component library is mandated. The table is dense and read-heavy; prefer plain semantic markup over a heavyweight grid dependency for a catalogue of this size.

## Testing Decisions

There is currently **no test runner in this repo** — the scaffold ships none. The MVP adds Vitest, which is the natural fit for a Vite-based project and runs the pure modules below in a plain Node environment with no Electron and no browser.

A good test here asserts **external behaviour at a seam**: given these file contents and these managed bindings, what contents come out; given this state and this user action, what state results. Tests must not reach into adapter internals, assert on intermediate parse structures, or mock the filesystem — the seams are designed so that no mocking is needed.

**Seam 1 — adapters (primary).** Because `parse` and `merge` are pure string-to-string functions, every format risk is testable with fixture strings committed to the repo:

- Round-tripping: parsing real-world config content and merging it back unchanged produces byte-identical output.
- Surgical merge: unmanaged bindings, comments, ordering, and formatting survive a merge that changes a managed binding.
- Chord translation both directions, including two-keystroke sequences and the modifier sets each format spells differently.
- Format-specific hazards: VSCode's `-command` negation entries, JetBrains keymap XML structure and its parent-keymap inheritance, Ghostty's `keybind =` line syntax.
- Inexpressible chords: an adapter reports rather than silently drops a chord its format cannot represent.

Fixtures should be captured from genuine config files, not invented, since the value of this seam is entirely in matching reality.

**Seam 2 — the table reducer (secondary).** Linked-row propagation is the product's core feature and the easiest thing to get subtly wrong:

- Editing a cell in a linked row updates every mapped app, and no unmapped app.
- Linking a divergent row applies the chosen winning chord everywhere.
- Unlinking leaves apps on the last shared chord rather than reverting.
- Linked state survives a store serialise/deserialise round trip.

**Untested for the MVP:** filesystem read/write and backup, IPC wiring, app auto-detection, and React rendering. These are thin, hard to test without heavy machinery, and verified by actually running the app. This is a deliberate MVP trade-off, not an oversight.

**Prior art:** none — these are the repo's first tests, so they set the pattern.

## Out of Scope

- **Conflict detection.** No warning when two actions share a chord within one app. Correctness would require the app's complete binding set, not just managed rows.
- **Drift detection and re-import.** unikeys does not notice or reconcile edits you make inside the apps after it last wrote. unikeys owns the state.
- **User-defined actions.** No UI to add a row or map it to app commands yourself. The MVP is limited to the shipped catalogue. See Further Notes — this is the deferral most likely to be regretted.
- **Profiles or presets.** No multiple named keybinding sets.
- **Two-way sync of any kind.**
- **Non-macOS platforms.** No Windows or Linux path handling, and macOS modifier assumptions are baked in.
- **Apps beyond the four named.** The adapter interface leaves room for more; adding them is not MVP work.
- **Auto-reloading or restarting the target apps** after a write. unikeys tells you; you restart.
- **Distribution concerns** — code signing, notarisation, auto-update. Personal local use only.

## Further Notes

**The catalogue tension — flagged, deferred by explicit decision.** A shipped-only catalogue combined with Ghostty in the app set means many rows will be terminal-shaped with three not-applicable editor cells, and you cannot add the actions I failed to think of. I recommended pulling "add your own row" into the MVP — it is a form and a dropdown — and the decision was to defer it. Recorded here because it is the most likely early source of frustration, and the catalogue format should therefore be designed so that user-defined actions can be added later without a schema migration.

**Defaults sourcing is the real risk.** Story 36 — importing each app's shipped defaults — is what makes first run useful rather than an empty grid, and it is also the least certain part of this spec. VSCode's defaults are not a file on disk. JetBrains ships keymaps inside the application bundle with parent-keymap inheritance to resolve. Ghostty documents its defaults but they may need transcribing. This should be investigated per app before the table UI is built, since an unresolvable answer for an app changes what first run looks like.

**Cursor is nearly free.** It is a VSCode fork sharing the `keybindings.json` format; only the config path differs. Two of the four columns come from one adapter.

**Development environment mismatch.** This repo currently sits on Linux with none of the four apps installed, while the target is macOS. Real config fixtures must be captured from the actual Mac; they cannot be produced by inspecting this machine.

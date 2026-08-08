# 26 — Fold the catalogue fragments in

**What to build:** The three new-adapter tickets each wrote a standalone
`catalogue-<app>.json` fragment rather than editing `catalogue.json`, because 38
actions × three agents editing one file is a merge conflict on nearly every line. This
ticket folds them into the real catalogue and deletes the fragments.

**Blocked by:** 23, 24, 25 — all three merged into `main`.

**Status:** done — commit `49d7503`

**Files you own:** `src/shared/catalogue/catalogue.json`,
`src/shared/catalogue/catalogue.test.ts`, and the three
`catalogue-<app>.json` fragments (deleted).

## The fold

For each fragment, for each `"<action-id>": "<command>"` pair, add that command under
the matching action's `commands` object. Preserve the existing key order within each
`commands` object — the file is read by people.

Then delete `catalogue-zed.json`, `catalogue-warp.json` and `catalogue-obsidian.json`.
They were scaffolding for the parallel split and should not outlive it.

## Check, do not just concatenate

Three agents authored these independently, so this is the first moment anything sees
them together. Verify:

- Every action id in every fragment exists in `catalogue.json`. An id that does not is
  a typo or a renamed action and must be resolved, not dropped.
- No fragment maps an action to an obviously wrong command — spot-check the terminal
  rows against Warp and the navigation rows against Zed. A mapping that names a command
  the app does not have produces a cell that silently never fires.
- `validateCatalogue` still passes, including its rule that no action maps to zero apps.
- Actions that end up mapped to only one or two apps are fine and expected — Obsidian in
  particular should map few rows.

## Linked rows across thirteen apps

`mappedApps()` decides where a linked row propagates. With thirteen columns a linked row
now reaches far more apps than it did, including across categories — linking "Copy"
touches editors, terminals and Obsidian at once. Nothing in the reducer needs to change
for that, but add a reducer or view test that exercises a linked row over the full
thirteen-app set, so the behaviour is pinned rather than assumed.

## Definition of done

- [x] Every fragment mapping is present in `catalogue.json` and the fragments are deleted
- [x] Every action id referenced by a fragment exists; none were silently dropped
- [x] `catalogue.test.ts` passes, and covers the widened catalogue
- [x] A test exercises a linked row propagating across all thirteen apps
- [x] `npm test`, `npm run typecheck` and `npm run lint` pass

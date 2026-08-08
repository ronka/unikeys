# 27 — Thirteen columns

**What to build:** The table was designed around six columns and now has thirteen. This
ticket is the product-level consequence of the other seven: what a user actually sees
on first launch after upgrading, and whether the table is still readable.

**Blocked by:** 26.

**Status:** done — commits `dc29a79`, `3be3e40`

**Files you own:** `src/main/index.ts` and `src/main/store-file.ts` for the seeding
change, `src/renderer/src/components/KeysTable.tsx`, `src/renderer/src/pages/AppsPage.tsx`,
`src/shared/table/view.ts` and their tests.

## The upgrade regression

`createEmptyStore()` sets `enabled: true` for every entry in `APP_IDS`, and
`deserializeStore()` starts from that base and overlays whatever the persisted document
holds. So an existing user's store gains seven enabled columns on upgrade — and most of
them are apps they do not have. The table goes from six useful columns to thirteen
mostly-empty ones with no action from the user.

Seed new apps as enabled only when they are installed.

The constraint that decides where this goes: `createEmptyStore()` lives in
`src/shared/store/types.ts` and `isInstalled` touches the filesystem. Putting detection
into the shared module breaks the layering the whole project rests on. The seeding must
happen in the **main process at load time** — after `loadStore`, before the store is
first used — as a one-time pass that disables apps that are neither installed nor
already known to the persisted document. An app the user has explicitly enabled or
disabled before must keep whatever they chose.

Getting this wrong in the other direction is also bad: a user who installs Zed next
month should get a usable column, and the existing backfill rule in `isCellUnseen`
already handles the chords. Only the initial `enabled` flag is in question here.

## Does the table hold up

It probably does — `KeysTable.tsx` already pins the action and link columns with
`sticky` and scrolls horizontally, and the category headings already span
`view.apps.length + 2`. Verify rather than assume, with thirteen columns enabled:

- The pinned action and link columns stay pinned and their `left` offsets stay exact
- Sticky category headings still line up under the header at 33px
- Horizontal scrolling reaches the thirteenth column and the last column is not clipped
- Editing a cell in the rightmost column keeps the column width and does not reflow the row
- The app filter and search still work, and filtering to one app still collapses correctly

Fix what breaks; do not redesign what does not. If thirteen columns genuinely does not
work at a usable window width, the answer is a note in the plan and a follow-up ticket,
not an unscoped table rewrite in this one.

## The Apps page at scale

`AppsPage.tsx` groups by category. It now has three groups instead of two and thirteen
cards instead of six, several of them for apps the user does not have. Check that:

- The new `notes` group renders with its label and in a sensible position
- Not-installed apps are visually distinct enough that a list of thirteen is scannable
- The four new IDEs' health messages read correctly — particularly Kiro's
  `config-not-created` and Obsidian's path-required state

## Definition of done

- [x] On upgrade, an existing store gains the new apps disabled unless they are installed
- [x] Apps the user had already enabled or disabled keep that choice
- [x] Detection stays in the main process; nothing in `src/shared/` touches the filesystem
- [x] With thirteen columns enabled, the pinned columns, sticky headings and horizontal scroll all still behave
- [x] The Apps page renders three category groups and thirteen cards legibly
- [x] `npm test`, `npm run typecheck` and `npm run lint` pass

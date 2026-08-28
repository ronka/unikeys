# Sign in, and sync chords across Macs

Sign in with Apple, an account, and the user's chords following them from one Mac to
another. Terms are defined in [CONTEXT.md](../CONTEXT.md) — in particular **cell**,
**asserted**, **divergence**, **revision**, **device** and **batch**.

The four decisions worth their own record are in
[docs/adr/0001](../docs/adr/0001-review-incoming-changes-before-applying-them.md)–[0004](../docs/adr/0004-a-deployed-web-surface-for-sign-in-with-apple.md).
This document is the design they sit inside.

Status: design settled, nothing built.

---

## How it behaves

You sign in with Apple on each Mac and name it. From then on, opening unikeys or bringing
its window to the front pulls anything the other Mac asserted since you last looked. Nothing
lands silently: incoming changes appear in a review pane, grouped by the gesture that made
them, and accepting stages them into the table's normal pending overlay. You press Save, and
unikeys writes them into your editors the same way it writes anything else — backing each
file up first, touching only the actions it manages.

If both Macs changed the same cell, the second one to reconnect is told so and shown both
values with the other machine's name on it. Whichever you pick wins everywhere; the Macs
always end up agreeing.

Signing out drops the token and stops syncing. It never touches your keybindings.

---

## Settled

### The unit of sync is the cell

`(actionId, appId)`. Both coordinates are stable and human-readable, so a composite primary
key already exists and nothing needs an id minted for it.

Only chords sync. Everything else in `Store` is **machine-local** and must never leave the
Mac: `apps[*].grants` and `backups.grants` are macOS security-scoped bookmarks,
`apps[*].configPath` and `backups.directory` are absolute paths, `analytics.distinctId`
identifies an install, and `firstRunCompleted` / `onboardingCompleted` describe this
machine's setup.

### Only asserted cells sync

See [ADR-0002](../docs/adr/0002-sync-only-cells-the-user-asserted.md). `StoredChord` gains
`asserted`, and that is the filter — not `origin`, which cannot express it.

### No tombstones

`clearChord` is documented as "An unbinding is a value, not an absence" and writes
`{ chord: null }` (`src/shared/table/reducer.ts:396`). The only `delete` in the reducer is
on the pending overlay, never the saved store, so the saved cell set only ever grows. A
delete on one Mac cannot be resurrected by another's import, and the whole deletion branch
of the design disappears.

### Incoming changes are reviewed, then saved

See [ADR-0001](../docs/adr/0001-review-incoming-changes-before-applying-them.md). Accept
stages into `TableState.pending`; Save writes to disk. Declining means **Keep mine** and
pushes the local value up, so Macs converge and no declined-revision state is kept.

### Changes are grouped by the gesture that made them

Each push carries a batch id and a kind. One Match becomes one review item reading
`Matched "comment line" → ⌘J (5 apps)` with a single Accept, expandable to the individual
cells. Without this, one click on the other Mac produces thirteen near-identical rows, which
is the fastest way to train someone to hit Accept all without reading.

### Ordering is server-assigned

See [ADR-0003](../docs/adr/0003-server-assigned-revisions-not-client-clocks.md).

### Sync runs on launch, window focus, and after Save

No polling, no timer, no live connection. Keybindings change a few times a week, and the
real scenario is walking to the other Mac and opening the app. This needs **one new
main→renderer push channel** — there are currently zero `webContents.send` calls in the
codebase and the IPC surface is strictly request/response.

### A device is its own identity

A `syncDeviceId`, minted separately from `analytics.distinctId` and named by the user at
sign-in (prefilled from the Mac's name, editable). Reusing the analytics id would join it to
an authenticated Apple account and destroy the un-linkability its docstring promises, and it
has to work when analytics is switched off. Asking for the name also avoids shipping the
Mac's hostname — frequently a person's full name — to the server without them seeing it.

### Signing out keeps everything local

Sign-out drops the token and the device registration; the table is unchanged. Account
deletion wipes the cloud rows and leaves every Mac's table exactly as it stands. Nothing in
an account screen can destroy a user's keybindings.

### Free, with a plan column from day one

No billing, no receipts, no StoreKit. `user.plan` defaults to `'free'` and the sync
endpoints sit behind a check that currently always passes. Worth being honest that this
column is the easy part — charging later still means StoreKit on the App Store build, a
separate payment path for the DMG, and server-side validation of both.

### Sign-in is optional

App Review Guideline 5.1.1(v) requires an app whose core function is not account-based to
work without one, and requires in-app account deletion wherever accounts can be created.
Both are obligations rather than choices. unikeys stays fully usable signed out.

---

## Shape

### Transport

`@better-auth/electron` (v1.7.1), which splits into three configs — server, web client,
Electron client — and handles the protocol dance, keeps tokens in the main process away from
the renderer, and ships a copy-paste code fallback for when the deep link does not fire.

```
system browser
   ↓  Sign in with Apple
https://<domain>/api/auth/callback/apple
   ↓  deep link
com.ronkaa.unikeys://auth?code=…
   ↓  app.on('open-url') → showMainWindow()
main process: token sealed with safeStorage
```

### Schema

better-auth's CLI generates `user`, `session`, `account` and `verification`. On top of those:

```sql
alter table "user" add column plan text not null default 'free';

create table device (
  id          uuid primary key,
  user_id     text not null references "user"(id) on delete cascade,
  name        text not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create sequence cell_revision;

create table cell (
  user_id    text   not null references "user"(id) on delete cascade,
  action_id  text   not null,
  app_id     text   not null,
  chord      text,            -- null means deliberately unbound
  revision   bigint not null default nextval('cell_revision'),
  device_id  uuid   not null references device(id),
  batch_id   uuid   not null,
  batch_kind text   not null, -- 'edit' | 'match' | 'copy'
  updated_at timestamptz not null default now(),
  primary key (user_id, action_id, app_id)
);

create index cell_pull on cell (user_id, revision);
```

One global sequence rather than a per-user counter: any subset of a monotonic sequence is
itself monotonic, so per-user ordering is preserved without a counter row to contend on.

**Pull** is a cursor read — `where user_id = $1 and revision > $2 order by revision` — so a
client only ever fetches what it has not seen.

**Push** is optimistic: the client sends the revision it last saw for that cell, and the
server writes only `where revision = $expected`. Zero rows updated means divergence, and the
current row goes back to the client for the review pane.

Removing a Mac from the account **revokes** the device rather than deleting the row, because
every cell it ever wrote still points at it and the review pane needs its name to say where
a change came from. `on delete cascade` from `user` is right; a hard device delete is not.

There is no `deleted` column, because there are no tombstones.

### What the client stores

The two revisions above are both machine-local, and neither has anywhere to live today.

`StoredChord` gains exactly one field — `asserted` — because that is a fact about the user's
intent and belongs with the chord. Sync bookkeeping does not: it goes in its own block, so
the domain type does not accumulate protocol state.

```ts
export interface SyncState {
  deviceId: string | null
  deviceName: string | null
  /** Highest revision pulled. The cursor the next pull resumes from. */
  cursor: number
  /** Revision last seen per cell, mirroring `ChordTable`'s shape. What push sends as `$expected`. */
  seen: Record<string, Partial<Record<AppId, number>>>
}
```

All of it is machine-local and none of it is ever uploaded.

---

## Constraints discovered, not chosen

- **`vercel.app` cannot be the domain.** It is on the Public Suffix List, so Apple will not
  verify it. A domain we own is required.
- **No custom URL scheme is registered today.** No `protocols:` key in
  `electron-builder.yml`, no `CFBundleURLTypes`, no `setAsDefaultProtocolClient`, no
  `open-url` handler. All of it has to be added, and `open-url` must route through the
  existing `showMainWindow()` because on macOS it arrives on the already-running instance.
- **The renderer cannot make requests.** `src/renderer/index.html:9` sets
  `default-src 'self'` with no `connect-src`, and `entitlements.mas.inherit.plist` cannot
  widen helper capabilities. All backend HTTP belongs in the main process behind
  `src/shared/ipc.ts`.
- **Neither `npm run dev` nor the DMG build can surface a sandbox networking failure.**
  `isSandboxed()` simulates only the file-access half. Budget a TestFlight round-trip.
- **`ITSAppUsesNonExemptEncryption: false`** in `electron-builder.yml` is justified by a
  comment reading "the only crypto import in the app is `randomUUID`". Adding `safeStorage`
  means re-verifying that declaration before the next submission.
- **The privacy label and `docs/privacy.html` both need updating.** They currently describe
  an app whose only egress is PostHog.

---

## Version skew: already handled, and must stay that way

A Mac on a newer build can assert cells for actions — or one day apps — that an older Mac
has never heard of. If the older Mac drops those rows, syncing to it and back silently
deletes the newer Mac's work.

It does not drop them today. `deserializeStore` reads the chord table as a bare passthrough
(`src/shared/store/types.ts:252`):

```ts
chords: isRecord(data.chords) ? (data.chords as ChordTable) : {},
```

No catalogue filter, no `APP_IDS` filter. Unknown action ids and unknown app ids both
survive a round-trip, and the UI never shows them because it iterates the catalogue and
`APP_IDS` rather than the stored keys. Store-but-do-not-display is exactly the behaviour
required, and it is already the behaviour.

The `apps` block immediately below *is* filtered against `APP_IDS` (line 275), which is
correct — that is machine-local config, not synced data.

**So the note for a future reader is a "do not fix this".** Adding validation to the chord
table would look like a tightening and would in fact introduce data loss across versions.
If it is ever validated, it must quarantine unknown keys rather than discard them.

## Risks worth naming before building

**Save is undebounced.** `App.tsx:265` persists the whole store on every change to
`state.store`. Sync pushes must not inherit that — they need their own trigger, not a
`useEffect` on the store.

**No sync surface has been reviewed by Apple.** The 1.1.1 submission took two rejections
already. An account plus a network sync is a materially larger review surface than an
analytics opt-in.

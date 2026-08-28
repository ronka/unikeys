# Sync only cells the user asserted

A cell carries an `origin` of `default`, `imported` or `user`. Only cells the user
deliberately set inside unikeys are eligible to sync; the other two are facts about one Mac
— shipped defaults come from that Mac's installed app versions, and imports are that Mac's
own pre-existing customisations — and propagating either would overwrite the other machine's
real configuration with something nobody decided.

## Consequences

The eligible set is a few dozen cells rather than the ~500 the table can hold, which is
what keeps the per-cell review pane of [ADR-0001](./0001-review-incoming-changes-before-applying-them.md)
readable. It also means the cloud is not a mirror of the table, and a fresh Mac signing in
still imports its own defaults locally as it always did.

**The filter cannot be `origin`.** `setPending` in `src/shared/table/reducer.ts` compares
`savedValue.chord === value.chord` — chord alone, ignoring origin — deliberately, so that
re-typing the chord a cell already holds does not light up a Save button for a write that
changes no bytes. The consequence is that deliberately confirming a shipped default never
promotes the cell to `origin: 'user'`. Filtering on origin would therefore silently refuse
to sync a decision the user really made.

So `StoredChord` gains an `asserted` flag, set on any deliberate user action including a
chord-identical one, and that is the sync filter. This keeps `origin` meaning exactly what
its docstring says, keeps the Save button honest, and makes "what syncs" a decision we
control rather than a side-effect of a comparison written for unrelated reasons.

## Existing stores must be backfilled on read

The field is additive, but it is **not** one where absence can default to `false`. Every
1.1.1 user has cells with `origin: 'user'`; reading their store with no `asserted` key and
defaulting it false would make their entire existing customisation set ineligible to sync.
They would sign in and watch nothing happen.

`deserializeStore` therefore backfills `asserted = (origin === 'user')` for any cell lacking
the key. This loses nothing: before the flag existed there was no way to assert a
chord-identical cell, so `origin === 'user'` is exactly the asserted set of an old store.

This is the same shape as the `onboardingCompleted` rule a few lines above it in
`src/shared/store/types.ts`, which infers itself from `firstRunCompleted` when absent rather
than defaulting to false and re-running the wizard for existing users.

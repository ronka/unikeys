# 21 — IntelliJ IDEA and PyCharm columns

**What to build:** Two more JetBrains columns, served by the existing
`jetbrains-keymap` adapter. No format work: the keymap XML, the inheritance chain and
the textual merge are identical across the JetBrains IDEs. What changes is that the
adapter stops being about WebStorm specifically — in its `apps` list, in its
`defaults(app)` gate, and in the user-visible text that currently names WebStorm.

**Blocked by:** 20.

**Status:** done — branch `feat/apps-jetbrains`, commit `1924dbd`

**Files you own:** `src/shared/adapters/jetbrains.ts`,
`src/shared/adapters/jetbrains.test.ts`,
`src/shared/adapters/__fixtures__/jetbrains/`. Nothing else.

## The three places WebStorm is hardcoded

1. `jetbrainsAdapter.apps: ['webstorm']` — becomes all three ids.
2. `defaults(app)` early-returns `unavailable` for any app that is not `webstorm`.
   All three IDEs should get the same `MACOS_DEFAULTS`; every entry in that table is a
   platform-level action id (`SaveAll`, `GotoFile`, `$Undo`, `CommentByLineComment`)
   that the IntelliJ platform ships in all of its IDEs. State that reasoning in a
   comment — it is the decision, not an accident. Guard the list against an app the
   adapter does not serve, as it does today.
3. `DEFAULTS_NOTE` and the `encodeChord`/`shortcutElement` failure strings say
   "WebStorm" in text the user reads. Reword to name the JetBrains IDEs generally, or
   thread the app name through. `emptyContents()`'s `parent="Mac OS X 10.5+"` is
   correct for all three and needs no change.

## What must not change

The adapter interface, the XML scanner, `resolveInheritance`, and the merge's
span-splicing. This ticket adds no behaviour; if a test in `jetbrains.test.ts` needs
rewriting for anything other than the widened `apps`/`defaults` surface, something has
gone wrong.

## Fixtures

Neither IDE is installed on this machine, so any new fixture is authored from the
documented format, not captured — the same standing caveat as the existing JetBrains
fixtures. Extend `__fixtures__/jetbrains/README.md` to say the directory now covers
three IDEs and that the provenance is unchanged. Reuse the existing fixtures rather
than duplicating them per IDE: the format is the same file, and three copies of
`user-keymap.xml` would imply a difference that does not exist.

Add coverage for the one thing that is new — `defaults('intellij')` and
`defaults('pycharm')` returning the same `partial` report as `defaults('webstorm')`,
and `defaults()` for an unrelated app still returning `unavailable`.

## Definition of done

- [ ] The table shows IntelliJ IDEA and PyCharm columns, populated from a real keymap when one exists — renderer work, lands with ticket 27
- [x] `adapterFor('intellij')` and `adapterFor('pycharm')` both resolve to the JetBrains adapter
- [x] `defaults()` returns the curated macOS keymap for all three IDEs and `unavailable` for anything else
- [x] No user-visible string from this adapter says "WebStorm" when the column is IntelliJ or PyCharm
- [x] Both IDEs' versioned config directories resolve, including the Community Edition directory names
- [x] `npm test`, `npm run typecheck` and `npm run lint` pass

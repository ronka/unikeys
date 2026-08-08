# 24 — Warp column

**What to build:** Replace the `warp-keybindings` stub with a real adapter. Warp keeps
its custom shortcuts in `~/.warp/keybindings.yaml`: a flat YAML map of action name to
chord string. It is the closest format in the project to Ghostty's — line-oriented
plain text, one binding per line — and it should be built the same way.

**Blocked by:** 20.

**Status:** done — branch `feat/apps-warp`, commit `e8c87c1`

**Files you own:** `src/shared/adapters/warp.ts`, `src/shared/adapters/warp.test.ts`,
`src/shared/adapters/__fixtures__/warp/`, `src/shared/catalogue/catalogue-warp.json`.
Nothing else — do **not** edit `catalogue.json`; ticket 26 folds your fragment in.

## The format

```yaml
# Warp keybindings
workspace:new_tab: cmd-t
pane_group:add_right: cmd-d
terminal:copy: cmd-c
editor_view:backspace: ctrl-h
```

- Keys are Warp's action names, colon-separated and stable.
- Values are chords: lowercase modifiers `cmd`, `ctrl`, `alt`, `shift`, hyphen-joined,
  then the key. Values may or may not be quoted.
- An empty or `null` value unbinds.
- Warp has no two-keystroke sequences, so `encodeChord` must reject a chord with more
  than one stroke with a clear reason — `InexpressibleChord` is a first-class outcome
  here, not a silent drop. Ghostty's adapter already does exactly this; copy its shape.

## Merge textually

**Do not add a YAML dependency and do not parse-and-reserialise.** The round-trip
guarantee in `README.md` — unchanged content comes back byte-identical, comments and
ordering survive — rules both out. Handle the flat `key: value` line form, splice in
place, and append what is not already there, the way `ghostty.ts` does with `keybind =`
lines.

That means the adapter only understands a subset of YAML, which is fine and should be
stated in the module comment. Anything the line scanner cannot account for — nested
maps, anchors, multi-line values, flow style — becomes a `ParseProblem` on that entry
rather than a failure of the whole file. A config with twenty good lines and one anchor
should show twenty bindings and one problem.

A file that is wholly unrecognisable is a different matter and should fail parsing, so
the column reads `config-unparseable` rather than "no bindings".

## Defaults

Warp publishes its default keyset as
`default-warp-keybindings.yaml` in the `warpdotdev/keysets` repository, so unlike most
apps here the defaults are genuinely sourceable. If you can source them, do — that is
the first `availability: 'complete'` in the project and worth having. If you cannot
verify them, ship a curated subset as `partial` with a note. Do not report `complete`
for a list you assembled by hand.

## Catalogue fragment

`src/shared/catalogue/catalogue-warp.json`, a flat map of unikeys action id → Warp
action name. Warp is a terminal, so expect it to map the terminal and window rows
(`terminal.split-right`, `pane.focus-up`, `edit.copy`) and almost none of the editing
or navigation ones. Omit rather than invent; an absent key renders as not-applicable.

## Fixtures

Warp is not installed on this machine, so fixtures are authored from the documented
format. Write `__fixtures__/warp/README.md` saying so. Cover at minimum: a populated
keybindings file with comments, one with quoted and unquoted values, one with an empty
value (unbind), one containing a nested structure the scanner should report as a
problem, and a file with no trailing newline.

## Definition of done

- [ ] The table shows a Warp column populated from `~/.warp/keybindings.yaml` — renderer work, lands with ticket 27; Warp is not installed here so this stays unobserved
- [x] Warp's chord notation converts to and from the canonical chord in both directions
- [x] A two-keystroke chord is reported as inexpressible rather than written or dropped
- [x] Merge is textual: unchanged content round-trips byte-identically, and comments, ordering and unmanaged bindings survive
- [x] A line the scanner cannot read becomes a parse problem, not a failed file
- [x] `defaults('warp')` reports an availability that matches how the list was actually sourced
- [x] `catalogue-warp.json` exists and maps only actions Warp really has
- [x] `npm test`, `npm run typecheck` and `npm run lint` pass

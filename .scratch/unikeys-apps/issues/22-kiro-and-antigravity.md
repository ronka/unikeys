# 22 — Kiro and Antigravity columns

**What to build:** Two more VSCode-fork columns. Both apps are Code OSS forks and keep
a standard `keybindings.json`, so the `vscode-keybindings` adapter serves them
unchanged — this is the case the format/app split was designed for, and Cursor already
proves it works. The only adapter change is its `apps` list and its defaults report.

This is the one ticket in the batch whose fixtures can be **captured from a real Mac**:
both apps are installed here.

**Blocked by:** 20.

**Status:** ready-for-agent

**Files you own:** `src/shared/adapters/vscode.ts`,
`src/shared/adapters/vscode.test.ts`, `src/shared/adapters/__fixtures__/vscode/`.
Nothing else.

## Adapter changes

`vscodeAdapter.apps` grows from `['vscode', 'cursor']` to four. `defaults()` currently
takes no app and returns one curated `partial` report; that stays right — all four
forks inherit Code OSS's default keybindings, and the note explaining that VSCode
compiles its defaults into the application applies verbatim to the forks. Widen the
note's wording so it does not read as being about VSCode alone.

Nothing else in the adapter should move. If parsing or merging needs a change to
accommodate a fork, that is a finding worth reporting, not a change to make quietly.

## Capture real fixtures

```
~/Library/Application Support/Kiro/User/keybindings.json
~/Library/Application Support/Antigravity/User/keybindings.json
```

Antigravity's file exists and holds standard entries, including at least one
fork-specific command (`composerMode.agent`). Capture it as a fixture — it is the best
available evidence that the surgical merge leaves a fork's own commands alone, which
is exactly what a user of two forks needs to be true. Add a merge test asserting that
a fork-specific unmanaged binding round-trips byte-identically.

Kiro has a `User/` directory but no `keybindings.json` yet. That is the
`config-not-created` state — `writeTarget` supplies the path and the first save creates
the file. Confirm that path is what `diagnose()` reports rather than assuming it, and
do not create the file by hand as part of this work.

Update `__fixtures__/vscode/README.md`: it currently says the fixtures were authored
rather than captured, and after this ticket that is only partly true. Say which files
are captured, from which app, and leave the caveat standing for the rest.

## Definition of done

- [ ] The table shows Kiro and Antigravity columns, populated from their real configs
- [ ] `adapterFor('kiro')` and `adapterFor('antigravity')` both resolve to the VSCode adapter
- [ ] A captured Antigravity fixture is committed, and a merge over it leaves the fork's own commands untouched
- [ ] Kiro's missing config reports `config-not-created` with the path a first save would use, not an error
- [ ] `__fixtures__/vscode/README.md` distinguishes captured fixtures from authored ones
- [ ] `npm test`, `npm run typecheck` and `npm run lint` pass

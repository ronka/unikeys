# Warp fixtures — authored, not captured

These files were **written by hand from Warp's documented format**. They were not
captured from a real Warp installation: Warp is not installed on the machine this
adapter was implemented on, so no genuine `~/.warp/keybindings.yaml` was available to
copy.

The format they follow is documented, not guessed. `FORMAT.md` in the
[`warpdotdev/keysets`](https://github.com/warpdotdev/keysets) repository defines the
key syntax — hyphen-joined modifiers ending with the character the key produces — and
`default-warp-keybindings.yaml` in the same repository is the source of this adapter's
shipped-defaults table. The fixtures aim to be faithful to both — quoted and bare keys,
quoted and bare values, `---`, comments, inconsistent spacing around the colon, a
shifted character (`shift-cmd-}`), a hyphen used as the key (`cmd--`), Warp's `meta`
modifier, every spelling of an unbind, nested and anchored YAML the line scanner
refuses, and a file with no trailing newline — but faithful is not the same as real.

**Replace them with genuine captures when a Mac with Warp is available**, and re-run the
tests: anything that breaks is a real assumption this adapter got wrong. The same
outstanding requirement is recorded in the repository `README.md` for every other
adapter but iTerm2.

| File                       | What it covers                                                     |
| -------------------------- | ------------------------------------------------------------------ |
| `populated.yaml`           | The full spread of syntax, including a line we can't read          |
| `unbound.yaml`             | Empty, `""`, `null` and `~` — all four ways Warp says "not bound"  |
| `nested.yaml`              | Nesting, anchors, aliases and flow style: problems, not a failure  |
| `no-trailing-newline.yaml` | Byte-identity for a file that does not end in a newline            |
| `not-a-map.yaml`           | A file that is no keybindings map at all, so parsing fails         |

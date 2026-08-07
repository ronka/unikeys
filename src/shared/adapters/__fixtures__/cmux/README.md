# cmux fixtures — one captured, the rest authored

Unlike the Ghostty and JetBrains fixtures, `template-0.64.22.jsonc` is **genuine**: it is a
byte-for-byte copy of the `~/.config/cmux/cmux.json` that cmux 0.64.22 generated on the
machine this adapter was written on. Nothing in it was typed by a person — cmux writes the
whole file itself on first launch, as two real members followed by every setting commented
out — so it carries no personal configuration.

That file is the single most important fixture here, because it is what the adapter will
meet on almost every real machine: a config with **no `shortcuts` member at all**, whose
entire body is comments that a merge must leave untouched.

`DEFAULT_SHORTCUTS` in `../../cmux.ts` was transcribed from this same file. It lists 69 of
the 142 action ids cmux's schema accepts, so an id absent from that table means "the
template did not print it", not "cmux leaves it unbound".

The remaining fixtures were **written by hand** to reach the shapes the template cannot
show — a config that already has bindings, one where `shortcuts` exists without `bindings`,
and a broken one. They follow cmux's published JSON Schema
(`https://raw.githubusercontent.com/manaflow-ai/cmux/main/web/data/cmux.schema.json`),
which is where this adapter's notation rules come from, but they are not captures.

**Recapture `template-0.64.22.jsonc` when cmux updates**, and re-run the tests: cmux is a
fast-moving app, and anything that breaks is a real assumption this adapter got wrong.

| File                       | What it covers                                                        |
| -------------------------- | --------------------------------------------------------------------- |
| `template-0.64.22.jsonc`   | The real generated template: no `shortcuts`, 215 lines of comments     |
| `populated.jsonc`          | Bindings that exist: strings, an array chord, both unbind sentinels    |
| `shortcuts-no-bindings.jsonc` | `shortcuts` present but `bindings` missing — the middle merge case  |
| `malformed.jsonc`          | A syntax error, which must fail the file rather than one entry         |

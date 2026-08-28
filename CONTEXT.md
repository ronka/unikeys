# unikeys

One table for every keybinding across fifteen macOS apps. unikeys holds its own record of
what each action should be bound to in each app, and writes that record into those apps'
real config files.

### Support boundary: Codex and Claude Code, not Claude Desktop

The **Agents** category (see [[app]]) holds two columns: **Codex**, the Codex workspace
inside the ChatGPT desktop app (`$CODEX_HOME/keybindings.json`, a private and
undocumented format verified against a pinned ChatGPT version), and **Claude Code**, the
standalone terminal interface (`~/.claude/keybindings.json`, Anthropic's officially
documented contract). "Claude Code" always means the terminal program — never Claude
Desktop's Chat, Cowork, or Code-tab shortcuts, which are a distinct, currently
unsupported surface with no stable file or API to write to. Do not use the bare name
"Claude" where "Claude Code" is meant; the ambiguity is exactly the mistake this
boundary exists to prevent.

## Language

### The table

**Action**:
Something a user can do that more than one app has a name for, such as "save" or "comment
line". A row of the table. Identified by a dotted lowercase id that is unikeys' own and
never an app's command name.
_Avoid_: Command, shortcut, binding

**App**:
One of the fifteen supported programs unikeys writes config for. A column of the table.
_Avoid_: Editor, target, client

**Chord**:
A key combination, at most two keystrokes, held in unikeys' own canonical notation rather
than any app's. `null` is a chord-shaped value meaning "deliberately not bound", which is
different from having no value at all.
_Avoid_: Shortcut, keybinding, hotkey, key

**Cell**:
What one app binds one action to. The intersection of a row and a column, and the unit the
user actually edits. Identified by the pair `(action, app)`; it has no id of its own.
_Avoid_: Key, entry, binding

**Origin**:
Where a cell's chord came from — the app's shipped defaults, the user's own config file as
unikeys found it, or the user's decision inside unikeys. Provenance, not intent.

**Asserted**:
A cell the user deliberately decided, as opposed to one unikeys merely observed. Distinct
from origin, because deliberately confirming a chord a cell already holds is an assertion
that leaves provenance untouched. Only asserted cells sync.

**Unseen**:
A cell unikeys holds nothing for. Distinct from a cell deliberately unbound. An unseen cell
invites the next launch's import to fill it in; an unbound one is left alone. No cell is
ever removed once it exists.

**Match**:
Giving every app that has an action the same chord, once. A copy, not a subscription —
nothing about the match is remembered, and a later edit to one cell changes that cell alone.

**Batch**:
The set of cells one user gesture produced. A match and a column-wide copy are batches; a
single cell edit is a batch of one. Batches survive sync so the receiving Mac can say what
was done rather than list what changed.

**Conflict**:
Two actions bound to the same chord within one app. A property of a single machine's
bindings. Not to be confused with [[divergence]].
_Avoid_: Clash, collision, overlap

### Sync

**Divergence**:
Two Macs holding different chords for the same cell. Always resolved, never recorded — one
of the two values wins and both Macs end up agreeing.
_Avoid_: Conflict, merge conflict, mismatch

**Revision**:
A number the server allocates to each write, increasing per user. The only authority on
which of two values is newer. Machine clocks are never consulted.

**Device**:
One Mac, registered against an account and given a name by the user. What the review pane
means by "from MacBook". Deliberately not the same identity as the analytics install id.
_Avoid_: Machine, install, client

**Machine-local**:
State that describes one Mac rather than the user's intent, and therefore never syncs:
folder grants, config file paths, the backups location, the analytics install id, the
first-run and onboarding flags, and all sync bookkeeping — the device identity, the pull
cursor, and the revision last seen for each cell.
_Avoid_: Device state, local settings

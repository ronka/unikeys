# Server-assigned revisions, not client clocks

Postgres allocates a monotonically increasing revision to every cell write. A client
pushing a cell also sends the revision it last saw; if the cloud has moved on, the server
refuses the write and the client routes that cell into the review pane. Nothing in unikeys
was stamped with a time or a version before this, so there was no existing ordering to
preserve and no cost to choosing the strict option.

## Considered options

**Client wall-clock, last write wins** is the obvious choice and one column simpler. It was
rejected because a Mac resuming from sleep with a skewed clock silently beats a genuinely
newer edit, and the losing value is discarded with nothing shown — the exact outcome
[ADR-0001](./0001-review-incoming-changes-before-applying-them.md) exists to prevent.

**A hybrid logical clock** is the rigorous answer and would make concurrency provably
detectable rather than merely likely. It buys nothing here: this is a single user with two
or three Macs, and the server already sees every write, so it can simply be the authority.

## Consequences

Two Macs editing the same cell while offline is detected rather than guessed at. The second
one to reconnect has its push refused, and sees the divergence in the review pane with both
values and the other machine's name — so the outcome is decided by the user rather than by
whichever laptop happened to reconnect second.

Each client must store two things it has nowhere to put today: a pull cursor (the highest
revision it has seen at all) and the last-seen revision *per cell*, which is what an
optimistic push sends as its expected value. Both are machine-local and neither belongs on
`StoredChord` — they are protocol state, not part of what a chord is.

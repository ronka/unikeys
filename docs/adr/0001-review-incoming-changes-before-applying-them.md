# Review incoming changes before applying them

A pulled chord does not enter the table on its own. It appears in a review pane, per cell,
showing the incoming chord, the local one, and which Mac it came from; accepting stages the
cell into the existing pending overlay, and only the user's Save writes it into an app's
real config file. The obvious alternative — write straight through, so sync is hands-off —
was rejected because unikeys' central promise is that nothing reaches VSCode's or Zed's
config except by an explicit Save, and a background process editing a developer's editor
config while they are not looking breaks exactly that.

## Consequences

Sync is not finished when the pull completes; it is finished when the user visits unikeys
and saves. Accepting therefore costs one extra click, which buys the whole existing write
pipeline unchanged — backups, surgical merge, and `markSaved`'s rule that an app whose
write failed stays pending rather than silently dropping the edit.

Because the user can decline an incoming change, something must stop it reappearing on
every pull. Declining is defined as "keep mine": the local value is pushed up as a new,
higher revision and the other Mac receives it in turn. Macs therefore always converge, and
no declined-revision marker is stored anywhere. The button says **Keep mine**, not Reject,
because it overwrites the other machine and the word has to say so.

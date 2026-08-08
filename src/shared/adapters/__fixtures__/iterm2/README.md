# iTerm2 fixtures — captured, not authored

This is the first adapter in the repo whose fixtures and constants come from a real
installation rather than from documentation. iTerm2 **3.6.11** was installed on the machine
this adapter was written on, and it was driven directly to settle every question the format
raised.

## `captured-3.6.11.json` — the important one

Byte for byte what `iterm2Adapter.merge(emptyContents(), …)` produced for three bindings
(Split Right → ⌃⌘U, New Terminal → ⌃⌘A, Clear Screen → ⌃⌘E). It was then written to
`~/Library/Application Support/iTerm2/DynamicProfiles/` and **every line of it was
confirmed to behave as intended in a running iTerm2**:

| Behaviour | Result |
| --- | --- |
| ⌃⌘U splits the pane (`Action 29`) | fires |
| ⌃⌘A opens a tab (`Action 27`) | fires |
| ⌃⌘E clears committed scrollback (`Action 25`) | fires |
| ⌘D no longer splits — iTerm2's shipped default, suppressed by `Action 13` | suppressed |
| ⌘T no longer opens a tab — likewise | suppressed |

The last two rows are the point of the `Ignore` entries. Without them a profile key map can
only ever *add* bindings, and moving Split Right to ⌃⌘U would leave ⌘D splitting as well.

`iterm2.test.ts` asserts the adapter still emits this file exactly, so a change to the
rendering or to the action table fails against bytes a real iTerm2 has agreed with.

## `default-global-key-map.json`

The 14 entries of `iTerm.app/Contents/Resources/DefaultGlobalKeyMap.plist`, converted from
the binary plist to JSON and otherwise untouched. It is committed because it is the
evidence for two claims the adapter depends on: that the action integers are what
`iTermKeyBindingAction.h` says (all 14 reproduce), and that only **arrow** keys carry the
`0x200000` NumericPad bit — `0xf729-0x100000` (⌘Home) and `0xf72c-0x20000` (⇧PgUp) do not,
while `0xf703-0x300000` (⌘→) does.

## The rest

`empty-profile.json` is `emptyContents()`. `with-unmanaged.json` mixes a unikeys entry with
hand-added ones that must survive a merge untouched — including a legacy unprefixed key
(`f702-0x280000`, a form the app bundle itself still ships), a three-part key with a virtual
keycode (what iTerm2's own UI writes), extra `Version`/`Label` members, and a second profile
unikeys must not touch. `malformed.json` has an array at the root, which iTerm2 rejects with
"does not have an Object (i.e., a dictionary) as its root element"; `no-profiles.json` is a
valid object with no `Profiles`.

These four were written by hand to reach shapes a capture cannot produce on demand. They are
shapes, not observations.

## Recapturing

Re-run against a newer iTerm2 when one lands, and re-verify the table above by hand — the
key-encoding rules are the fragile part, not the JSON. What was checked empirically, and
would need rechecking:

- two-part keys still match (iTerm2's own UI writes three-part; both work today)
- Shift is applied to the character **and** the Shift bit is set: ⌘⇧D is `0x44`, not `0x64`,
  and ⌘⇧[ is `0x7b`
- `Action 25`'s parameter is `"<title>\n<identifier>"`; a bare title does not fire
- the `*_WITH_PROFILE` actions need a real profile Guid — there is no "current profile"
  sentinel
- a profile key map **overrides** a built-in menu shortcut (⌘T bound to Send Text typed its
  text instead of opening a tab)
- `"Default Bookmark": "Yes"` in a dynamic profile does **not** make it the default, which
  is why `reloadHint` asks the user to select the profile once

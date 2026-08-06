# Ghostty fixtures — authored, not captured

These files were **written by hand from knowledge of Ghostty's config format**. They were
not captured from a real Ghostty installation: the machine this adapter was implemented on
runs Linux and has no Ghostty installed, so no genuine config was available to copy.

They aim to be faithful — comments, non-keybind settings, inconsistent spacing around `=`,
a `keybind = clear`, a leader sequence, an `unbind`, an unmodelled trigger prefix, an action
containing `=`, and a file with no trailing newline — but faithful is not the same as real.

**Replace them with genuine captures when a Mac with Ghostty is available**, and re-run the
tests: anything that breaks is a real assumption this adapter got wrong. Ticket 03 asks for
fixtures captured from a real config, and that requirement is still outstanding.

| File                       | What it covers                                           |
| -------------------------- | -------------------------------------------------------- |
| `full.conf`                | The full spread of syntax, including lines we can't read |
| `no-trailing-newline.conf` | Byte-identity for a file that does not end in a newline  |

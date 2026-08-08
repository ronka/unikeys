/**
 * Obsidian's `hotkeys.json` — a stub.
 *
 * The format is real but unimplemented: Obsidian stores an object of command id
 * to an array of `{ modifiers, key }` objects, inside whichever vault is open.
 * Until that is written every entry point fails loudly, so Obsidian's column
 * reads as unparseable rather than as an app with nothing bound.
 */

import type { Chord } from '../chord'
import type { Adapter, DefaultsReport, EncodeOutcome, MergeOutcome, ParseOutcome } from './types'

const NOT_IMPLEMENTED = 'The Obsidian adapter is not implemented yet.'

export const obsidianAdapter: Adapter = {
  format: 'obsidian-hotkeys',
  apps: ['obsidian'],

  parse(): ParseOutcome {
    return { ok: false, error: NOT_IMPLEMENTED }
  },

  merge(): MergeOutcome {
    return { ok: false, error: NOT_IMPLEMENTED }
  },

  encodeChord(): EncodeOutcome {
    return { ok: false, reason: NOT_IMPLEMENTED }
  },

  decodeChord(): Chord | null {
    return null
  },

  defaults(): DefaultsReport {
    return { availability: 'unavailable', note: NOT_IMPLEMENTED, bindings: [] }
  },

  emptyContents(): string {
    return ''
  }
}

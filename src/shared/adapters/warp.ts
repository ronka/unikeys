/**
 * Warp's `keybindings.yaml` — a stub.
 *
 * The format is real but unimplemented: Warp keeps a flat YAML map of action
 * name to key sequence, which a later ticket will merge line by line the way
 * `ghostty.ts` does rather than by parsing and reserialising. Until then every
 * entry point fails loudly, so Warp's column reads as unparseable rather than
 * as an app with nothing bound.
 */

import type { Chord } from '../chord'
import type { Adapter, DefaultsReport, EncodeOutcome, MergeOutcome, ParseOutcome } from './types'

const NOT_IMPLEMENTED = 'The Warp adapter is not implemented yet.'

export const warpAdapter: Adapter = {
  format: 'warp-keybindings',
  apps: ['warp'],

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

/**
 * Zed's `keymap.json` — a stub.
 *
 * The format is real but unimplemented: Zed's keymap is an array of context
 * blocks whose `bindings` object maps chord → action, the inverse of every
 * other format here. Until that inversion is written, every entry point fails
 * loudly. A stub that quietly returned no bindings would put Zed's column in
 * the same state as an app with an empty config, and the user would have no way
 * to tell the difference between "you have bound nothing" and "unikeys cannot
 * read this".
 */

import type { Chord } from '../chord'
import type { Adapter, DefaultsReport, EncodeOutcome, MergeOutcome, ParseOutcome } from './types'

const NOT_IMPLEMENTED = 'The Zed adapter is not implemented yet.'

export const zedAdapter: Adapter = {
  format: 'zed-keymap',
  apps: ['zed'],

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

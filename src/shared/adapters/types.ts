/**
 * The adapter interface.
 *
 * Adapters are defined over **strings, not files**. `parse` takes file contents
 * and returns bindings; `merge` takes file contents and returns new file
 * contents. They are pure and know nothing about the filesystem, which is what
 * makes every format risk testable with committed fixture strings and no
 * mocking. A thin file layer in the main process handles reading, writing and
 * backup above them.
 */

import type { AppId, FormatId } from '../apps'
import type { Chord } from '../chord'

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type BindingSource = 'user' | 'default'

export interface ParsedBinding {
  /** The app's own identifier for the operation, e.g. `workbench.action.files.save`. */
  command: string
  /**
   * `null` when the entry names no chord at all. A JetBrains `<action id="X" />`
   * with no shortcut is exactly this: a deliberate unbind that suppresses the
   * inherited default. Without a nullable chord it would be indistinguishable
   * from an action the user never mentioned, and the cell would wrongly show
   * the parent keymap's binding.
   */
  chord: Chord | null
  source: BindingSource
  /**
   * True when the entry removes a binding rather than adding one — VSCode
   * expresses "unbind this default" as a `-command` negation entry, and
   * treating that as a binding would show a chord the user has deliberately
   * disabled. A negated entry may still carry a chord (VSCode names the one it
   * is removing) or not (JetBrains does not).
   */
  negated?: boolean
}

/**
 * Something wrong with one entry that does not invalidate the whole file. A
 * config with three good bindings and one unrepresentable chord should show
 * three bindings and one problem, not fail entirely.
 */
export interface ParseProblem {
  message: string
  /** The offending source text, when the format makes it identifiable. */
  detail?: string
}

export type ParseOutcome =
  | {
      ok: true
      bindings: ParsedBinding[]
      problems: ParseProblem[]
      /**
       * True when the config discards the app's shipped defaults wholesale —
       * Ghostty's `keybind = clear` does exactly this. Without it, unikeys would
       * fill cells with default chords the user has already thrown away, which
       * is worse than showing them empty.
       */
      defaultsSuppressed?: boolean
    }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * One managed binding to write. A `null` chord means "unikeys manages this
 * action and it should not be bound", which each format expresses differently.
 */
export interface ManagedBinding {
  command: string
  chord: Chord | null
}

/**
 * A chord the target format cannot express. A first-class outcome surfaced to
 * the user, never a silent drop.
 */
export interface InexpressibleChord {
  command: string
  chord: Chord
  reason: string
}

export type MergeOutcome =
  { ok: true; contents: string; skipped: InexpressibleChord[] } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Chord translation
// ---------------------------------------------------------------------------

export type EncodeOutcome = { ok: true; value: string } | { ok: false; reason: string }

// ---------------------------------------------------------------------------
// Shipped defaults
// ---------------------------------------------------------------------------

/**
 * How completely this adapter can supply the app's shipped defaults.
 *
 * Sourcing differs per app and is the largest open technical risk in the
 * project — VSCode's defaults are compiled into the application rather than
 * stored as a readable file. An adapter that cannot source them still ships;
 * its unoverridden cells start empty and the limitation is surfaced to the
 * user rather than hidden.
 */
export type DefaultsAvailability = 'complete' | 'partial' | 'unavailable'

export interface DefaultsReport {
  availability: DefaultsAvailability
  /** Shown in the UI when availability is not `complete`. */
  note?: string
  bindings: ParsedBinding[]
}

// ---------------------------------------------------------------------------
// The interface itself
// ---------------------------------------------------------------------------

export interface Adapter {
  readonly format: FormatId
  /** Apps served by this adapter. Cursor and VSCode share one. */
  readonly apps: readonly AppId[]

  /** Parses config file contents into the bindings the user has customised. */
  parse(contents: string): ParseOutcome

  /**
   * Rewrites config contents so the managed bindings hold, touching nothing
   * else. Unmanaged bindings, comments, ordering and formatting survive as
   * faithfully as the format allows; merging unchanged content must round-trip
   * byte-identically.
   */
  merge(contents: string, managed: ManagedBinding[]): MergeOutcome

  /** Canonical chord to this app's notation. */
  encodeChord(chord: Chord): EncodeOutcome

  /** This app's notation to canonical form, or `null` if unrepresentable. */
  decodeChord(text: string): Chord | null

  /**
   * The app's shipped defaults, so first-run import populates cells the user
   * has never overridden. `app` is passed because apps sharing a format may
   * still ship different defaults.
   */
  defaults(app: AppId): DefaultsReport

  /**
   * Contents to use when the config file does not exist yet, so a first save
   * can create one.
   */
  emptyContents(): string
}

import { useEffect, useRef, useState } from 'react'

import { adapterFor } from '@shared/adapters'
import type { AppId } from '@shared/apps'
import {
  formatCanonical,
  formatDisplay,
  formatStrokeDisplay,
  MAX_STROKES,
  parseCanonical,
  strokeFromKeyEvent,
  type Chord,
  type KeyStroke
} from '@shared/chord'

interface Props {
  /** The chord currently in the cell, or `null` when unbound. */
  value: Chord | null
  /** Which apps this edit will land in — every app in a linked row. */
  targets: readonly AppId[]
  onCommit: (chord: Chord | null) => void
  onCancel: () => void
}

/**
 * Records a chord by pressing the keys, with a text-entry fallback for
 * combinations macOS would otherwise intercept (⌘Q, ⌘Tab and friends never
 * reach the window, so they can only be set by typing them).
 */
export function ChordInput({ value, targets, onCommit, onCancel }: Props): React.JSX.Element {
  const [strokes, setStrokes] = useState<KeyStroke[]>(value?.strokes ?? [])
  const [mode, setMode] = useState<'capture' | 'text'>('capture')
  const [armedForSecond, setArmedForSecond] = useState(false)
  const [text, setText] = useState(value ? formatCanonical(value) : '')
  const [textError, setTextError] = useState<string | null>(null)
  const captureRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (mode === 'capture') captureRef.current?.focus()
    else textRef.current?.focus()
    // `armedForSecond` is a dependency because arming moves focus to the button
    // that was clicked. Without returning focus to the capture area, the second
    // keystroke lands on nothing and two-keystroke chords cannot be recorded at
    // all.
  }, [mode, armedForSecond])

  const draft: Chord | null = strokes.length > 0 ? { strokes } : null
  const problems = draft ? expressibilityProblems(draft, targets) : []

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Escape cancels rather than being recorded. Binding Escape itself is done
    // through the text field — a deliberate trade, since cancelling a
    // mis-pressed key is the far more common need.
    if (event.code === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      onCancel()
      return
    }

    event.preventDefault()
    event.stopPropagation()

    const captured = strokeFromKeyEvent(event.nativeEvent)
    if (captured === null) return

    // A fresh press replaces the chord; the second keystroke of a sequence is
    // only appended when the user has explicitly asked for one.
    setStrokes((current) =>
      current.length === 1 && armedForSecond ? [...current, captured] : [captured]
    )
    setArmedForSecond(false)
  }

  const commitText = (): void => {
    const trimmed = text.trim()
    if (trimmed === '') {
      onCommit(null)
      return
    }
    const parsed = parseCanonical(trimmed)
    if (parsed === null) {
      setTextError(`"${trimmed}" is not a chord unikeys can represent.`)
      return
    }
    onCommit(parsed)
  }

  return (
    <div className="chord-input" role="group" aria-label="Edit chord">
      {mode === 'capture' ? (
        <div
          ref={captureRef}
          className="chord-capture"
          tabIndex={0}
          role="textbox"
          aria-label="Press a key combination"
          onKeyDown={handleKeyDown}
        >
          {strokes.length > 0 ? (
            strokes.map((s, i) => (
              <kbd key={i} className="chord-key">
                {formatStrokeDisplay(s)}
              </kbd>
            ))
          ) : (
            <span className="chord-placeholder">Press keys…</span>
          )}
          {armedForSecond && <span className="chord-placeholder">then…</span>}
        </div>
      ) : (
        <div className="chord-text">
          <input
            ref={textRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setTextError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitText()
              if (e.key === 'Escape') onCancel()
            }}
            placeholder="e.g. cmd+shift+p or ⌘K ⌘S"
            aria-label="Type a chord"
          />
          {textError && <p className="chord-error">{textError}</p>}
        </div>
      )}

      {problems.length > 0 && (
        <ul className="chord-error" aria-live="polite">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="chord-actions">
        {mode === 'capture' && strokes.length < MAX_STROKES && strokes.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setArmedForSecond(true)
              captureRef.current?.focus()
            }}
          >
            Add 2nd keystroke
          </button>
        )}
        <button type="button" onClick={() => setMode(mode === 'capture' ? 'text' : 'capture')}>
          {mode === 'capture' ? 'Type instead' : 'Press instead'}
        </button>
        <button type="button" onClick={() => onCommit(null)}>
          Clear
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => (mode === 'text' ? commitText() : onCommit(draft))}
          disabled={mode === 'capture' && draft === null}
        >
          Set{draft && mode === 'capture' ? ` ${formatDisplay(draft)}` : ''}
        </button>
      </div>
    </div>
  )
}

/**
 * Checks the chord against every app the edit will reach, so a user is told
 * before saving that a format cannot express what they entered rather than
 * discovering it silently failed to apply.
 */
function expressibilityProblems(chord: Chord, targets: readonly AppId[]): string[] {
  const problems: string[] = []
  for (const app of targets) {
    const outcome = adapterFor(app).encodeChord(chord)
    if (!outcome.ok) problems.push(`${app}: ${outcome.reason}`)
  }
  return problems
}

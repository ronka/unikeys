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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

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
    // Floated out of flow by the caller: the editor is wider and taller than the
    // cell it edits, and in flow it resized the column and the row, shifting the
    // whole table.
    <div
      className="bg-card border-primary flex min-w-[240px] flex-col gap-[6px] rounded-md border p-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
      role="group"
      aria-label="Edit chord"
    >
      {mode === 'capture' ? (
        // Deliberately a focusable div, not an input: `handleKeyDown` has to
        // preventDefault and stopPropagation on every keystroke, which is not
        // something a real text field can do without fighting its own editing.
        <div
          ref={captureRef}
          className="border-input focus:border-primary flex min-h-[28px] items-center gap-[6px] rounded-md border border-dashed px-[8px] py-[3px] outline-none focus:border-solid"
          tabIndex={0}
          role="textbox"
          aria-label="Press a key combination"
          onKeyDown={handleKeyDown}
        >
          {strokes.length > 0 ? (
            strokes.map((s, i) => (
              <kbd
                key={i}
                className="bg-background border-input rounded-[4px] border px-[6px] py-[1px] font-mono"
              >
                {formatStrokeDisplay(s)}
              </kbd>
            ))
          ) : (
            <span className="text-faint">Press keys…</span>
          )}
          {armedForSecond && <span className="text-faint">then…</span>}
        </div>
      ) : (
        <div>
          <Input
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
            className="h-8"
          />
          {textError && <p className="text-destructive mt-1 text-xs">{textError}</p>}
        </div>
      )}

      {problems.length > 0 && (
        <ul className="text-destructive m-0 list-disc pl-4 text-xs" aria-live="polite">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-1">
        {mode === 'capture' && strokes.length < MAX_STROKES && strokes.length > 0 && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setArmedForSecond(true)
              captureRef.current?.focus()
            }}
          >
            Add 2nd keystroke
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          onClick={() => setMode(mode === 'capture' ? 'text' : 'capture')}
        >
          {mode === 'capture' ? 'Type instead' : 'Press instead'}
        </Button>
        <Button size="xs" variant="outline" onClick={() => onCommit(null)}>
          Clear
        </Button>
        <Button size="xs" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          onClick={() => (mode === 'text' ? commitText() : onCommit(draft))}
          disabled={mode === 'capture' && draft === null}
        >
          Set{draft && mode === 'capture' ? ` ${formatDisplay(draft)}` : ''}
        </Button>
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

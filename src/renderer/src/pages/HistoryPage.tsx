import { useMemo, useState } from 'react'
import { ChevronRight, RotateCcw } from 'lucide-react'

import { APPS } from '@shared/apps'
import { formatDisplay, parseCanonical } from '@shared/chord'
import {
  canRevert,
  revertibleChanges,
  unrevertibleChanges,
  type HistoryChange,
  type HistoryEntry
} from '@shared/history/types'
import { isSettled, type SaveOutcome } from '@shared/table/save-outcome'
import { getStoredChord, type ChordTable } from '@shared/store/types'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { PageHeader } from './PageHeader'

interface Props {
  entries: HistoryEntry[]
  /** The saved chord table, for spotting entries a later save has overtaken. */
  chords: ChordTable
  onRevert: (entry: HistoryEntry) => void
}

/**
 * What every save did, newest first.
 *
 * The Pending page is the same information one step earlier — this is the record
 * that survives the save, which is what makes "what did I change, and what was
 * it before?" answerable at all.
 */
export function HistoryPage({ entries, chords, onRevert }: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(entries[0]?.id ?? null)

  return (
    <>
      <PageHeader
        title="History"
        description="Every save, with what each binding was before it. Reverting loads the old values back as pending changes for you to review."
      />

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        {entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing saved yet.</p>
        ) : (
          <div className="max-w-4xl space-y-2">
            {entries.map((entry) => (
              <Entry
                key={entry.id}
                entry={entry}
                chords={chords}
                open={expanded === entry.id}
                onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)}
                onRevert={() => onRevert(entry)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function Entry({
  entry,
  chords,
  open,
  onToggle,
  onRevert
}: {
  entry: HistoryEntry
  chords: ChordTable
  open: boolean
  onToggle: () => void
  onRevert: () => void
}): React.JSX.Element {
  const changes = entry.kind === 'save' ? entry.changes : []
  const failed = entry.kind === 'save' ? entry.apps.filter((app) => !app.ok) : []
  const revertible = canRevert(entry)

  // An entry a later save has overtaken can still be reverted — it just will not
  // do what the row above it says any more, so it is worth saying so.
  const superseded = useMemo(
    () =>
      revertibleChanges(entry).filter(
        (change) => getStoredChord(chords, change.actionId, change.app)?.chord !== change.next.chord
      ).length,
    [entry, chords]
  )
  const unseen = useMemo(() => unrevertibleChanges(entry).length, [entry])

  return (
    <div className="rounded-lg border">
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn('text-muted-foreground size-4 shrink-0 transition-transform', {
              'rotate-90': open
            })}
          />
          <span className="shrink-0 text-sm font-medium tabular-nums">{when(entry.at)}</span>
          <span className="text-muted-foreground truncate text-xs">{summary(entry)}</span>
        </button>

        {entry.kind === 'save' && entry.error && <Badge variant="destructive">failed</Badge>}
        {failed.length > 0 && !((entry.kind === 'save' && entry.error) ?? false) && (
          <Badge variant="destructive">{failed.length} app not written</Badge>
        )}

        <Button
          size="xs"
          variant="outline"
          onClick={onRevert}
          disabled={!revertible}
          title={
            revertible
              ? 'Load these values back as pending changes'
              : 'Nothing in this save reached unikeys, so there is nothing to put back'
          }
        >
          <RotateCcw />
          Revert
        </Button>
      </div>

      {open && (
        <div className="space-y-3 border-t px-3 py-3">
          {changes.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>App</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {changes.map((change) => (
                  <TableRow key={`${change.actionId}:${change.app}`}>
                    <TableCell>{change.actionName}</TableCell>
                    <TableCell>{APPS[change.app].name}</TableCell>
                    <TableCell className="text-faint font-mono">{from(change)}</TableCell>
                    <TableCell className="font-mono">{describe(change.next.chord)}</TableCell>
                    <TableCell>
                      <Outcome outcome={change.outcome} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {entry.links.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {entry.links.map((link) => (
                <li key={link.actionId}>
                  {link.actionName} — {link.linked ? 'linked' : 'unlinked'}
                </li>
              ))}
            </ul>
          )}

          {failed.length > 0 && (
            <ul className="text-destructive list-disc space-y-0.5 pl-5 text-xs">
              {failed.map((app) => (
                <li key={app.app}>
                  <strong className="font-medium">{app.name}</strong> — {app.error}
                </li>
              ))}
            </ul>
          )}

          {entry.kind === 'save' && entry.error && (
            <p className="text-destructive text-xs">
              The save itself failed: {entry.error}. unikeys could not confirm what, if anything,
              reached your config files.
            </p>
          )}

          <div className="text-muted-foreground space-y-1 text-xs empty:hidden">
            {unseen > 0 && (
              <p>
                {count(unseen, 'binding')} had no earlier value in unikeys, so reverting leaves{' '}
                {unseen === 1 ? 'it' : 'them'} alone.
              </p>
            )}
            {superseded > 0 && (
              <p>{count(superseded, 'binding')} has changed again since this save.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const OUTCOME_LABELS: Record<SaveOutcome, string> = {
  written: 'written',
  settled: 'not needed',
  unsupported: 'unsupported',
  unreadable: 'unreadable',
  failed: 'not written'
}

function Outcome({ outcome }: { outcome: SaveOutcome }): React.JSX.Element {
  return (
    <Badge variant={isSettled(outcome) ? 'outline' : 'destructive'} className="font-normal">
      {OUTCOME_LABELS[outcome]}
    </Badge>
  )
}

/**
 * Deliberately not `change.previous?.chord ?? null`: that renders a cell unikeys
 * had never seen identically to one that was deliberately unbound, and only the
 * second of those can be reverted. Saying so here is what keeps the table honest
 * about what the Revert button will actually do.
 */
function from(change: HistoryChange): string {
  if (change.previous === undefined) return 'not set'
  return describe(change.previous.chord)
}

function describe(canonical: string | null): string {
  if (canonical === null) return 'not bound'
  const chord = parseCanonical(canonical)
  return chord ? formatDisplay(chord) : canonical
}

function summary(entry: HistoryEntry): string {
  const parts: string[] = []

  if (entry.kind === 'save') {
    const settled = entry.changes.filter((change) => isSettled(change.outcome))
    if (entry.changes.length > 0) parts.push(count(entry.changes.length, 'change'))

    const apps = [...new Set(settled.map((change) => APPS[change.app].name))]
    if (apps.length > 0) parts.push(apps.join(', '))
  }

  if (entry.links.length > 0) parts.push(count(entry.links.length, 'link'))

  return parts.join(' · ')
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * Today and yesterday are named rather than dated: most of what a user looks up
 * here is recent, and a bare time is quicker to scan than a full date.
 */
function when(at: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  const days = daysAgo(date)
  if (days === 0) return `Today, ${time}`
  if (days === 1) return `Yesterday, ${time}`
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`
}

function daysAgo(date: Date): number {
  const startOf = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return Math.round((startOf(new Date()) - startOf(date)) / 86_400_000)
}

import { useState } from 'react'

import { APPS, type AppId } from '@shared/apps'
import { formatDisplay, parseCanonical, type Chord } from '@shared/chord'
import type { DroppedBinding, ImportResult, WriteResult } from '@shared/ipc'
import type { LinkCandidate, PendingChange, PendingLinkChange } from '@shared/table/reducer'
import type { ImportSummary } from '@shared/table/view'
import { count } from '@shared/text'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'

/**
 * The dialogs.
 *
 * Most are the result of something the user just did — a link that needed a
 * winner, a copy that needs targets, a first-run import, a save — rather than a
 * place they can navigate to, which is why these stayed modal when everything
 * else became a page. Pending changes made the reverse trip: it is a last look
 * at the save you are already reaching for, so it belongs beside that button
 * rather than a page away from it.
 */

/**
 * A dialog that is always open while mounted.
 *
 * The caller decides existence, so `onOpenChange` only ever fires for a
 * dismissal (Escape, the close button, a click outside) and maps straight onto
 * `onClose`.
 */
function Modal({
  title,
  description,
  onClose,
  children,
  footer
}: {
  title: string
  description?: string
  onClose: () => void
  children?: React.ReactNode
  footer: React.ReactNode
}): React.JSX.Element {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : (
            // Radix warns when a dialog has no description; these are titled
            // well enough that a second line would only repeat the heading.
            <DialogDescription className="sr-only">{title}</DialogDescription>
          )}
        </DialogHeader>
        {children}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Choosing a winning chord when linking a divergent row
// ---------------------------------------------------------------------------

/**
 * Linking a row whose apps disagree asks which chord wins. The reducer never
 * picks, because silently choosing would discard the binding the user actually
 * wanted.
 */
export function LinkPrompt({
  actionName,
  candidates,
  onChoose,
  onClose
}: {
  actionName: string
  candidates: LinkCandidate[]
  onChoose: (chord: Chord | null) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <Modal
      title={`Link “${actionName}”`}
      description="These apps currently disagree. Which chord should they all use?"
      onClose={onClose}
      footer={
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <ul className="space-y-2">
        {candidates.map((candidate, i) => (
          <li key={i} className="bg-card flex items-center gap-3 rounded-lg border p-3">
            <span className="flex-1 font-mono text-[13px]">
              {candidate.chord ? formatDisplay(candidate.chord) : 'not bound'}
            </span>
            <span className="text-muted-foreground text-xs">
              {candidate.apps.map((app) => APPS[app].name).join(', ')}
            </span>
            <Button size="sm" onClick={() => onChoose(candidate.chord)}>
              Use this
            </Button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Handing one app's bindings to others
// ---------------------------------------------------------------------------

/**
 * "Make these apps match that one." A copy, not a link: the panel says so
 * outright, because the word on the button the user just pressed is the row
 * feature's word, and the two behave differently the moment the source changes
 * again.
 *
 * The count comes from `plannedCopy`, the same function that performs the copy,
 * so the number on the button is the change that happens rather than an
 * estimate of it. Zero is a real answer — those apps already agree — and the
 * button says so rather than going quietly dead.
 */
export function CopyBindingsPrompt({
  from,
  candidates,
  changeCount,
  onCopy,
  onClose
}: {
  from: AppId
  /** The apps that can receive, in column order. */
  candidates: AppId[]
  changeCount: (to: AppId[]) => number
  onCopy: (to: AppId[]) => void
  onClose: () => void
}): React.JSX.Element {
  const [selected, setSelected] = useState<AppId[]>([])
  const name = APPS[from].name
  const changes = changeCount(selected)

  return (
    <Modal
      title={`Copy ${name}'s keys to other apps`}
      description={`Every app you pick takes ${name}'s chord for each action it can bind. This happens once — later edits to ${name} will not follow.`}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={changes === 0} onClick={() => onCopy(selected)}>
            {selected.length === 0
              ? 'Copy'
              : changes === 0
                ? 'Already matching'
                : `Copy ${count(changes, 'binding')}`}
          </Button>
        </>
      }
    >
      <ul className="space-y-1">
        {candidates.map((app) => (
          <li key={app}>
            <label className="hover:bg-accent flex cursor-pointer items-center gap-3 rounded-lg border p-3">
              <Checkbox
                checked={selected.includes(app)}
                onCheckedChange={(checked) =>
                  setSelected((current) =>
                    checked === true
                      ? [...current, app]
                      : current.filter((chosen) => chosen !== app)
                  )
                }
              />
              <span className="flex-1 text-sm font-medium">{APPS[app].name}</span>
              <span className="text-muted-foreground text-xs">
                {count(changeCount([app]), 'change')}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {/* Said once, here, rather than in the description: nothing is written
          until the user saves, which is the same promise every other edit
          makes and the reason a copy this large is safe to try. */}
      <p className="text-muted-foreground text-xs">
        Copied keys land as pending changes for you to review before saving.
      </p>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// First-run import summary
// ---------------------------------------------------------------------------

export function ImportSummaryPanel({
  summary,
  result,
  onClose
}: {
  summary: ImportSummary
  result: ImportResult
  onClose: () => void
}): React.JSX.Element {
  return (
    <Modal
      title="Imported your keybindings"
      description="Nothing was written to your apps. Start with the highlighted rows."
      onClose={onClose}
      footer={<Button onClick={onClose}>Show me the table</Button>}
    >
      <div className="grid grid-cols-3 gap-3">
        <Stat value={summary.actionsFound} label="actions" />
        <Stat value={result.appsRead} label="apps read" />
        <Stat value={summary.divergentRows} label="rows where your apps disagree" />
      </div>

      {result.appsFailed.length > 0 && (
        <div className="text-destructive text-sm">
          <p>unikeys could not read:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {result.appsFailed.map((failure) => (
              <li key={failure.app}>
                <strong className="font-medium">{failure.name}</strong> — {failure.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  )
}

function Stat({ value, label }: { value: number; label: string }): React.JSX.Element {
  return (
    <div className="bg-card rounded-lg border p-3">
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// What is about to be written
// ---------------------------------------------------------------------------

/**
 * Everything that is about to reach real config files. Shown before saving so
 * the decision is informed rather than a leap of faith.
 *
 * Both ways out of a set of pending changes are here — discard them, or save
 * them — because this is the one place that shows what either would do.
 */
export function PendingChangesPrompt({
  changes,
  linkChanges,
  saving,
  onSave,
  onDiscard,
  onClose
}: {
  changes: PendingChange[]
  linkChanges: PendingLinkChange[]
  saving: boolean
  onSave: () => void
  onDiscard: () => void
  onClose: () => void
}): React.JSX.Element {
  const empty = changes.length === 0 && linkChanges.length === 0

  return (
    <Modal
      title="Pending changes"
      description="Nothing reaches your config files until you save."
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onDiscard} disabled={saving || empty}>
            Discard all
          </Button>
          <Button onClick={onSave} disabled={saving || empty}>
            {saving ? 'Saving…' : 'Save to apps'}
          </Button>
        </>
      }
    >
      {empty ? (
        // Reachable only if the changes go away underneath an open dialog — a
        // revert of the last edit, say — but then it is the honest thing to say.
        <p className="text-muted-foreground text-sm">Nothing has changed since the last save.</p>
      ) : (
        <div className="space-y-6">
          {changes.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>App</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {changes.map((change) => (
                  <TableRow key={`${change.actionId}:${change.app}`}>
                    <TableCell>{change.actionName}</TableCell>
                    <TableCell>{APPS[change.app].name}</TableCell>
                    <TableCell className="text-faint font-mono">
                      {describeChord(change.previous?.chord ?? null)}
                    </TableCell>
                    <TableCell className="text-pending font-mono">
                      {describeChord(change.next.chord)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {linkChanges.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {linkChanges.map((change) => (
                <li key={change.actionId}>
                  {change.actionName} — {change.linked ? 'linked' : 'unlinked'}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  )
}

function describeChord(canonical: string | null): string {
  if (canonical === null) return 'not bound'
  const chord = parseCanonical(canonical)
  return chord ? formatDisplay(chord) : canonical
}

// ---------------------------------------------------------------------------
// What a save actually did
// ---------------------------------------------------------------------------

/**
 * One line per app and reason rather than one per binding. A save that touches
 * ten linked rows drops ten bindings for an app the user does not have, and
 * listing each of them by raw action id buries the one thing worth reading.
 */
function groupDropped(
  dropped: readonly DroppedBinding[]
): Array<{ key: string; app: AppId; reason: string; actionIds: string[] }> {
  const groups = new Map<string, { key: string; app: AppId; reason: string; actionIds: string[] }>()
  for (const drop of dropped) {
    const key = `${drop.app}\u0000${drop.reason}`
    const group = groups.get(key) ?? { key, app: drop.app, reason: drop.reason, actionIds: [] }
    group.actionIds.push(drop.actionId)
    groups.set(key, group)
  }
  return [...groups.values()]
}

export function WriteReport({
  result,
  onClose
}: {
  result: WriteResult
  onClose: () => void
}): React.JSX.Element {
  const partial = result.failed.length > 0 && result.written.length > 0

  return (
    <Modal
      title={partial ? 'Saved, but not everywhere' : 'Saved'}
      onClose={onClose}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="space-y-4 text-sm">
        {result.written.length > 0 && (
          <section>
            <p>Written:</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {result.written.map((app) => (
                <li key={app.app}>
                  <strong className="font-medium">{app.name}</strong> —{' '}
                  <code className="font-mono text-xs break-all">{app.path}</code>
                  {app.backupPath && (
                    <div className="text-muted-foreground text-xs">
                      Backed up to <code className="font-mono break-all">{app.backupPath}</code>
                    </div>
                  )}
                  <div className="text-muted-foreground text-xs">{app.reloadHint}</div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {result.failed.length > 0 && (
          <section className="text-destructive">
            <p>Not written:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {result.failed.map((app) => (
                <li key={app.app}>
                  <strong className="font-medium">{app.name}</strong> — {app.error}
                </li>
              ))}
            </ul>
          </section>
        )}

        {result.skipped.length > 0 && (
          <section className="text-destructive">
            <p>Chords these apps cannot express, so they were not written:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {result.skipped.map((skip, i) => (
                <li key={i}>
                  <strong className="font-medium">{APPS[skip.app].name}</strong> — {skip.actionId}:{' '}
                  {skip.reason}
                </li>
              ))}
            </ul>
          </section>
        )}

        {result.dropped.length > 0 && (
          // Not styled as a failure: a deliberate drop is unikeys doing the right
          // thing — an app is turned off, or is not installed. Only the
          // non-deliberate ones are worth alarming the user about, and those are
          // rare enough not to warrant a second list.
          <section
            className={
              result.dropped.some((drop) => !drop.deliberate)
                ? 'text-destructive'
                : 'text-muted-foreground'
            }
          >
            <p>Not attempted:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {groupDropped(result.dropped).map((group) => (
                <li key={group.key}>
                  <strong className="font-medium">{APPS[group.app].name}</strong>
                  {group.actionIds.length === 1 ? ` — ${group.actionIds[0]}` : ''}: {group.reason}
                  {group.actionIds.length > 1 && ` (${group.actionIds.length} bindings)`}
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="text-muted-foreground text-xs">
          Backups live in <code className="font-mono break-all">{result.backupDirectory}</code>
        </p>
      </div>
    </Modal>
  )
}

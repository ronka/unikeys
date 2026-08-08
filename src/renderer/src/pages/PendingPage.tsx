import { APPS } from '@shared/apps'
import { formatDisplay, parseCanonical } from '@shared/chord'
import type { PendingChange, PendingLinkChange } from '@shared/table/reducer'

import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { PageHeader } from './PageHeader'

interface Props {
  changes: PendingChange[]
  linkChanges: PendingLinkChange[]
  saving: boolean
  onSave: () => void
  onDiscard: () => void
}

/**
 * Everything that is about to be written to real config files. Shown before
 * saving so the decision is informed rather than a leap of faith.
 */
export function PendingPage({
  changes,
  linkChanges,
  saving,
  onSave,
  onDiscard
}: Props): React.JSX.Element {
  const empty = changes.length === 0 && linkChanges.length === 0

  return (
    <>
      <PageHeader
        title="Pending changes"
        description="Nothing reaches your config files until you save."
        actions={
          <>
            <Button size="sm" variant="outline" onClick={onDiscard} disabled={saving || empty}>
              Discard all
            </Button>
            <Button size="sm" onClick={onSave} disabled={saving || empty}>
              {saving ? 'Saving…' : 'Save to apps'}
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        {empty ? (
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
                        {describe(change.previous?.chord ?? null)}
                      </TableCell>
                      <TableCell className="text-pending font-mono">
                        {describe(change.next.chord)}
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
      </div>
    </>
  )
}

function describe(canonical: string | null): string {
  if (canonical === null) return 'not bound'
  const chord = parseCanonical(canonical)
  return chord ? formatDisplay(chord) : canonical
}

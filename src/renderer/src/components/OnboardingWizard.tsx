import { useEffect, useRef, useState } from 'react'

import { APP_IDS, APPS, CATEGORY_IDS, CATEGORY_LABELS, type AppId } from '@shared/apps'
import type { AppStatus, GrantOutcome, ImportResult } from '@shared/ipc'
import { accessQueue } from '@shared/onboarding'
import type { Store } from '@shared/store/types'
import type { ImportSummary } from '@shared/table/view'
import { count } from '@shared/text'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ImportSummaryBody, Modal } from './Panels'

/** The wizard's position in its flow. */
type Step = 'pick' | 'access' | 'results'

/**
 * The first-run onboarding wizard.
 *
 * Rendered inside the shared `Modal` rather than its own dialog, so it can
 * never stack on top of another Radix dialog. `onComplete` is the only way the
 * wizard counts as finished; `onDismiss` (Escape, click outside) just closes
 * it, and the gate brings it back on the next launch.
 */
export function OnboardingWizard({
  statuses,
  store,
  sandboxed,
  summary,
  result,
  onSetAppEnabled,
  onGrant,
  onChoosePath,
  onReimport,
  onComplete,
  onDismiss
}: {
  statuses: AppStatus[]
  store: Store
  /** True only in the App Store build, where folders have to be granted. */
  sandboxed: boolean
  summary: ImportSummary
  /** The last import's result, which the results step refreshes and shows. */
  result: ImportResult | null
  onSetAppEnabled: (app: AppId, enabled: boolean) => void
  onGrant: (app: AppId, at?: string) => Promise<GrantOutcome>
  onChoosePath: (app: AppId) => Promise<string | null>
  onReimport: () => Promise<void>
  onComplete: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const [step, setStep] = useState<Step>('pick')
  // Seeded once from the saved flags — on a fresh store that is the installed
  // apps (`seedUnknownApps`), on a replay it is whatever the user has now.
  // Held locally until Continue, so backing out of the wizard changes nothing.
  const [selected, setSelected] = useState<ReadonlySet<AppId>>(
    () => new Set(APP_IDS.filter((app) => store.apps[app].enabled))
  )
  /**
   * Frozen when the picker is left, not derived: granting an app changes its
   * status, and a live queue would reshuffle under the user mid-walk.
   */
  const [queue, setQueue] = useState<AppId[]>([])
  const [queueIndex, setQueueIndex] = useState(0)
  /** Why the current app's picker was refused, shown inline until retried. */
  const [stepError, setStepError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  // A ref rather than state: StrictMode double-invokes effects, and the second
  // run must see the first one's claim immediately or the import runs twice.
  const reimported = useRef(false)

  useEffect(() => {
    if (step !== 'results' || reimported.current) return
    reimported.current = true
    setImporting(true)
    onReimport()
      .catch((cause: Error) => setImportError(`Could not read your apps: ${cause.message}`))
      .finally(() => setImporting(false))
  }, [step, onReimport])

  const byId = new Map(statuses.map((status) => [status.app, status]))

  if (step === 'pick') {
    return (
      <Modal
        title="Welcome to unikeys"
        description="Pick the apps you use. unikeys reads their keybindings into one table, so you can see where they disagree and settle them from one place."
        onClose={onDismiss}
        footer={
          <>
            {/* The quiet way out: everything the wizard does can be done later
                from the Apps page, so skipping is allowed to count as done. */}
            <Button variant="ghost" onClick={onComplete}>
              Skip setup
            </Button>
            <Button
              disabled={selected.size === 0}
              onClick={() => {
                // Only the changes: re-dispatching an unchanged flag would
                // still be harmless, but the diff keeps the store history
                // honest about what the user actually did here.
                for (const app of APP_IDS) {
                  const want = selected.has(app)
                  if (want !== store.apps[app].enabled) onSetAppEnabled(app, want)
                }
                const next = accessQueue(statuses, selected, sandboxed)
                setQueue(next)
                setQueueIndex(0)
                setStepError(null)
                // Nothing to ask for — a replay with grants in place, or a dmg
                // build whose configs all resolved — goes straight to results.
                setStep(next.length === 0 ? 'results' : 'access')
              }}
            >
              Continue
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {CATEGORY_IDS.map((category) => (
            <section key={category}>
              <h3 className="text-muted-foreground mb-1.5 text-xs font-medium tracking-wide uppercase">
                {CATEGORY_LABELS[category]}
              </h3>
              <ul className="space-y-1">
                {APP_IDS.filter((app) => APPS[app].category === category).map((app) => (
                  <li key={app}>
                    <label className="hover:bg-accent flex cursor-pointer items-center gap-3 rounded-lg border p-2.5">
                      <Checkbox
                        checked={selected.has(app)}
                        onCheckedChange={(checked) =>
                          setSelected((current) => {
                            const next = new Set(current)
                            if (checked === true) next.add(app)
                            else next.delete(app)
                            return next
                          })
                        }
                      />
                      <span className="flex-1 text-sm font-medium">{APPS[app].name}</span>
                      {/* Still selectable: under the sandbox unikeys cannot
                          always see an install, so "not installed" is a hint,
                          not a verdict. */}
                      {byId.get(app)?.health === 'not-installed' && (
                        <span className="text-faint text-xs">not installed</span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Modal>
    )
  }

  if (step === 'access') {
    const app = queue[queueIndex]
    const status = byId.get(app)

    const advance = (): void => {
      setStepError(null)
      if (queueIndex + 1 >= queue.length) setStep('results')
      else setQueueIndex(queueIndex + 1)
    }

    const request = (): void => {
      setStepError(null)
      if (sandboxed) {
        void onGrant(app, status?.grantPath).then((outcome) => {
          if (outcome.ok) advance()
          // A cancelled picker is the user deciding not to — they still have
          // Skip, so staying silently is the whole response.
          else if (!outcome.cancelled) setStepError(outcome.error)
        })
      } else {
        void onChoosePath(app).then((path) => {
          if (path !== null) advance()
        })
      }
    }

    return (
      <Modal
        title={sandboxed ? 'Let unikeys read your configs' : 'Point unikeys at your configs'}
        description={
          sandboxed
            ? 'The Mac App Store build needs your permission for each folder it reads. One native panel per app — just press Grant in each.'
            : 'A few apps keep their config somewhere unikeys could not find on its own.'
        }
        onClose={onDismiss}
        footer={
          <>
            <Button variant="ghost" onClick={advance}>
              Skip
            </Button>
            <Button onClick={request}>{sandboxed ? 'Grant access…' : 'Choose config…'}</Button>
          </>
        }
      >
        <div className="space-y-2">
          <p className="text-faint text-xs">
            App {queueIndex + 1} of {queue.length}
          </p>
          <p className="text-sm font-semibold">{APPS[app].name}</p>
          {status?.message && <p className="text-muted-foreground text-sm">{status.message}</p>}
          {stepError && <p className="text-destructive text-sm">{stepError}</p>}
        </div>
      </Modal>
    )
  }

  // The results step. Judged from live statuses rather than a skip counter, so
  // it also covers an app whose grant landed but whose config still failed.
  const remaining = accessQueue(statuses, selected, sandboxed)

  return (
    <Modal
      title="You're set up"
      description="unikeys read the apps you picked. Nothing was written to them."
      onClose={onDismiss}
      footer={<Button onClick={onComplete}>Done</Button>}
    >
      {importing ? (
        <p className="text-muted-foreground text-sm">Reading your keybindings…</p>
      ) : (
        <>
          {importError && <p className="text-destructive text-sm">{importError}</p>}
          {result && <ImportSummaryBody summary={summary} result={result} />}
          {remaining.length > 0 && (
            <p className="text-muted-foreground text-sm">
              {count(remaining.length, 'app')} still {remaining.length === 1 ? 'needs' : 'need'}{' '}
              access — you can grant it any time from the Apps page.
            </p>
          )}
        </>
      )}
    </Modal>
  )
}

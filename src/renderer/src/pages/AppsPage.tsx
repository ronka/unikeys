import { APP_IDS, type AppId } from '@shared/apps'
import type { AppHealth, AppStatus } from '@shared/ipc'
import type { Store } from '@shared/store/types'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { PageHeader } from './PageHeader'

interface Props {
  statuses: AppStatus[]
  store: Store
  onToggle: (app: AppId, enabled: boolean) => void
  onChoosePath: (app: AppId) => void
  onClearPath: (app: AppId) => void
}

/**
 * Health is deliberately spelled out rather than collapsed to "no bindings":
 * a config unikeys could not find and one it could not parse are different
 * problems with different fixes, and confusing either with an app that simply
 * has nothing bound would send the user looking in the wrong place.
 */
const HEALTH_LABELS: Record<AppHealth, string> = {
  ok: 'Ready',
  disabled: 'Turned off',
  'not-installed': 'Not installed',
  'config-not-found': 'Config not found',
  'config-unreadable': 'Config unreadable',
  'config-unparseable': 'Config could not be parsed'
}

/**
 * Only `ok` is good news and only a config unikeys found but could not use is
 * bad news. "Not installed" and "turned off" are ordinary states of a machine
 * that does not run all five apps, so they stay neutral.
 */
function healthTone(health: AppHealth): string {
  if (health === 'ok') return 'text-agree border-agree/40'
  if (health === 'disabled' || health === 'not-installed') return 'text-muted-foreground'
  return 'text-destructive border-destructive/40'
}

export function AppsPage({
  statuses,
  store,
  onToggle,
  onChoosePath,
  onClearPath
}: Props): React.JSX.Element {
  const byId = new Map(statuses.map((s) => [s.app, s]))

  return (
    <>
      <PageHeader
        title="Apps"
        description="Which apps unikeys reads and writes, and where their config lives."
      />

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <ul className="space-y-3">
          {APP_IDS.map((app) => {
            const status = byId.get(app)
            if (!status) return null
            const config = store.apps[app]

            return (
              <li key={app} className="bg-card rounded-lg border p-4">
                <div className="flex items-center gap-3">
                  <Checkbox
                    id={`app-${app}`}
                    checked={config.enabled}
                    onCheckedChange={(checked) => onToggle(app, checked === true)}
                  />
                  <Label htmlFor={`app-${app}`} className="text-sm font-medium">
                    {status.name}
                  </Label>
                  <span className="flex-1" />
                  <Badge variant="outline" className={healthTone(status.health)}>
                    {HEALTH_LABELS[status.health]}
                  </Badge>
                </div>

                <p className="text-muted-foreground mt-2 font-mono text-xs break-all">
                  {status.resolvedPath ?? (
                    <span className="text-faint">
                      Looked in: {status.searchedPaths.join(', ') || 'nowhere'}
                    </span>
                  )}
                </p>

                {status.message && <p className="mt-2 text-xs">{status.message}</p>}

                {status.problems.length > 0 && (
                  <details className="mt-2 text-xs">
                    <summary className="text-muted-foreground cursor-pointer">
                      {status.problems.length} line
                      {status.problems.length === 1 ? '' : 's'} unikeys could not read
                    </summary>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono">
                      {status.problems.map((problem, i) => (
                        <li key={i}>{problem}</li>
                      ))}
                    </ul>
                  </details>
                )}

                {status.defaultsAvailability !== 'complete' && status.defaultsNote && (
                  <p className="text-muted-foreground mt-2 text-xs">
                    <strong className="text-foreground font-medium">Defaults:</strong>{' '}
                    {status.defaultsNote}
                  </p>
                )}

                <div className="mt-3 flex gap-2">
                  <Button size="xs" variant="outline" onClick={() => onChoosePath(app)}>
                    Choose config manually…
                  </Button>
                  {config.configPath && (
                    <Button size="xs" variant="ghost" onClick={() => onClearPath(app)}>
                      Use standard location
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </>
  )
}

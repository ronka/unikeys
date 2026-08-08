import { FolderOpen } from 'lucide-react'

import { APP_IDS, type AppId } from '@shared/apps'
import type { AppHealth, AppStatus } from '@shared/ipc'
import type { Store } from '@shared/store/types'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
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
function healthTone(health: AppHealth): { text: string; dot: string; message: string } {
  if (health === 'ok')
    return { text: 'text-agree', dot: 'bg-agree', message: 'text-muted-foreground' }
  if (health === 'disabled' || health === 'not-installed')
    return { text: 'text-faint', dot: 'bg-faint', message: 'text-muted-foreground' }
  // The explanation of a config unikeys could not use is the one message worth
  // full contrast — it is the only one that asks the user to do something.
  return { text: 'text-destructive', dot: 'bg-destructive', message: 'text-foreground' }
}

/**
 * Config paths are the payload of this page, so they are never truncated — but
 * every one of them starts with the same home directory, which is width spent
 * on nothing. macOS-only, hence the hardcoded `/Users/<name>` shape.
 */
function shortenHome(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~')
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
        <ul className="max-w-3xl space-y-2">
          {APP_IDS.map((app) => {
            const status = byId.get(app)
            if (!status) return null
            const config = store.apps[app]
            const tone = healthTone(status.health)

            return (
              <li
                key={app}
                data-enabled={config.enabled}
                className="group bg-card rounded-lg border data-[enabled=false]:bg-transparent"
              >
                <div className="flex items-start gap-3 p-3.5">
                  {/* The toggle keeps full contrast on a disabled card: fading
                      the one control that brings the app back is hostile. */}
                  <Switch
                    id={`app-${app}`}
                    checked={config.enabled}
                    onCheckedChange={(checked) => onToggle(app, checked)}
                    className="mt-0.5"
                  />

                  <div className="min-w-0 flex-1 group-data-[enabled=false]:opacity-55">
                    <div className="flex items-baseline gap-2">
                      <Label htmlFor={`app-${app}`} className="text-sm font-semibold">
                        {status.name}
                      </Label>
                      <span
                        className={`flex items-center gap-1.5 text-xs ${tone.text}`}
                        title={status.message}
                      >
                        <span className={`size-1.5 rounded-full ${tone.dot}`} aria-hidden />
                        {HEALTH_LABELS[status.health]}
                      </span>
                      {status.health === 'ok' && (
                        <span className="text-faint text-xs">
                          {status.userBindingCount} binding
                          {status.userBindingCount === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>

                    <ConfigPath status={status} />

                    {status.message && status.health !== 'disabled' && (
                      <p className={`mt-2 text-xs ${tone.message}`}>{status.message}</p>
                    )}

                    {status.problems.length > 0 && (
                      <Disclosure
                        summary={`${status.problems.length} line${
                          status.problems.length === 1 ? '' : 's'
                        } unikeys could not read`}
                      >
                        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 font-mono">
                          {status.problems.map((problem, i) => (
                            <li key={i}>{problem}</li>
                          ))}
                        </ul>
                      </Disclosure>
                    )}

                    {/* Folded away because it is long, identical across every
                        app sharing a format, and answers a question the user
                        only asks once. */}
                    {status.defaultsAvailability !== 'complete' && status.defaultsNote && (
                      <Disclosure summary="Why some defaults are missing">
                        <p className="mt-1.5">{status.defaultsNote}</p>
                      </Disclosure>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1 group-data-[enabled=false]:opacity-55">
                    {config.configPath && (
                      <Button size="xs" variant="ghost" onClick={() => onClearPath(app)}>
                        Reset location
                      </Button>
                    )}
                    <Button size="xs" variant="ghost" onClick={() => onChoosePath(app)}>
                      <FolderOpen />
                      Choose config
                    </Button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </>
  )
}

/**
 * A resolved path and a list of places unikeys looked are different claims, and
 * "Looked in" attached to a merely turned-off app would read as a failed search
 * rather than as an app nobody asked unikeys to read.
 */
function ConfigPath({ status }: { status: AppStatus }): React.JSX.Element {
  if (status.resolvedPath) {
    return (
      <p className="text-muted-foreground mt-1 font-mono text-xs break-all">
        {shortenHome(status.resolvedPath)}
        {status.overridePath && <span className="text-faint"> · chosen by hand</span>}
      </p>
    )
  }

  const label = status.health === 'disabled' ? 'Standard location' : 'Looked in'

  return (
    <p className="text-faint mt-1 font-mono text-xs break-all">
      <span className="font-sans">{label}: </span>
      {status.searchedPaths.map(shortenHome).join(', ') || 'nowhere'}
    </p>
  )
}

function Disclosure({
  summary,
  children
}: {
  summary: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <details className="text-muted-foreground group/d mt-2 text-xs">
      <summary className="hover:text-foreground w-fit cursor-pointer list-none select-none">
        <span className="mr-1 inline-block transition-transform group-open/d:rotate-90">›</span>
        {summary}
      </summary>
      {children}
    </details>
  )
}

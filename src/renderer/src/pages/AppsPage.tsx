import { useState } from 'react'
import { FolderKey, FolderOpen } from 'lucide-react'

import { APP_IDS, APPS, CATEGORY_IDS, CATEGORY_LABELS, type AppId } from '@shared/apps'
import { isHealthProblem, type AppHealth, type AppStatus } from '@shared/ipc'
import type { AppConfig, Store } from '@shared/store/types'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from './PageHeader'

interface Props {
  statuses: AppStatus[]
  store: Store
  onToggle: (app: AppId, enabled: boolean) => void
  onChoosePath: (app: AppId) => void
  onClearPath: (app: AppId) => void
  /** True only in the App Store build, where folders have to be granted. */
  sandboxed: boolean
  /** Why the last grant attempt was refused, per app. */
  grantErrors: Partial<Record<AppId, string>>
  onGrant: (app: AppId, at?: string) => void
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
  'config-not-created': 'Not created yet',
  'config-not-found': 'Config not found',
  'config-path-required': 'Needs a config path',
  'grant-required': 'Needs access',
  'config-unreadable': 'Config unreadable',
  'config-unparseable': 'Config could not be parsed'
}

/**
 * Only `ok` is good news and only a config unikeys found but could not use is
 * bad news. "Not installed" and "turned off" are ordinary states of a machine
 * that does not run every app, so they stay neutral — and so is a config that
 * does not exist yet, which unikeys creates on the first save rather than
 * asking the user to go and make, and so is an app that simply has no standard
 * config location for unikeys to have found.
 */
function healthTone(health: AppHealth): { text: string; dot: string; message: string } {
  if (health === 'ok')
    return { text: 'text-agree', dot: 'bg-agree', message: 'text-muted-foreground' }
  // The explanation of a config unikeys could not use is the one message worth
  // full contrast — it is the only one that asks the user to do something. The
  // same predicate decides the table's unreadable banner, so a card and the
  // banner can never describe the same app differently.
  if (isHealthProblem(health))
    return { text: 'text-destructive', dot: 'bg-destructive', message: 'text-foreground' }
  return { text: 'text-faint', dot: 'bg-faint', message: 'text-muted-foreground' }
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
  onClearPath,
  sandboxed,
  grantErrors,
  onGrant
}: Props): React.JSX.Element {
  // Local, not the App-level `search` the table uses: one box per page keeps
  // typing here from quietly filtering the Keys table behind the user's back.
  const [search, setSearch] = useState('')

  // Statuses arrive from the main process keyed by app, but `APP_IDS` stays the
  // authority on order — the same order as the table's columns.
  const trimmed = search.trim()
  const byId = new Map(statuses.map((status) => [status.app, status]))
  const visible = APP_IDS.flatMap((app) => {
    const status = byId.get(app)
    return status && matchesSearch(app, trimmed) ? [status] : []
  })

  return (
    <>
      <PageHeader
        title="Apps"
        description="Which apps unikeys reads and writes, and where their config lives."
        actions={
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search apps…"
            aria-label="Search apps"
            className="h-8 w-56"
          />
        }
      />

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <div className="max-w-3xl space-y-6">
          {CATEGORY_IDS.map((category) => {
            const group = visible.filter((status) => APPS[status.app].category === category)
            // A heading over nothing reads as a category that broke rather than
            // one the search excluded, so an empty group disappears entirely.
            if (group.length === 0) return null

            return (
              <section key={category}>
                <h2 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
                  {CATEGORY_LABELS[category]}
                </h2>
                <ul className="space-y-2">
                  {group.map((status) => (
                    <AppRow
                      key={status.app}
                      status={status}
                      config={store.apps[status.app]}
                      onToggle={onToggle}
                      onChoosePath={onChoosePath}
                      onClearPath={onClearPath}
                      sandboxed={sandboxed}
                      grantError={grantErrors[status.app]}
                      onGrant={onGrant}
                    />
                  ))}
                </ul>
              </section>
            )
          })}

          {/* Gated on the query: statuses arrive after mount, and an unsearched
              page that has not loaded yet has not failed to match anything. */}
          {trimmed.length > 0 && visible.length === 0 && (
            <p className="text-muted-foreground text-sm">No app matches “{trimmed}”.</p>
          )}

          <RequestApp />
        </div>
      </div>
    </>
  )
}

/**
 * Search covers the group headings as well as the app names: now that
 * "Terminals" is a word on this page, it is a word a user will type at the box
 * beside it. Both the label and the id, since neither is more obviously the
 * name of a group.
 */
function matchesSearch(app: AppId, query: string): boolean {
  const { name, category } = APPS[app]
  return `${name} ${category} ${CATEGORY_LABELS[category]}`
    .toLowerCase()
    .includes(query.toLowerCase())
}

/**
 * Takes the whole `AppConfig` rather than the two booleans it reads from it:
 * which parts of an app's configuration the row chooses to show is the row's
 * business, and deciding that at the call site is what turns a page into a prop
 * list that grows every time the row learns something new.
 */
function AppRow({
  status,
  config,
  onToggle,
  onChoosePath,
  onClearPath,
  sandboxed,
  grantError,
  onGrant
}: {
  status: AppStatus
  config: AppConfig
  onToggle: (app: AppId, enabled: boolean) => void
  onChoosePath: (app: AppId) => void
  onClearPath: (app: AppId) => void
  sandboxed: boolean
  grantError?: string
  onGrant: (app: AppId, at?: string) => void
}): React.JSX.Element {
  const app = status.app
  const tone = healthTone(status.health)
  // Offered whenever the build can grant at all, not only when a grant is
  // missing: a user who has moved their config wants to re-point unikeys at it
  // without having to break the current grant first to make the button appear.
  // `grantPath` is absent outside the sandbox and for an app with nothing to
  // ask for yet, which is exactly when the button should not exist.
  const canGrant = sandboxed && status.grantPath !== undefined
  const needsGrant = status.health === 'grant-required'
  // Labelled by whether a grant exists, not by whether one is being asked for.
  // Keying it on health called the button "Change access" on an app that had
  // never been granted anything — every turned-off app on a first run — which
  // claims a permission the user has not given.
  const grantLabel = Object.keys(config.grants).length === 0 ? 'Grant access…' : 'Change access'

  return (
    <li
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

          {/* The refusal sits under the message rather than replacing it: the
              message says which folder unikeys needs, and that is exactly what
              a user who just picked the wrong one has to be told again. */}
          {grantError && <p className="text-destructive mt-2 text-xs">{grantError}</p>}

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
          {canGrant && (
            // The primary action while access is missing, because it is the one
            // thing standing between the user and a working column — and a
            // quiet one once granted, since re-granting is the rare case.
            <Button
              size="xs"
              variant={needsGrant ? 'default' : 'ghost'}
              onClick={() => onGrant(app, status.grantPath)}
            >
              <FolderKey />
              {grantLabel}
            </Button>
          )}
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
}

/**
 * The Google Form that collects app requests, and the field id of its first
 * question ("App name"), read off the live form. Prefilling that one field is
 * what lets the request start here rather than making the user retype in the
 * browser what they already typed in the app — the form's other questions are
 * optional or answered better there.
 */
const REQUEST_FORM =
  'https://docs.google.com/forms/d/e/1FAIpQLSd8f3mwIIL_xr3sUwpwPv5M94Nq-X7_tD4ZBfN_m2DwpMDXcQ/viewform'
const REQUEST_FORM_APP_FIELD = 'entry.812083450'

/**
 * The supported list is short and closed, so the question it raises — "why
 * isn't my editor here?" — needs somewhere to go. `window.open` is caught by
 * the main process's window-open handler, which hands the URL to the real
 * browser; the form is not something to render inside unikeys.
 */
function RequestApp(): React.JSX.Element {
  const [name, setName] = useState('')

  return (
    <section className="border-t pt-5">
      <h2 className="text-sm font-semibold">Missing an app?</h2>
      <p className="text-muted-foreground mt-0.5 text-xs">
        Tell us which one and we&apos;ll look at adding support for it. This opens a short form in
        your browser with the name filled in.
      </p>
      <form
        className="mt-2.5 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const url = `${REQUEST_FORM}?usp=pp_url&${REQUEST_FORM_APP_FIELD}=${encodeURIComponent(name.trim())}`
          window.open(url, '_blank')
          setName('')
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          // Zed and Warp used to be the examples here. They are columns now, so
          // suggesting them invites a request for something already shipped.
          placeholder="e.g. Sublime Text, Neovim, Alacritty…"
          aria-label="App to request"
          className="h-8 max-w-xs"
        />
        <Button type="submit" size="sm" variant="outline" disabled={name.trim().length === 0}>
          Request
        </Button>
      </form>
    </section>
  )
}

/**
 * A resolved path, a path unikeys is about to create, and a list of places it
 * looked are three different claims. "Looked in" attached to a merely turned-off
 * app would read as a failed search rather than as an app nobody asked unikeys
 * to read — and attached to a file unikeys is going to write, it invites the
 * user to go and create that file by hand, which is the whole problem.
 *
 * An app with no standard location is a fourth claim, and the only honest thing
 * to say about it is nothing: there was no search, so "Looked in: nowhere"
 * under a message that has just asked the user to choose a path reads as a
 * failure report and undercuts it.
 */
function ConfigPath({ status }: { status: AppStatus }): React.JSX.Element | null {
  if (status.health === 'config-path-required') return null

  // A fifth claim, and the same reasoning: unikeys has not looked, so "Looked
  // in" would be a lie about a search the sandbox never let it run — and the
  // message beside it has already named the one folder that matters.
  if (status.health === 'grant-required') return null

  if (status.resolvedPath) {
    return (
      <p className="text-muted-foreground mt-1 font-mono text-xs break-all">
        {shortenHome(status.resolvedPath)}
        {status.overridePath && <span className="text-faint"> · chosen by hand</span>}
      </p>
    )
  }

  if (status.plannedPath) {
    return (
      <p className="text-faint mt-1 font-mono text-xs break-all">
        <span className="font-sans">Will be created at: </span>
        {shortenHome(status.plannedPath)}
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

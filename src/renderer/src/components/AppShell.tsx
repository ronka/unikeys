import { useEffect } from 'react'
import { AppWindow, History, Keyboard, ListChecks, Settings } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  SIDEBAR_STORAGE_KEY,
  useSidebar
} from '@/components/ui/sidebar'

/** The pages reachable from the sidebar. */
export type View = 'keys' | 'pending' | 'history' | 'apps' | 'settings'

interface Props {
  page: View
  onNavigate: (page: View) => void
  pendingCount: number
  dirty: boolean
  saving: boolean
  onSave: () => void
  /**
   * True while a chord editor or a modal is open, which suspends ⌘B. See
   * `useSidebarShortcut`.
   */
  shortcutBlocked: boolean
  /**
   * Controls for the current page, rendered in the top strip beside Save. Only
   * the table has any: everything else narrows nothing.
   */
  controls?: React.ReactNode
  banners?: React.ReactNode
  children: React.ReactNode
}

// Pending and History sit either side of the save: what is about to change, and
// what did. Apps follows as the configuration rather than part of that flow.
const NAV: { view: View; label: string; icon: typeof Keyboard }[] = [
  { view: 'keys', label: 'Keys', icon: Keyboard },
  { view: 'pending', label: 'Pending', icon: ListChecks },
  { view: 'history', label: 'History', icon: History },
  { view: 'apps', label: 'Apps', icon: AppWindow }
]

/**
 * The window chrome: a draggable top strip, the sidebar, and the page beside it.
 *
 * The strip runs across both columns at the height of the macOS traffic lights,
 * which now sit inside the web contents rather than in a title bar of their own
 * (see `titleBarStyle` in src/main/index.ts).
 */
export function AppShell({
  page,
  onNavigate,
  pendingCount,
  dirty,
  saving,
  onSave,
  shortcutBlocked,
  controls,
  banners,
  children
}: Props): React.JSX.Element {
  return (
    <SidebarProvider
      // `defaultOpen` is read synchronously so the sidebar renders in its saved
      // state on the first paint rather than flicking open and then shut.
      defaultOpen={localStorage.getItem(SIDEBAR_STORAGE_KEY) !== 'false'}
      // Overrides the provider's own `min-h-svh`: this app owns the viewport
      // exactly, and all scrolling happens inside the page, never on the body.
      className="h-screen min-h-0 overflow-hidden"
      style={{ '--sidebar-width': '240px' } as React.CSSProperties}
    >
      <ShellBody
        page={page}
        onNavigate={onNavigate}
        pendingCount={pendingCount}
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        shortcutBlocked={shortcutBlocked}
        controls={controls}
        banners={banners}
      >
        {children}
      </ShellBody>
    </SidebarProvider>
  )
}

/**
 * Split out purely so it can call `useSidebar`, which throws outside the
 * provider above.
 */
function ShellBody({
  page,
  onNavigate,
  pendingCount,
  dirty,
  saving,
  onSave,
  shortcutBlocked,
  controls,
  banners,
  children
}: Omit<Props, never>): React.JSX.Element {
  const { open, isMobile, toggleSidebar } = useSidebar()
  useSidebarShortcut(toggleSidebar, shortcutBlocked)

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader className="gap-0 p-0">
          {/* Padded clear of the traffic lights, which overlap this row. The
              strip stays rendered when collapsed — empty, since the rail is
              narrower than the traffic lights — so the nav still starts below
              them. */}
          <div className="drag-region flex h-11 shrink-0 items-center pl-(--traffic-light-inset)">
            <SidebarTrigger className="no-drag group-data-[collapsible=icon]:hidden" />
          </div>
          {/* Hidden rather than shrunk when collapsed — there is no app mark to
              fall back to, and a truncated word would just read as noise. */}
          <div className="drag-region flex h-8 items-center px-4 group-data-[collapsible=icon]:hidden">
            <span className="truncate text-sm font-semibold tracking-tight">unikeys</span>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.map(({ view, label, icon: Icon }) => (
                  <SidebarMenuItem key={view}>
                    <SidebarMenuButton
                      isActive={page === view}
                      onClick={() => onNavigate(view)}
                      tooltip={label}
                    >
                      <Icon />
                      <span>{label}</span>
                    </SidebarMenuButton>
                    {view === 'pending' && pendingCount > 0 && (
                      <SidebarMenuBadge className="text-pending">{pendingCount}</SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={page === 'settings'}
                onClick={() => onNavigate('settings')}
                tooltip="Settings"
              >
                <Settings />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      {/* `min-w-0` is load-bearing: a flex item defaults to `min-width: auto`,
          so the keys table — which is deliberately `w-max` and wider than the
          window — would push this pane out and shove the sidebar off-screen
          instead of scrolling inside it. `min-h-0` is the same story for the
          vertical scroll. */}
      <SidebarInset className="min-h-0 min-w-0">
        {/* Both sides match the pages underneath, so the search box, Save and
            everything else in this strip line up with the banners and headings
            below rather than sitting nearer the window edge than anything else
            on screen. The `1.5rem` in the trigger's margin is this padding,
            subtracted by hand — the two have to change together. */}
        <header className="drag-region flex h-11 shrink-0 items-center gap-2 px-6">
          {/* Only when the sidebar's own header is out of reach: expanded it
              carries the trigger itself, and off-canvas on a narrow window it
              is behind a sheet that has to be openable from somewhere. The
              margin lands the button on the same x as the sidebar's copy — past
              the traffic lights — so it stays put as the sidebar collapses:
              inset, less the rail beside it and this header's own padding. */}
          {(!open || isMobile) && (
            <SidebarTrigger
              className="no-drag"
              style={{
                marginLeft: isMobile
                  ? 'calc(var(--traffic-light-inset) - 1.5rem)'
                  : 'calc(var(--traffic-light-inset) - var(--sidebar-width-icon) - 1.5rem)'
              }}
            />
          )}
          {controls}
          <span className="flex-1" />
          {pendingCount > 0 && (
            <span className="text-pending text-xs tabular-nums">{pendingCount} pending</span>
          )}
          <Button
            size="sm"
            className="no-drag"
            onClick={onSave}
            disabled={saving || !dirty}
            aria-label="Save changes"
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </header>

        {banners}

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
      </SidebarInset>
    </>
  )
}

/**
 * ⌘B toggles the sidebar, except while a chord is being recorded or a modal is
 * open.
 *
 * This lives here rather than in the generated sidebar component because ⌘B is
 * itself a bindable chord: ChordInput captures raw keystrokes, so firing the
 * shortcut mid-capture would both swallow the keystroke the user meant to bind
 * and move the cell out from under them. Guarding on state rather than on the
 * event target also covers ChordInput's text mode, which — unlike its capture
 * mode — does not stop propagation.
 */
function useSidebarShortcut(toggle: () => void, blocked: boolean): void {
  useEffect(() => {
    if (blocked) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'b' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        toggle()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggle, blocked])
}

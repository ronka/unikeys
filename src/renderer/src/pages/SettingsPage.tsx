import { useState } from 'react'

import { THEME_SOURCES, type ThemeSource } from '@shared/ipc'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { setTheme, storedTheme } from '@/lib/theme'
import { PageHeader } from './PageHeader'

interface Props {
  backupDirectory: string
  onRevealBackups: () => void
  onReplayOnboarding: () => void
  /** `null` while the consent question has not been answered yet. */
  analyticsEnabled: boolean | null
  onSetAnalytics: (enabled: boolean) => void
}

const THEME_LABELS: Record<ThemeSource, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System'
}

export function SettingsPage({
  backupDirectory,
  onRevealBackups,
  onReplayOnboarding,
  analyticsEnabled,
  onSetAnalytics
}: Props): React.JSX.Element {
  // Seeded from storage rather than held in App: nothing outside this control
  // reads it, because the appearance itself is applied by main.
  const [theme, setThemeState] = useState<ThemeSource>(storedTheme)

  return (
    <>
      <PageHeader title="Settings" />

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <div className="max-w-2xl space-y-8">
          <Section title="Appearance" description="System follows your macOS appearance setting.">
            <div className="flex gap-2">
              {THEME_SOURCES.map((source) => (
                <Button
                  key={source}
                  size="sm"
                  variant={theme === source ? 'default' : 'outline'}
                  onClick={() => {
                    setTheme(source)
                    setThemeState(source)
                  }}
                >
                  {THEME_LABELS[source]}
                </Button>
              ))}
            </div>
          </Section>

          <Section
            title="Backups"
            description="unikeys copies each config file before the first write of a session, so a bad write is always recoverable."
          >
            <p className="text-muted-foreground font-mono text-xs break-all">{backupDirectory}</p>
            <Button size="sm" variant="outline" className="mt-3" onClick={onRevealBackups}>
              Open backups folder
            </Button>
          </Section>

          <Section
            title="Onboarding"
            description="Walk through picking your apps and granting access again."
          >
            <Button size="sm" variant="outline" onClick={onReplayOnboarding}>
              Replay onboarding
            </Button>
          </Section>

          <Section
            title="Anonymous usage"
            description="Counts and outcomes only — which apps you have switched on, and whether setup worked. Your keybindings, your file paths and your folder names never leave your Mac."
          >
            <div className="flex items-center gap-3">
              <Switch
                checked={analyticsEnabled === true}
                onCheckedChange={(checked) => onSetAnalytics(checked === true)}
              />
              <span className="text-sm">
                {analyticsEnabled === true ? 'Sharing anonymous usage' : 'Not sharing'}
              </span>
            </div>
          </Section>
        </div>
      </div>
    </>
  )
}

function Section({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section>
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && <p className="text-muted-foreground mt-1 mb-3 text-xs">{description}</p>}
      {children}
    </section>
  )
}

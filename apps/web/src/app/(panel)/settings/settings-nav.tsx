import { FilterTabs } from '@/components/filter-bar'
import { settingsPages } from '@/components/shell/navigation'
import { useT } from '@/i18n/use-t'

/** The pages of Settings, above each of them; `current` is the path of the page it is on. */
export function SettingsNav({ current }: { current: (typeof settingsPages)[number]['href'] }) {
  const t = useT()
  return <FilterTabs label={t('settings.title')} tabs={settingsPages.map((page) => ({ href: page.href, label: t(page.label), active: page.href === current }))} />
}

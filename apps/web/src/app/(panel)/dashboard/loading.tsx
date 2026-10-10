import { Page } from '@/components/page-layout'
import { Panel } from '@/components/section'
import { Skeleton } from '@/components/ui/skeleton'
import { useT } from '@/i18n/use-t'

function CardSkeleton({ rows }: { rows: number }) {
  return (
    <Panel>
      <div className="border-b border-border px-4 py-3">
        <Skeleton className="h-4 w-36" />
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex h-11 items-center gap-3 px-4">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="ml-auto h-3.5 w-10" />
          </div>
        ))}
      </div>
    </Panel>
  )
}

// The dashboard is cards of rows, two of them side by side: the shared list skeleton (one table) would jump.
export default function DashboardLoading() {
  const t = useT()
  return (
    <Page>
      <p role="status" className="sr-only">
        {t('common.loading')}
      </p>
      <div className="flex min-h-8 flex-col justify-center gap-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-3.5 w-80 max-w-full" />
      </div>
      <CardSkeleton rows={1} />
      <div className="grid gap-5 @3xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <CardSkeleton rows={4} />
        <CardSkeleton rows={3} />
      </div>
      <CardSkeleton rows={5} />
    </Page>
  )
}

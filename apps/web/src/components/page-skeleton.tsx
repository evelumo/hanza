import { Skeleton } from '@/components/ui/skeleton'
import { useT } from '@/i18n/use-t'
import { Page, PageColumns } from './page-layout'
import { Panel } from './section'

function Rows({ count }: { count: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex h-11 items-center gap-6 px-4">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3.5 w-40 max-sm:hidden" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3.5 w-16" />
        </div>
      ))}
    </div>
  )
}

function CardSkeleton({ rows }: { rows: number }) {
  return (
    <Panel>
      <div className="border-b border-border px-4 py-3">
        <Skeleton className="h-4 w-36" />
      </div>
      <Rows count={rows} />
    </Panel>
  )
}

/**
 * What a `loading.tsx` renders: the outline of the page that is on its way, so nothing jumps when it arrives.
 * `list` is a header over one card of rows; `detail` is a header over the two columns of a detail page.
 */
export function PageSkeleton({ variant = 'list' }: { variant?: 'list' | 'detail' }) {
  const t = useT()
  return (
    <Page>
      <p role="status" className="sr-only">
        {t('common.loading')}
      </p>
      <div className="flex min-h-8 items-center justify-between gap-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-8 w-28" />
      </div>
      {variant === 'list' ? (
        <CardSkeleton rows={8} />
      ) : (
        <PageColumns
          aside={
            <>
              <CardSkeleton rows={2} />
              <CardSkeleton rows={3} />
            </>
          }
        >
          <CardSkeleton rows={4} />
          <CardSkeleton rows={3} />
        </PageColumns>
      )}
    </Page>
  )
}

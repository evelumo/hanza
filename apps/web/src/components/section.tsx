import type { ReactNode } from 'react'

export function Section({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {description ? <p className="text-sm text-muted">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="px-5 py-6 text-sm text-muted">{children}</p>
}

export const tableClass = 'w-full text-left text-sm'
export const thClass = 'whitespace-nowrap px-4 py-2.5 font-medium text-muted'
export const tdClass = 'px-4 py-2.5 align-top'
export const rowClass = 'border-t border-line'
export const linkClass = 'font-medium text-accent underline underline-offset-2 hover:text-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'

import type { EventRow } from '@hanza/core'
import { useT } from '@/i18n/use-t'
import { describeEvent, type EventContext, type EventLink } from '@/lib/events'
import type { Formatters } from '@/lib/format'
import { Identifier } from './identifier'
import { orderNumberClass } from './text-link'
import { Timeline, TimelineItem } from './timeline'

// A SKU and an Offer's external id are identifiers; an Order number and a name are set like the text around them.
function linkLabel(link: EventLink) {
  if (!link.identifier) return link.label
  if (link.kind === 'product' || link.kind === 'offer') {
    return (
      <>
        {link.noun} <Identifier wrap>{link.identifier}</Identifier>
      </>
    )
  }
  return link.kind === 'order' ? <span className={orderNumberClass}>{link.label}</span> : link.label
}

/**
 * A list of Events, latest first, as every history in the panel shows them. Each row links to what it is
 * about, except to the page it is on (`current`); `identifiers` are the Order numbers, SKUs and names the page
 * already holds, so the links can say where they lead.
 */
export function EventTimeline({
  events,
  format,
  current,
  identifiers,
  className,
}: {
  events: EventRow[]
  format: Formatters
  current?: EventContext['current']
  identifiers?: EventContext['identifiers']
  className?: string
}) {
  const t = useT()
  return (
    <Timeline className={className}>
      {events.map((event) => {
        const { title, detail, link } = describeEvent(event.type, event.payload, t, format, { subject: event.subject, current, identifiers })
        return (
          <TimelineItem
            key={event.id}
            title={title}
            at={event.createdAt}
            atLabel={format.dateTime(event.createdAt)}
            link={link ? { href: link.href, label: linkLabel(link) } : undefined}
          >
            {/* A detail that is only the subject's name ("North" under "Warehouse added") is what the link already says. */}
            {link && detail === link.identifier ? null : detail}
          </TimelineItem>
        )
      })}
    </Timeline>
  )
}

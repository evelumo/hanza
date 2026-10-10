import { Children, Fragment, type ComponentProps, type ReactNode } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

export { DataTableLinkRow } from './data-table-link-row'

/*
 * The panel's table follows the width of the place it is in (a container query, since tables sit in columns of
 * different widths), not the window's. The rules are in globals.css; these components only mark the cells.
 *
 * - Wide: a table.
 * - Below 56rem (`medium`): still a table, without the columns marked `hide="medium"`. For the wide tables of
 *   list pages only: the main column of a detail page is narrower than that on any screen.
 * - Below 42rem (`narrow`): no header row, and every row is a block: the `narrow="primary"` cell (what the row
 *   is) with the `narrow="end"` cell beside it (its state or its key number), then every other cell on a line
 *   of its own. Cells marked `hide` are gone there too.
 *
 * What a hidden cell said goes into a `DataTableMeta` line under the primary cell, shown exactly while that
 * cell is hidden, so no width (and no screen reader) loses it. Without its column header a cell needs its own
 * label on a narrow container: `narrowLabel`.
 */

type Width = 'narrow' | 'medium'

/**
 * Put it straight into a `Section` or a `Panel`. `align="top"` suits rows whose cells hold forms or several
 * lines: every cell starts at the top and their first lines share one baseline, so text sits level with the
 * text inside a control beside it.
 */
export function DataTable({ align = 'middle', ...props }: Omit<ComponentProps<'table'>, 'align'> & { align?: 'middle' | 'top' }) {
  return <Table {...props} data-align={align} />
}

/** The header row; its children are the `DataTableHead` cells. */
export function DataTableHeader({ children, ...props }: ComponentProps<'thead'>) {
  return (
    <TableHeader {...props}>
      <TableRow>{children}</TableRow>
    </TableHeader>
  )
}

export const DataTableBody = TableBody

export function DataTableRow({ className, ...props }: ComponentProps<'tr'>) {
  return <TableRow {...props} className={cn('hover:bg-muted/60', className)} />
}

/**
 * A column header. `numeric` right-aligns it, to sit over a column of `numeric` cells; `hide` is the same as on
 * the column's cells.
 */
export function DataTableHead({
  numeric = false,
  hide,
  className,
  ...props
}: ComponentProps<'th'> & { numeric?: boolean; hide?: Width }) {
  return <TableHead scope="col" {...props} data-hide={hide} className={cn(numeric && 'text-right', className)} />
}

interface CellLayout {
  /** Not shown while the table is narrower than this; say what it held in a `DataTableMeta`. */
  hide?: Width
  /** Its place in a narrow row: the first line's start (a checkbox), what the row is, or its state or key number at the end. */
  narrow?: 'start' | 'primary' | 'end'
  /** The column's name, shown before the cell where the header row is not. */
  narrowLabel?: string
}

function cellContent(narrowLabel: string | undefined, children: ReactNode): ReactNode {
  if (!narrowLabel) return children
  return (
    <>
      <span data-slot="table-label" data-show="narrow">
        {narrowLabel}
      </span>
      {/* A box of its own only on a narrow container; on a wide one the cell lays its content out as before. */}
      <div data-slot="table-value">{children}</div>
    </>
  )
}

/**
 * The cell that names its row (a Warehouse, a kind of data) when no link does: a header to assistive
 * technology, which reads it out with every other cell of the row, and a cell like the others to the eye.
 */
export function DataTableRowHeader({ hide, narrow, narrowLabel, className, children, ...props }: ComponentProps<'th'> & CellLayout) {
  return (
    <th
      role="rowheader"
      scope="row"
      data-slot="table-cell"
      {...props}
      data-hide={hide}
      data-narrow={narrow}
      className={cn('text-left font-medium', className)}
    >
      {cellContent(narrowLabel, children)}
    </th>
  )
}

/**
 * `numeric`: a quantity or an amount, right-aligned in tabular numerals so the digits line up down the column.
 * `tabular`: tabular numerals without the alignment, for dates.
 */
export function DataTableCell({
  numeric = false,
  tabular = false,
  hide,
  narrow,
  narrowLabel,
  className,
  children,
  ...props
}: ComponentProps<'td'> & CellLayout & { numeric?: boolean; tabular?: boolean }) {
  return (
    <TableCell
      {...props}
      data-hide={hide}
      data-narrow={narrow}
      className={cn(numeric && 'text-right whitespace-nowrap tabular-nums', tabular && 'whitespace-nowrap tabular-nums', className)}
    >
      {cellContent(narrowLabel, children)}
    </TableCell>
  )
}

/**
 * A quiet line under the row's primary cell with what the columns hidden below `below` held, its items
 * (`DataTableMetaItem`, or any node) separated by dots. It is on the page exactly while those columns are not.
 */
export function DataTableMeta({ below = 'narrow', className, children }: { below?: Width; className?: string; children: ReactNode }) {
  const items = Children.toArray(children)
  if (items.length === 0) return null
  return (
    <span data-slot="table-meta" data-show={below} className={className}>
      {items.map((item, index) => (
        <Fragment key={index}>
          {/* The dot stays with the item before it, so a line never starts with one. */}
          {index > 0 ? <span aria-hidden="true">{' · '}</span> : null}
          {item}
        </Fragment>
      ))}
    </span>
  )
}

/**
 * One value in a `DataTableMeta` with the name of the column it came from: shown before it ("Reserved 2"), or
 * with `labelHidden` only read out, for a value that says what it is (a date, a name).
 */
export function DataTableMetaItem({ label, labelHidden = false, children }: { label: string; labelHidden?: boolean; children: ReactNode }) {
  return (
    <span>
      {/* A no-break space: a line never ends between a name and its value. */}
      {labelHidden ? <span className="sr-only">{label}: </span> : <>{label}{'\u00a0'}</>}
      <span className={labelHidden ? undefined : 'text-foreground tabular-nums'}>{children}</span>
    </span>
  )
}

/** Anything that belongs on the page only while the table is narrow or medium (a badge moved under the row's name). */
export function DataTableOnly({ below = 'narrow', className, children }: { below?: Width; className?: string; children: ReactNode }) {
  return (
    <span data-show={below} className={className}>
      {children}
    </span>
  )
}

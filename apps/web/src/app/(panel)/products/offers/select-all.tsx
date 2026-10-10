'use client'

import { useEffect, useRef } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { useT } from '@/i18n/use-t'
import { CREATE_PRODUCTS_FORM_ID } from './form-id'
import { offerBoxes, useOfferSelection } from './use-offer-selection'

/** `labelled={false}` when a visible <label> around it already names it. */
export function SelectAll({ selectableIds, labelled = true }: { selectableIds: readonly string[]; labelled?: boolean }) {
  const t = useT()
  const box = useRef<HTMLInputElement>(null)
  const { selected, selectable } = useOfferSelection(selectableIds)

  // Follows the rows: ticked when all of them are, a dash when only some.
  useEffect(() => {
    if (!box.current) return
    box.current.checked = selectable > 0 && selected === selectable
    box.current.indeterminate = selected > 0 && selected < selectable
  }, [selected, selectable])

  return (
    <Checkbox
      ref={box}
      // Associated with the form (no name, so never submitted) only so that the reset after an action unticks it with the rows.
      form={CREATE_PRODUCTS_FORM_ID}
      aria-label={labelled ? t('offers.selectAll') : undefined}
      disabled={selectable === 0}
      className="block"
      onChange={(event) => {
        for (const row of offerBoxes()) row.checked = event.currentTarget.checked
      }}
    />
  )
}

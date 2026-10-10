'use client'

import { useEffect, useState } from 'react'
import { CREATE_PRODUCTS_FORM_ID } from './form-id'

const boxSelector = `input[type="checkbox"][name="offerIds"][form="${CREATE_PRODUCTS_FORM_ID}"]`

/** The row checkboxes: plain inputs the server renders in the table, tied to the form by their `form` attribute. */
export const offerBoxes = () => [...document.querySelectorAll<HTMLInputElement>(boxSelector)]

/**
 * How many of the row checkboxes are ticked, read from the page because nothing in React owns them.
 * `selectableIds` are the Offers that have a checkbox; a change of them (another page, Offers that got a
 * Product) reads the count again.
 */
export function useOfferSelection(selectableIds: readonly string[]): { selected: number; selectable: number } {
  const rows = selectableIds.join(' ')
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    const read = () => setSelected(offerBoxes().filter((box) => box.checked).length)
    // Also covers ticks the browser restored on reload or back.
    read()
    const onChange = (event: Event) => {
      if (event.target instanceof HTMLInputElement && event.target.getAttribute('form') === CREATE_PRODUCTS_FORM_ID) read()
    }
    // React resets the form after its action; the boxes are unticked only after the event, hence the next task.
    const onReset = (event: Event) => {
      if (event.target instanceof HTMLFormElement && event.target.id === CREATE_PRODUCTS_FORM_ID) setTimeout(read)
    }
    document.addEventListener('change', onChange)
    document.addEventListener('reset', onReset)
    return () => {
      document.removeEventListener('change', onChange)
      document.removeEventListener('reset', onReset)
    }
  }, [rows])

  return { selected, selectable: selectableIds.length }
}

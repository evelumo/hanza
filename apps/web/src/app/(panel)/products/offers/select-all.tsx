'use client'

import { CREATE_PRODUCTS_FORM_ID } from './create-products-form'

export function SelectAll() {
  return (
    <input
      type="checkbox"
      // Associated with the form (no name, so never submitted) only so that the reset after an action unticks it with the rows.
      form={CREATE_PRODUCTS_FORM_ID}
      aria-label="Zaznacz wszystkie oferty z SKU"
      className="size-4 accent-accent"
      onChange={(event) => {
        const boxes = document.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][name="offerIds"][form="${CREATE_PRODUCTS_FORM_ID}"]`)
        for (const box of boxes) box.checked = event.currentTarget.checked
      }}
    />
  )
}

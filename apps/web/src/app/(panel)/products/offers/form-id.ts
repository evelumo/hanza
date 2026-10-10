// In a module of its own, not a client one: the page (a server component) puts it on the row checkboxes, and a
// constant imported from a 'use client' file reaches the server as a reference, not as its value.
export const CREATE_PRODUCTS_FORM_ID = 'create-products-form'

/** The section of Offers whose Product has unset Stock, for links that lead straight to it (the dashboard's). */
export const STOCK_UNSET_SECTION_ID = 'stock-not-set'

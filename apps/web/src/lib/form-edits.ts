/** A form control as far as "did a person change it" goes; an `HTMLInputElement`, `HTMLTextAreaElement` or `HTMLSelectElement` fits. */
export interface EditableField {
  type: string
  value?: string
  defaultValue?: string
  checked?: boolean
  defaultChecked?: boolean
  /** A select's options, and whether several can be chosen. */
  options?: ArrayLike<{ selected: boolean; defaultSelected: boolean }>
  multiple?: boolean
}

// What a person does not type into, or what a script fills in.
const NOT_TYPED = new Set(['hidden', 'submit', 'button', 'reset', 'image'])

/** Whether a field no longer shows what it was rendered with: a person typed, ticked or chose something in it. */
export function fieldEdited(field: EditableField): boolean {
  if (NOT_TYPED.has(field.type)) return false
  if (field.type === 'checkbox' || field.type === 'radio') return field.checked !== field.defaultChecked
  if (field.options) {
    const options = Array.from(field.options)
    if (field.multiple) return options.some((option) => option.selected !== option.defaultSelected)
    // A select of one always shows an option: with none marked as the default, that is its first.
    const initial = Math.max(options.findIndex((option) => option.defaultSelected), 0)
    return options.length > 0 && options.findIndex((option) => option.selected) !== initial
  }
  return field.value !== field.defaultValue
}

/** Whether a person is in the middle of something a re-read of the page could disturb: a field they changed, or one they are in. */
export function personIsEditing(fields: Iterable<EditableField>, focused: EditableField | null): boolean {
  if (focused !== null && !NOT_TYPED.has(focused.type) && focused.type !== 'checkbox' && focused.type !== 'radio') return true
  for (const field of fields) if (fieldEdited(field)) return true
  return false
}

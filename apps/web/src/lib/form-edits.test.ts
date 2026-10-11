import { describe, expect, it } from 'vitest'
import { fieldEdited, personIsEditing } from './form-edits'

const text = (value: string, defaultValue = '') => ({ type: 'text', value, defaultValue })
const select = (...options: Array<[selected: boolean, defaultSelected: boolean]>) => ({
  type: 'select-one',
  value: '',
  options: options.map(([selected, defaultSelected]) => ({ selected, defaultSelected })),
})

describe('fieldEdited', () => {
  it('tells a field a person changed from one that shows what it was rendered with', () => {
    expect(fieldEdited(text(''))).toBe(false)
    expect(fieldEdited(text('FAKE01', 'FAKE01'))).toBe(false)
    expect(fieldEdited(text('FAKE02', 'FAKE01'))).toBe(true)
    expect(fieldEdited(text('30,5'))).toBe(true)
    expect(fieldEdited({ type: 'textarea', value: 'a note', defaultValue: '' })).toBe(true)
    expect(fieldEdited({ type: 'checkbox', checked: true, defaultChecked: false })).toBe(true)
    expect(fieldEdited({ type: 'checkbox', checked: true, defaultChecked: true, value: 'on', defaultValue: 'on' })).toBe(false)
    expect(fieldEdited(select([true, true], [false, false]))).toBe(false)
    expect(fieldEdited(select([false, true], [true, false]))).toBe(true)
    // A select rendered without a default shows its first option, which is then no edit.
    expect(fieldEdited(select([true, false], [false, false]))).toBe(false)
    expect(fieldEdited(select([false, false], [true, false]))).toBe(true)
    expect(fieldEdited(select())).toBe(false)
    expect(fieldEdited({ ...select([true, false], [false, false]), multiple: true })).toBe(true)
  })

  it('never counts what a person does not type into', () => {
    // A hidden id a script rewrote, a button's value.
    expect(fieldEdited({ type: 'hidden', value: 'b', defaultValue: 'a' })).toBe(false)
    expect(fieldEdited({ type: 'submit', value: 'x', defaultValue: '' })).toBe(false)
  })
})

describe('personIsEditing', () => {
  it('holds while any field is changed, or while a person is in one they type or choose in', () => {
    expect(personIsEditing([text(''), text('FAKE01', 'FAKE01')], null)).toBe(false)
    expect(personIsEditing([text(''), text('1.25')], null)).toBe(true)
    expect(personIsEditing([text('')], text(''))).toBe(true)
    expect(personIsEditing([], select([true, true]))).toBe(true)
    // Focus on a button or a checkbox is not typing.
    expect(personIsEditing([], { type: 'submit' })).toBe(false)
    expect(personIsEditing([], { type: 'checkbox', checked: false, defaultChecked: false })).toBe(false)
  })
})

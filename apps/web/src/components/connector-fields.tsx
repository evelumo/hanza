import { Field, Select } from './form'
import type { ConnectorField } from '@/lib/connector-form'

/** Renders the fields computed by `describeFields`; credentials are password inputs and never prefilled. */
export function ConnectorFields({
  fields,
  values = {},
  errors = {},
}: {
  fields: ConnectorField[]
  values?: Record<string, string>
  errors?: Record<string, string>
}) {
  return (
    <>
      {fields.map((field) => {
        const error = errors[field.name]
        const label = field.required ? field.label : `${field.label} (opcjonalnie)`
        if (field.control === 'checkbox') {
          const checked = field.name in values ? values[field.name] === 'on' : field.defaultValue === true
          return (
            <label key={field.name} className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                name={field.name}
                defaultChecked={checked}
                className="size-4 rounded border-line accent-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
              {field.label}
            </label>
          )
        }
        if (field.control === 'select') {
          const value = values[field.name] ?? (field.defaultValue === null ? '' : String(field.defaultValue))
          return (
            <Select key={field.name} name={field.name} label={label} error={error} defaultValue={value}>
              {field.required || field.defaultValue === null ? <option value="">—</option> : null}
              {field.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          )
        }
        const secret = field.control === 'password'
        return (
          <Field
            key={field.name}
            name={field.name}
            label={label}
            error={error}
            type={field.control}
            required={field.required}
            // Browsers ignore "off" on password inputs and may fill in the user's Hanza password.
            autoComplete={secret ? 'new-password' : undefined}
            step={field.control === 'number' ? (field.integer ? 1 : 'any') : undefined}
            defaultValue={secret ? undefined : (values[field.name] ?? (field.defaultValue === null ? '' : String(field.defaultValue)))}
          />
        )
      })}
    </>
  )
}

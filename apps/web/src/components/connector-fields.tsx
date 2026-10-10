import { useT } from '@/i18n/use-t'
import { CheckboxField, Field, Select } from './form'
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
  const t = useT()
  return (
    <>
      {fields.map((field) => {
        const error = errors[field.name]
        const label = field.required ? field.label : t('connections.new.optionalField', { label: field.label })
        if (field.control === 'checkbox') {
          const checked = field.name in values ? values[field.name] === 'on' : field.defaultValue === true
          return <CheckboxField key={field.name} name={field.name} label={field.label} defaultChecked={checked} />
        }
        if (field.control === 'select') {
          const value = values[field.name] ?? (field.defaultValue === null ? '' : String(field.defaultValue))
          return (
            <Select key={field.name} name={field.name} label={label} error={error} defaultValue={value}>
              {field.required || field.defaultValue === null ? (
                <option value="" aria-label={t('common.noValue')}>
                  —
                </option>
              ) : null}
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

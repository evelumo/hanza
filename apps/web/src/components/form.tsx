'use client'

import { CircleAlert, CircleCheck, LoaderCircle, OctagonAlert } from 'lucide-react'
import { useId, type ButtonHTMLAttributes, type ComponentProps, type FieldsetHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { useFormStatus } from 'react-dom'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label, labelLineClass } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { RadioGroupItem } from '@/components/ui/radio-group'
import { useT } from '@/i18n/use-t'
import { cn } from '@/lib/utils'
import { buttonVariantOf, type ButtonSize, type ButtonVariant } from './button-class'

/** The hint or the error below a control; the error wins and carries an icon, so it is not told by colour alone. */
function FieldNote({ id, error, hint }: { id: string; error?: string; hint?: string }) {
  if (error) {
    return (
      <p id={id} className="flex items-start gap-1 text-meta text-critical">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        {error}
      </p>
    )
  }
  return hint ? (
    <p id={id} className="text-meta text-muted-foreground">
      {hint}
    </p>
  ) : null
}

/** The control's own note after whatever the caller already points at (a hint it renders elsewhere, at its own width). */
const describedBy = (...ids: Array<string | false | undefined>) => ids.filter(Boolean).join(' ') || undefined

// Label, control and note in one stack. Packed to the top: a field stretched to the height of a taller one
// beside it (that one has a hint) would otherwise spread its rows and drop its control below its neighbour's.
const fieldStackClass = 'grid content-start gap-1.5'

// A disabled box or radio dims itself; its label is in another element, so the pair is dimmed from here.
const choiceClass = 'group/choice flex items-start gap-2'
const choiceLabelClass = 'font-normal group-has-[:disabled]/choice:cursor-not-allowed group-has-[:disabled]/choice:text-muted-foreground'

// The hint and the error sit outside the <label> and are linked as its description, so the
// control's accessible name is the label alone (what screen readers announce and tests look up).
// `labelHidden` keeps the label for assistive technology only and `compact` makes the control 28px high:
// both are for a control inside a table row or a filter bar, where a column header already says what it is.
export function Field({
  label,
  error,
  hint,
  labelHidden = false,
  compact = false,
  className,
  'aria-describedby': describedByCaller,
  ...input
}: { label: string; error?: string; hint?: string; labelHidden?: boolean; compact?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  const generatedId = useId()
  const id = input.id ?? generatedId
  return (
    <div className={fieldStackClass}>
      <Label htmlFor={id} className={labelHidden ? 'sr-only' : undefined}>
        {label}
      </Label>
      <Input
        {...input}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(describedByCaller, (error || hint) && `${id}-note`)}
        className={cn(compact && 'h-7 md:text-meta', className)}
      />
      <FieldNote id={`${id}-note`} error={error} hint={hint} />
    </div>
  )
}

/** Takes a `ref` to the <select> itself, for a caller that has to reach the element. */
export function Select({
  label,
  error,
  hint,
  labelHidden = false,
  compact = false,
  className,
  children,
  'aria-describedby': describedByCaller,
  ...select
}: { label: string; error?: string; hint?: string; labelHidden?: boolean; compact?: boolean; children: ReactNode } & Omit<ComponentProps<'select'>, 'size'>) {
  const generatedId = useId()
  const id = select.id ?? generatedId
  return (
    <div className={fieldStackClass}>
      <Label htmlFor={id} className={labelHidden ? 'sr-only' : undefined}>
        {label}
      </Label>
      <NativeSelect
        {...select}
        id={id}
        size={compact ? 'sm' : 'default'}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(describedByCaller, (error || hint) && `${id}-note`)}
        className={className}
      >
        {children}
      </NativeSelect>
      <FieldNote id={`${id}-note`} error={error} hint={hint} />
    </div>
  )
}

export function CheckboxField({
  label,
  error,
  hint,
  className,
  'aria-describedby': describedByCaller,
  ...input
}: { label: string; error?: string; hint?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const generatedId = useId()
  const id = input.id ?? generatedId
  return (
    <div className={cn(choiceClass, className)}>
      <Checkbox
        {...input}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(describedByCaller, (error || hint) && `${id}-note`)}
        className="mt-0.5"
      />
      <div className="grid gap-0.5">
        <Label htmlFor={id} className={choiceLabelClass}>
          {label}
        </Label>
        <FieldNote id={`${id}-note`} error={error} hint={hint} />
      </div>
    </div>
  )
}

/** A named group of `RadioField`s (or other controls): the legend is the group's accessible name. */
export function RadioGroupField({
  legend,
  legendHidden = false,
  error,
  hint,
  className,
  children,
  'aria-describedby': describedByCaller,
  ...fieldset
}: { legend: string; legendHidden?: boolean; error?: string; hint?: string; children: ReactNode } & FieldsetHTMLAttributes<HTMLFieldSetElement>) {
  const id = useId()
  return (
    <fieldset {...fieldset} aria-describedby={describedBy(describedByCaller, (error || hint) && `${id}-note`)} className={cn('grid gap-2.5', className)}>
      <legend className={legendHidden ? 'sr-only' : 'mb-2.5 text-sm leading-5 font-medium'}>{legend}</legend>
      {children}
      <FieldNote id={`${id}-note`} error={error} hint={hint} />
    </fieldset>
  )
}

export function RadioField({
  label,
  hint,
  className,
  'aria-describedby': describedByCaller,
  ...input
}: { label: string; hint?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const generatedId = useId()
  const id = input.id ?? generatedId
  return (
    <div className={cn(choiceClass, className)}>
      <RadioGroupItem {...input} id={id} aria-describedby={describedBy(describedByCaller, hint && `${id}-note`)} className="mt-0.5" />
      <div className="grid gap-0.5">
        <Label htmlFor={id} className={choiceLabelClass}>
          {label}
        </Label>
        <FieldNote id={`${id}-note`} hint={hint} />
      </div>
    </div>
  )
}

/**
 * Buttons beside labelled fields, level with their controls: the same stack as a `Field`, its label line left
 * empty, so no margin has to guess how high a label is. Where the buttons sit under the fields instead (a
 * narrow container), hide that line with `labelClassName`, e.g. `hidden @xl:block`.
 */
export function BesideFields({ className, labelClassName, children }: { className?: string; labelClassName?: string; children: ReactNode }) {
  return (
    <div className={cn(fieldStackClass, className)}>
      <span aria-hidden="true" className={cn(labelLineClass, 'invisible', labelClassName)}>
        {'\u00a0'}
      </span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

/** The one full-width primary button of a standalone form (sign in, onboarding). */
export function SubmitButton({ children, className, ...button }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button type="submit" size="lg" {...button} className={cn('w-full', className)}>
      {children}
    </Button>
  )
}

/**
 * A submit button that disables itself while its form's action runs. When a form has several of them, give each
 * a `name` and `value`: only the one that was pressed then shows its pending label.
 */
export function ActionButton({
  variant = 'primary',
  size = 'default',
  pendingLabel,
  className,
  children,
  ...button
}: { variant?: ButtonVariant; size?: ButtonSize; pendingLabel?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending, data } = useFormStatus()
  const t = useT()
  const pressed = pending && (button.name === undefined || data?.get(button.name) === String(button.value ?? ''))
  return (
    <Button
      type="submit"
      variant={buttonVariantOf(variant)}
      size={size}
      {...button}
      disabled={pending || button.disabled}
      className={className}
    >
      {pressed ? (
        <>
          <LoaderCircle className="animate-spin" aria-hidden="true" />
          {pendingLabel ?? t('common.saving')}
        </>
      ) : (
        children
      )}
    </Button>
  )
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <Alert tone="critical" role="alert" className="w-full">
      <OctagonAlert aria-hidden="true" />
      <p className="font-medium">{message}</p>
    </Alert>
  )
}

/** The note a form shows after its action succeeded. Inline and persistent, unlike a toast. */
export function FormSuccess({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <Alert tone="success" role="status" className="w-full">
      <CircleCheck aria-hidden="true" />
      <p className="font-medium">{message}</p>
    </Alert>
  )
}

import { buttonVariants } from '@/components/ui/button'

// The panel's names for the button looks, mapped onto the variants of `ui/button`.
const variants = {
  primary: 'default',
  secondary: 'outline',
  danger: 'destructive-outline',
  ghost: 'ghost',
} as const

export type ButtonVariant = keyof typeof variants
export type ButtonSize = 'sm' | 'default' | 'lg'

export const buttonVariantOf = (variant: ButtonVariant) => variants[variant]

/** For links that look like buttons. In its own module (not form.tsx) so server components can call it. */
export const buttonClass = (variant: ButtonVariant = 'primary', size: ButtonSize = 'default') =>
  buttonVariants({ variant: variants[variant], size })

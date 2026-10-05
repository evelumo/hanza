const variants = {
  primary: 'bg-accent text-white hover:bg-accent-strong',
  secondary: 'border border-line bg-white text-ink hover:bg-canvas',
  danger: 'border border-red-300 bg-white text-red-800 hover:bg-red-50',
} as const

export type ButtonVariant = keyof typeof variants

/** In its own module (not form.tsx) so server components can call it. */
export const buttonClass = (variant: ButtonVariant = 'primary') =>
  `inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${variants[variant]}`

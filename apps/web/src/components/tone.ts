/** The panel's vocabulary for state. A tone is never the only signal: pair it with an icon or shape, and always with text. */
export const tones = ['neutral', 'info', 'success', 'warning', 'attention', 'critical'] as const

export type Tone = (typeof tones)[number]

// Whole class names, so Tailwind sees every one of them.
/** Subtle background, matching border and strong text: badges, notices, inline alerts. */
export const toneSurfaceClass: Record<Tone, string> = {
  neutral: 'border-neutral-border bg-neutral-subtle text-neutral',
  info: 'border-info-border bg-info-subtle text-info',
  success: 'border-success-border bg-success-subtle text-success',
  warning: 'border-warning-border bg-warning-subtle text-warning',
  attention: 'border-attention-border bg-attention-subtle text-attention',
  critical: 'border-critical-border bg-critical-subtle text-critical',
}

/** The strong colour alone, for text and icons on a card or the canvas. */
export const toneTextClass: Record<Tone, string> = {
  neutral: 'text-neutral',
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  attention: 'text-attention',
  critical: 'text-critical',
}

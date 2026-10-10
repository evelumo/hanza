import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// The theme's own names (globals.css): without them `text-meta` would be taken for a colour and dropped
// next to `text-muted-foreground`, and `shadow-card` would not replace another shadow.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['meta'],
      shadow: ['card', 'overlay'],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

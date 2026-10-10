import mark from '@/app/icon.svg'
import { cn } from '@/lib/utils'

/** The Hanza mark: the same file the browser shows as the favicon. Decorative; the name stands next to it. */
export function BrandMark({ className }: { className?: string }) {
  // A plain <img>: next/image would need SVG optimisation switched on for one static, 250-byte file.
  return <img src={(mark as { src: string }).src} alt="" width={24} height={24} className={cn('size-6 shrink-0 rounded-md', className)} />
}

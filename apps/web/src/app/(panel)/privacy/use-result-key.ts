'use client'

import { useState } from 'react'

/**
 * Changes whenever a form action returns a new result, even an identical one. Keying a follow-up step by it
 * starts that step afresh, so a confirmation that already ran never lingers on a later answer.
 */
export function useResultKey(result: unknown): number {
  const [seen, setSeen] = useState(result)
  const [key, setKey] = useState(0)
  if (seen !== result) {
    setSeen(result)
    setKey((current) => current + 1)
  }
  return key
}

/** Who caused a change; recorded in Event payloads. */
export type Actor = { type: 'user'; userId: string } | { type: 'system' }

export const systemActor: Actor = { type: 'system' }

'use server'

import {
  DomainError,
  addConnection,
  cancelSignIn,
  getSignIn,
  requestSync,
  setStatusMapping,
  startSignIn,
  updateChannelStockRules,
  updateChannelWarehouses,
  type StartSignInInput,
} from '@hanza/core'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getT } from '@/i18n/server'
import { failure, formText, invalidInput, type ActionState } from '@/lib/action-state'
import { describeFields, fieldErrorsFromIssues, issuesOf, publicValues, readFields } from '@/lib/connector-form'
import { getContext } from '@/lib/context'
import { domainErrorMessage } from '@/lib/domain-errors'
import { requireTenant } from '@/lib/session'
import {
  addConnectionSchema,
  channelWarehousesSchema,
  requestSyncSchema,
  signInAgainSchema,
  signInIdSchema,
  statusMappingSchema,
  stockRulesSchema,
} from './schemas'

export async function addConnectionAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const submitted = formText(formData)
  const parsed = addConnectionSchema.safeParse(submitted)
  if (!parsed.success) return invalidInput(parsed.error, t, publicValues(submitted))

  const ctx = getContext()
  const connector = ctx.connectors.get(parsed.data.connectorId)
  if (!connector) return { error: domainErrorMessage(t, 'unknown_connector'), values: publicValues(submitted) }
  const configFields = describeFields('config', connector.configSchema)
  const values = publicValues(submitted, configFields)
  const credentialsFields = describeFields('credentials', connector.credentialsSchema)

  let connectionId: string
  try {
    ;({ connectionId } = await addConnection(
      ctx,
      organizationId,
      {
        connectorId: connector.id,
        name: parsed.data.name,
        config: readFields(configFields, formData),
        credentials: readFields(credentialsFields, formData),
      },
      { type: 'user', userId: user.id },
    ))
  } catch (error) {
    if (error instanceof DomainError && error.code === 'invalid_config') {
      const { fieldErrors } = fieldErrorsFromIssues([...configFields, ...credentialsFields], issuesOf(error.details), formData, t)
      return { error: domainErrorMessage(t, 'invalid_config'), fieldErrors, values }
    }
    return failure(error, t, { values })
  }
  revalidatePath('/connections', 'layout')
  redirect(`/connections/${connectionId}`)
}

export async function requestSyncAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { organizationId } = await requireTenant()
  const t = await getT()
  const parsed = requestSyncSchema.safeParse(formText(formData))
  if (!parsed.success) return invalidInput(parsed.error, t)

  try {
    await requestSync(getContext(), organizationId, parsed.data.connectionId)
  } catch (error) {
    return failure(error, t)
  }
  return { ok: true }
}

export async function updateChannelWarehousesAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const parsed = channelWarehousesSchema.safeParse({
    ...formText(formData),
    warehouseIds: formData.getAll('warehouseIds').filter((id) => typeof id === 'string'),
  })
  if (!parsed.success) return invalidInput(parsed.error, t)

  const { connectionId } = parsed.data
  const choice = parsed.data.mode === 'all' ? ({ all: true } as const) : { all: false as const, warehouseIds: parsed.data.warehouseIds }
  try {
    await updateChannelWarehouses(getContext(), organizationId, connectionId, choice, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t)
  }
  revalidatePath(`/connections/${connectionId}`)
  revalidatePath('/warehouses', 'layout')
  return { ok: true }
}

export async function updateStockRulesAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const values = formText(formData)
  const parsed = stockRulesSchema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, t, values)

  const { connectionId, safetyBuffer, channelLimit } = parsed.data
  try {
    await updateChannelStockRules(getContext(), organizationId, connectionId, { safetyBuffer, channelLimit }, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t, { values })
  }
  revalidatePath(`/connections/${connectionId}`)
  return { ok: true }
}

/** Owners and admins only, checked by the core (`forbidden`). */
export async function setStatusMappingAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const values = formText(formData)
  const parsed = statusMappingSchema.safeParse(values)
  if (!parsed.success) return invalidInput(parsed.error, t, values)

  const { connectionId, ...mapping } = parsed.data
  try {
    await setStatusMapping(getContext(), organizationId, connectionId, mapping, { type: 'user', userId: user.id })
  } catch (error) {
    return failure(error, t, { values })
  }
  revalidatePath('/connections', 'layout')
  revalidatePath('/settings', 'layout')
  return { ok: true }
}

/** Starts the device-flow sign-in of a new Connection; the worker asks the Channel for the code. */
export async function startSignInAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const submitted = formText(formData)
  const parsed = addConnectionSchema.safeParse(submitted)
  if (!parsed.success) return invalidInput(parsed.error, t, publicValues(submitted))

  const ctx = getContext()
  const connector = ctx.connectors.get(parsed.data.connectorId)
  if (!connector) return { error: domainErrorMessage(t, 'unknown_connector'), values: publicValues(submitted) }
  const configFields = describeFields('config', connector.configSchema)
  const values = publicValues(submitted, configFields)

  let signInId: string
  try {
    ;({ signInId } = await startSignIn(
      ctx,
      organizationId,
      { connectorId: connector.id, name: parsed.data.name, config: readFields(configFields, formData) },
      { type: 'user', userId: user.id },
    ))
  } catch (error) {
    if (error instanceof DomainError && error.code === 'invalid_config') {
      const { fieldErrors } = fieldErrorsFromIssues(configFields, issuesOf(error.details), formData, t)
      return { error: domainErrorMessage(t, 'invalid_config'), fieldErrors, values }
    }
    return failure(error, t, { values })
  }
  redirect(`/connections/sign-in/${signInId}`)
}

/** "Sign in again": the same flow, aimed at an existing Connection; no new Connection is created. */
export async function signInAgainAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const parsed = signInAgainSchema.safeParse(formText(formData))
  if (!parsed.success) return invalidInput(parsed.error, t)

  let signInId: string
  try {
    ;({ signInId } = await startSignIn(getContext(), organizationId, { connectionId: parsed.data.connectionId }, { type: 'user', userId: user.id }))
  } catch (error) {
    return failure(error, t)
  }
  redirect(`/connections/sign-in/${signInId}`)
}

/** Starts a fresh sign-in with what an ended one was for. */
export async function retrySignInAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { user, organizationId } = await requireTenant()
  const t = await getT()
  const parsed = signInIdSchema.safeParse(formText(formData))
  if (!parsed.success) return invalidInput(parsed.error, t)

  const ctx = getContext()
  let signInId: string
  try {
    const ended = await getSignIn(ctx, organizationId, parsed.data.signInId)
    if (!ended) throw new DomainError('not_found')
    const input: StartSignInInput =
      ended.reconnect && ended.connectionId
        ? { connectionId: ended.connectionId }
        : { connectorId: ended.connectorId, name: ended.name ?? '', config: ended.config ?? {} }
    ;({ signInId } = await startSignIn(ctx, organizationId, input, { type: 'user', userId: user.id }))
  } catch (error) {
    return failure(error, t)
  }
  redirect(`/connections/sign-in/${signInId}`)
}

export async function cancelSignInAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const { organizationId } = await requireTenant()
  const t = await getT()
  const parsed = signInIdSchema.safeParse(formText(formData))
  if (!parsed.success) return invalidInput(parsed.error, t)

  try {
    await cancelSignIn(getContext(), organizationId, parsed.data.signInId)
  } catch (error) {
    return failure(error, t)
  }
  revalidatePath(`/connections/sign-in/${parsed.data.signInId}`)
  return { ok: true }
}

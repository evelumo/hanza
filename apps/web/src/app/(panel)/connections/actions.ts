'use server'

import { DomainError, addConnection, requestSync, updateChannelStockRules } from '@hanza/core'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getT } from '@/i18n/server'
import { failure, formText, invalidInput, type ActionState } from '@/lib/action-state'
import { describeFields, fieldErrorsFromIssues, issuesOf, publicValues, readFields } from '@/lib/connector-form'
import { getContext } from '@/lib/context'
import { domainErrorMessage } from '@/lib/domain-errors'
import { requireTenant } from '@/lib/session'
import { addConnectionSchema, requestSyncSchema, stockRulesSchema } from './schemas'

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

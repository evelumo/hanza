'use client'

import { useState } from 'react'
import { ActionForm } from '@/components/action-form'
import { ActionButton, CheckboxField, RadioField, RadioGroupField } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { updateChannelWarehousesAction } from '../actions'

export function ChannelWarehousesForm({
  connectionId,
  all,
  chosen,
  warehouses,
}: {
  connectionId: string
  all: boolean
  chosen: string[]
  /** Active Warehouses, in placement order. */
  warehouses: Array<{ id: string; name: string }>
}) {
  const t = useT()
  const [mode, setMode] = useState<'all' | 'only'>(all ? 'all' : 'only')
  return (
    <ActionForm
      action={updateChannelWarehousesAction}
      success={t('connections.warehouses.saved')}
      className="grid gap-4"
      actions={<ActionButton variant="secondary">{t('connections.warehouses.save')}</ActionButton>}
    >
      {(state) => (
        <>
          <input type="hidden" name="connectionId" value={connectionId} />
          <RadioGroupField legend={t('connections.warehouses.legend')} legendHidden error={state.fieldErrors?.warehouseIds}>
            <RadioField
              name="mode"
              value="all"
              checked={mode === 'all'}
              onChange={() => setMode('all')}
              label={t('connections.warehouses.all')}
              hint={t('connections.warehouses.allHint')}
            />
            <RadioField name="mode" value="only" checked={mode === 'only'} onChange={() => setMode('only')} label={t('connections.warehouses.only')} />
            <div className="grid gap-2 pl-6">
              {warehouses.map((warehouse) => (
                <CheckboxField
                  key={warehouse.id}
                  name="warehouseIds"
                  value={warehouse.id}
                  label={warehouse.name}
                  defaultChecked={chosen.includes(warehouse.id)}
                  disabled={mode === 'all'}
                />
              ))}
            </div>
          </RadioGroupField>
        </>
      )}
    </ActionForm>
  )
}

'use client'

import { useState } from 'react'
import { ActionForm } from '@/components/action-form'
import { ActionButton } from '@/components/form'
import { useT } from '@/i18n/use-t'
import { updateChannelWarehousesAction } from '../actions'

const radioClass = 'h-4 w-4 accent-accent'

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
    <ActionForm action={updateChannelWarehousesAction} success={t('connections.warehouses.saved')} className="space-y-4">
      {(state) => (
        <>
          <input type="hidden" name="connectionId" value={connectionId} />
          <fieldset className="space-y-3">
            <legend className="sr-only">{t('connections.warehouses.legend')}</legend>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="mode" value="all" checked={mode === 'all'} onChange={() => setMode('all')} className={`mt-0.5 ${radioClass}`} />
              <span>
                <span className="font-medium">{t('connections.warehouses.all')}</span>
                <span className="block text-xs text-muted">{t('connections.warehouses.allHint')}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="mode" value="only" checked={mode === 'only'} onChange={() => setMode('only')} className={`mt-0.5 ${radioClass}`} />
              <span className="font-medium">{t('connections.warehouses.only')}</span>
            </label>
            <div className="space-y-2 pl-6">
              {warehouses.map((warehouse) => (
                <label key={warehouse.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="warehouseIds"
                    value={warehouse.id}
                    defaultChecked={chosen.includes(warehouse.id)}
                    disabled={mode === 'all'}
                    className={radioClass}
                  />
                  {warehouse.name}
                </label>
              ))}
              {state.fieldErrors?.warehouseIds ? <p className="text-xs text-red-700">{state.fieldErrors.warehouseIds}</p> : null}
            </div>
          </fieldset>
          <ActionButton>{t('connections.warehouses.save')}</ActionButton>
        </>
      )}
    </ActionForm>
  )
}

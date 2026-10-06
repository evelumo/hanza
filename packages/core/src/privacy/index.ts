export { normalizeEmail, type BuyerData, type BuyerDataView } from './buyer-data'
export { previewBuyerErasure, eraseBuyerData, type ErasurePreview } from './erasure'
export {
  getPrivacySettings,
  setBuyerDataRetention,
  previewBuyerDataRetention,
  retentionNeedsConfirmation,
  retentionCutoff,
  isValidRetentionDays,
  MAX_RETENTION_DAYS,
  type PrivacySettingsView,
} from './settings'
export {
  sweepBuyerData,
  sealLegacyBuyerData,
  applyBuyerDataRetention,
  fillMissingClosedAt,
  SWEEP_BATCH_SIZE,
  SWEEP_MAX_BATCHES,
} from './sweep'

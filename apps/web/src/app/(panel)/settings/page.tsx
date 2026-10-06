import { redirect } from 'next/navigation'

/** Order statuses are the only settings so far. */
export default function SettingsPage() {
  redirect('/settings/order-statuses')
}

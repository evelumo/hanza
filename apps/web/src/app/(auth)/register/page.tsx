import type { Metadata } from 'next'
import { getT } from '@/i18n/server'
import { RegisterForm } from './register-form'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.register.title') }
}

export default function RegisterPage() {
  return <RegisterForm />
}

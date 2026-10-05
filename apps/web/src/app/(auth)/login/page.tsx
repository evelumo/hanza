import type { Metadata } from 'next'
import { getT } from '@/i18n/server'
import { LoginForm } from './login-form'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.login.title') }
}

export default function LoginPage() {
  return <LoginForm />
}

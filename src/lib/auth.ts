export type UserRole = 'admin' | 'member'
export type AuthMethod = 'google' | 'email-code' | 'demo-admin'

export interface AuthUser {
  id: string
  name: string
  email: string
  role: UserRole
  authMethod: AuthMethod
}

interface StoredCode {
  code: string
  expiresAt: number
}

const SESSION_STORAGE_KEY = 'celiac-map.session.v1'
const EMAIL_CODES_STORAGE_KEY = 'celiac-map.email-codes.v1'

export const demoAdminUser: AuthUser = {
  id: 'demo-admin',
  name: 'Admin Gluten Free Map',
  email: 'admin@celiac-map.local',
  role: 'admin',
  authMethod: 'demo-admin',
}

export const authMethodLabels: Record<AuthMethod, string> = {
  google: 'Google',
  'email-code': 'Código por email',
  'demo-admin': 'Admin demo',
}

function sanitizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function readStoredCodes() {
  if (typeof window === 'undefined') {
    return {} as Record<string, StoredCode>
  }

  const rawValue = window.localStorage.getItem(EMAIL_CODES_STORAGE_KEY)

  if (!rawValue) {
    return {} as Record<string, StoredCode>
  }

  try {
    return JSON.parse(rawValue) as Record<string, StoredCode>
  } catch {
    return {} as Record<string, StoredCode>
  }
}

function persistStoredCodes(codes: Record<string, StoredCode>) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(EMAIL_CODES_STORAGE_KEY, JSON.stringify(codes))
}

function persistSession(user: AuthUser | null) {
  if (typeof window === 'undefined') {
    return
  }

  if (!user) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY)
    return
  }

  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(user))
}

export function getStoredSession() {
  if (typeof window === 'undefined') {
    return null
  }

  const rawValue = window.localStorage.getItem(SESSION_STORAGE_KEY)

  if (!rawValue) {
    return null
  }

  try {
    return JSON.parse(rawValue) as AuthUser
  } catch {
    return null
  }
}

export async function signOut() {
  persistSession(null)
  return null
}

export async function signInAsDemoAdmin() {
  persistSession(demoAdminUser)
  return demoAdminUser
}

export async function signInWithGoogleDemo(input: {
  name: string
  email: string
}) {
  const email = sanitizeEmail(input.email)
  const name = input.name.trim()

  if (!email || !email.includes('@')) {
    throw new Error('Ingresá un email válido para continuar con Google.')
  }

  if (!name) {
    throw new Error('Ingresá tu nombre para continuar con Google.')
  }

  const nextUser: AuthUser = {
    id: `google-${email}`,
    name,
    email,
    role: 'member',
    authMethod: 'google',
  }

  persistSession(nextUser)
  return nextUser
}

export async function requestEmailCode(input: { email: string }) {
  const email = sanitizeEmail(input.email)

  if (!email || !email.includes('@')) {
    throw new Error('Ingresá un email válido para pedir un código.')
  }

  const code = `${Math.floor(100000 + Math.random() * 900000)}`
  const expiresAt = Date.now() + 10 * 60 * 1000
  const currentCodes = readStoredCodes()

  currentCodes[email] = {
    code,
    expiresAt,
  }

  persistStoredCodes(currentCodes)

  return {
    email,
    code,
    expiresAt,
  }
}

function buildNameFromEmail(email: string) {
  const localPart = email.split('@')[0] ?? 'usuario'
  const words = localPart
    .replace(/[._-]+/g, ' ')
    .split(' ')
    .filter(Boolean)

  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export async function verifyEmailCode(input: {
  email: string
  code: string
}) {
  const email = sanitizeEmail(input.email)
  const submittedCode = input.code.trim()
  const currentCodes = readStoredCodes()
  const match = currentCodes[email]

  if (!match) {
    throw new Error('Primero pedí un código para ese email.')
  }

  if (match.expiresAt < Date.now()) {
    delete currentCodes[email]
    persistStoredCodes(currentCodes)
    throw new Error('El código venció. Pedí uno nuevo.')
  }

  if (match.code !== submittedCode) {
    throw new Error('El código no coincide.')
  }

  delete currentCodes[email]
  persistStoredCodes(currentCodes)

  const nextUser: AuthUser = {
    id: `email-${email}`,
    name: buildNameFromEmail(email),
    email,
    role: 'member',
    authMethod: 'email-code',
  }

  persistSession(nextUser)
  return nextUser
}

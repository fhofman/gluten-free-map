import type {
  CreateListingInput,
  Listing,
  SessionPayload,
} from './types'

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api'

function buildApiUrl(path: string) {
  const normalizedBase = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`
  const base = normalizedBase.startsWith('http')
    ? normalizedBase
    : `${window.location.origin}${normalizedBase.startsWith('/') ? normalizedBase : `/${normalizedBase}`}`

  return new URL(path, base).toString()
}

async function readJson<T>(response: Response) {
  const raw = await response.text()
  const payload = raw ? (JSON.parse(raw) as T | { message?: string }) : null

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? payload.message
        : raw || 'Request failed.'

    throw new Error(message || 'Request failed.')
  }

  return payload as T
}

export async function fetchSession() {
  const response = await fetch(buildApiUrl('auth/session'), {
    credentials: 'include',
  })

  return readJson<SessionPayload>(response)
}

export async function fetchListings(params?: {
  kind?: 'physical' | 'online' | 'all'
  approval?: 'approved' | 'all'
}) {
  const url = new URL(buildApiUrl('listings'))

  if (params?.kind) {
    url.searchParams.set('kind', params.kind)
  }

  if (params?.approval) {
    url.searchParams.set('approval', params.approval)
  }

  const response = await fetch(url, {
    credentials: 'include',
  })

  return readJson<Listing[]>(response)
}

export async function fetchAdminQueue() {
  const response = await fetch(buildApiUrl('admin/pending'), {
    credentials: 'include',
  })

  return readJson<Listing[]>(response)
}

export async function createListing(input: CreateListingInput, csrfToken: string) {
  const response = await fetch(buildApiUrl('listings'), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify(input),
  })

  return readJson<Listing>(response)
}

export async function submitReview(
  listingId: string,
  input: { rating: number; comment: string; photoKeys?: string[] },
  csrfToken: string,
) {
  const response = await fetch(buildApiUrl(`listings/${listingId}/reviews`), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify(input),
  })

  return readJson<Listing>(response)
}

export async function moderateListing(
  listingId: string,
  input: { approvalStatus: 'approved' | 'pending' | 'rejected'; verified?: boolean },
  csrfToken: string,
) {
  const response = await fetch(buildApiUrl(`admin/listings/${listingId}/moderate`), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify(input),
  })

  return readJson<Listing>(response)
}

export async function logout(csrfToken: string) {
  const response = await fetch(buildApiUrl('auth/logout'), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'X-CSRF-Token': csrfToken,
    },
  })

  return readJson<{ ok: boolean }>(response)
}

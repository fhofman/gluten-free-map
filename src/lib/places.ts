import { queryOptions } from '@tanstack/react-query'
import type { AuthMethod, AuthUser, UserRole } from './auth'

export type PlaceCategory =
  | 'restaurant'
  | 'store'
  | 'market'
  | 'productSpot'

export type PlaceApprovalStatus = 'approved' | 'pending'

export interface PlaceAuthor {
  userId: string
  name: string
  email: string
  role: UserRole
  authMethod: AuthMethod
}

export interface PlacePhoto {
  id: string
  url: string
  alt: string
  uploadedAt: string
}

export interface PlaceReview {
  id: string
  rating: number
  comment: string
  createdAt: string
  updatedAt: string
  author: PlaceAuthor
}

export interface Place {
  id: string
  name: string
  category: PlaceCategory
  city: string
  address: string
  coordinates: [number, number]
  description: string
  tags: string[]
  products: string[]
  verified: boolean
  dedicatedKitchen: boolean
  source: 'demo' | 'community'
  approvalStatus: PlaceApprovalStatus
  submittedBy: PlaceAuthor
  approvedByName?: string
  approvedAt?: string
  updatedAt: string
  photos: PlacePhoto[]
  reviews: PlaceReview[]
}

export interface NewPlaceInput {
  name: string
  category: PlaceCategory
  city: string
  address: string
  coordinates: [number, number]
  description: string
  tags: string[]
  products: string[]
  verified: boolean
  dedicatedKitchen: boolean
}

const API_BASE_URL = '/api'

export const defaultMapCenter: [number, number] = [-34.603722, -58.381592]
export const defaultMapZoom = 12

export const suggestedPlaceTags = [
  '100% sin TACC',
  'cocina dedicada',
  'delivery',
  'take away',
  'economico',
  'pasteleria',
  'congelados',
  'desayuno',
  'brunch',
  'supermercado',
  'freezer',
  'opciones veganas',
]

export const placeCategoryMeta: Record<
  PlaceCategory,
  {
    label: string
    shortLabel: string
    color: string
  }
> = {
  restaurant: {
    label: 'Restaurante',
    shortLabel: 'Resto',
    color: '#d85b34',
  },
  store: {
    label: 'Negocio especializado',
    shortLabel: 'Tienda',
    color: '#2f6a5e',
  },
  market: {
    label: 'Supermercado o almacen',
    shortLabel: 'Mercado',
    color: '#e0a538',
  },
  productSpot: {
    label: 'Punto con productos',
    shortLabel: 'Productos',
    color: '#46739c',
  },
}

export const placeCategoryOptions: Array<{
  value: PlaceCategory
  label: string
}> = [
  { value: 'restaurant', label: placeCategoryMeta.restaurant.label },
  { value: 'store', label: placeCategoryMeta.store.label },
  { value: 'market', label: placeCategoryMeta.market.label },
  { value: 'productSpot', label: placeCategoryMeta.productSpot.label },
]

function sortByUniqNormalized(values: string[]) {
  const seen = new Set<string>()

  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase()

      if (seen.has(key)) {
        return false
      }

      seen.add(key)
      return true
    })
}

function normalizePlace(place: Place): Place {
  return {
    ...place,
    tags: sortByUniqNormalized(place.tags ?? []),
    products: sortByUniqNormalized(place.products ?? []),
    photos: Array.isArray(place.photos) ? place.photos : [],
    reviews: Array.isArray(place.reviews) ? place.reviews : [],
  }
}

async function readApiResponse<T>(response: Response) {
  const rawBody = await response.text()
  const data = rawBody
    ? (JSON.parse(rawBody) as T | { message?: string })
    : null

  if (!response.ok) {
    const message =
      typeof data === 'object' && data !== null && 'message' in data
        ? data.message
        : rawBody || 'No pude completar la operacion.'

    throw new Error(message || 'No pude completar la operacion.')
  }

  if (data === null) {
    throw new Error('El backend devolvio una respuesta vacia.')
  }

  return data as T
}

function buildPlaceFormData(input: {
  place: NewPlaceInput
  actor: AuthUser
  photos: File[]
}) {
  const formData = new FormData()

  formData.set('actor', JSON.stringify(input.actor))
  formData.set('name', input.place.name.trim())
  formData.set('category', input.place.category)
  formData.set('city', input.place.city.trim())
  formData.set('address', input.place.address.trim())
  formData.set('description', input.place.description.trim())
  formData.set('coordinates', JSON.stringify(input.place.coordinates))
  formData.set('tags', JSON.stringify(sortByUniqNormalized(input.place.tags)))
  formData.set(
    'products',
    JSON.stringify(sortByUniqNormalized(input.place.products)),
  )
  formData.set('verified', String(input.place.verified))
  formData.set('dedicatedKitchen', String(input.place.dedicatedKitchen))

  input.photos.forEach((photo) => {
    formData.append('photos', photo)
  })

  return formData
}

export function sortPlaces(places: Place[]) {
  return [...places].sort((left, right) => {
    if (left.approvalStatus !== right.approvalStatus) {
      return left.approvalStatus === 'approved' ? -1 : 1
    }

    if (left.verified !== right.verified) {
      return Number(right.verified) - Number(left.verified)
    }

    if (left.dedicatedKitchen !== right.dedicatedKitchen) {
      return Number(right.dedicatedKitchen) - Number(left.dedicatedKitchen)
    }

    return right.updatedAt.localeCompare(left.updatedAt)
  })
}

export function getPlaceRatingSummary(place: Place) {
  const reviewCount = place.reviews.length

  if (reviewCount === 0) {
    return {
      averageRating: null,
      reviewCount: 0,
    }
  }

  const total = place.reviews.reduce((sum, review) => sum + review.rating, 0)

  return {
    averageRating: total / reviewCount,
    reviewCount,
  }
}

export async function getPlaces() {
  let response: Response

  try {
    response = await fetch(`${API_BASE_URL}/places`)
  } catch {
    throw new Error(
      'No pude conectarme con el backend. Usá `docker compose up --build` o levantá Postgres antes de correr la app.',
    )
  }

  const places = await readApiResponse<Place[]>(response)
  return sortPlaces(places.map(normalizePlace))
}

export async function createPlace(input: {
  place: NewPlaceInput
  actor: AuthUser
  photos: File[]
}) {
  const response = await fetch(`${API_BASE_URL}/places`, {
    method: 'POST',
    body: buildPlaceFormData(input),
  })

  const place = await readApiResponse<Place>(response)
  return normalizePlace(place)
}

export async function approvePlace(input: {
  placeId: string
  actor: AuthUser
}) {
  const response = await fetch(`${API_BASE_URL}/places/${input.placeId}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      actor: input.actor,
    }),
  })

  const place = await readApiResponse<Place>(response)
  return normalizePlace(place)
}

export async function upsertPlaceReview(input: {
  placeId: string
  actor: AuthUser
  rating: number
  comment: string
}) {
  const response = await fetch(`${API_BASE_URL}/places/${input.placeId}/reviews`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      actor: input.actor,
      rating: input.rating,
      comment: input.comment.trim(),
    }),
  })

  const place = await readApiResponse<Place>(response)
  return normalizePlace(place)
}

export const placesQueryOptions = queryOptions({
  queryKey: ['places'],
  queryFn: getPlaces,
  staleTime: 1000 * 15,
})

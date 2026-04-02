export type Language = 'es' | 'en'
export type UserRole = 'admin' | 'member'
export type ListingKind = 'physical' | 'online'
export type KnownListingCategory =
  | 'restaurant'
  | 'store'
  | 'market'
  | 'productSpot'
  | 'onlineStore'
export type ListingCategory = KnownListingCategory | (string & {})
export type ApprovalStatus = 'approved' | 'pending' | 'rejected'

export interface SessionUser {
  id: string
  email: string
  name: string
  role: UserRole
}

export interface ListingPhoto {
  id: string
  key: string | null
  url: string
  alt: string
  uploadedAt: string
  uploadedBy?: ListingAuthor | null
}

export interface ReviewPhoto {
  id: string
  key: string | null
  url: string
  alt: string
  uploadedAt: string
  uploadedBy?: ListingAuthor | null
}

export interface ListingAuthor {
  userId: string | null
  name: string
  email: string
  role: UserRole
}

export interface ListingReview {
  id: string
  rating: number
  comment: string
  createdAt: string
  updatedAt: string
  photos: ReviewPhoto[]
  author: ListingAuthor
}

export interface Listing {
  id: string
  kind: ListingKind
  name: string
  category: ListingCategory
  city: string | null
  address: string | null
  coordinates: [number, number] | null
  websiteUrl: string | null
  description: string
  tags: string[]
  products: string[]
  verified: boolean
  dedicatedKitchen: boolean
  source: string
  approvalStatus: ApprovalStatus
  submittedBy: ListingAuthor
  approvedByName: string | null
  approvedAt: string | null
  createdAt: string
  updatedAt: string
  photos: ListingPhoto[]
  reviews: ListingReview[]
}

export interface SessionPayload {
  authConfigured: boolean
  uploadConfigured: boolean
  csrfToken: string
  user: SessionUser | null
}

export interface CreateListingInput {
  kind: ListingKind
  name: string
  category: ListingCategory
  city: string
  address: string
  coordinates: [number, number] | null
  websiteUrl: string
  description: string
  tags: string[]
  products: string[]
  dedicatedKitchen: boolean
  verified: boolean
  photoKeys: string[]
}

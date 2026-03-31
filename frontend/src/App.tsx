import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Map as PigeonMap, Marker } from 'pigeon-maps'
import { osm } from 'pigeon-maps/providers'
import { generateReactHelpers, generateUploadDropzone } from '@uploadthing/react'
import '@uploadthing/react/styles.css'
import { createListing, fetchAdminQueue, fetchListings, fetchSession, logout, moderateListing, submitReview } from './api'
import { searchAddress, type GeocodingResult } from './geocoding'
import {
  categoryLabels,
  copy,
  defaultLanguage,
  kindLabels,
  languageStorageKey,
  onlineCategoryOptions,
  physicalCategoryOptions,
} from './i18n'
import type {
  CreateListingInput,
  KnownListingCategory,
  Language,
  Listing,
  ListingKind,
  SessionPayload,
} from './types'
import './styles.css'

const defaultCenter: [number, number] = [-34.603722, -58.381592]

const categoryAccent: Record<KnownListingCategory, string> = {
  restaurant: '#eb6f3d',
  store: '#0f766e',
  market: '#d5a021',
  productSpot: '#3c78b7',
  onlineStore: '#5b4fc9',
}
const fallbackCategoryAccent = '#4a675f'
const placeholderWebsiteHosts = new Set(['example.com', 'www.example.com'])

const ListingUploadDropzone = generateUploadDropzone<any>({
  url: '/api/uploadthing',
})
const { useUploadThing: useListingUpload } = generateReactHelpers<any>({
  url: '/api/uploadthing',
})

type CategoryFilter = string | 'all'

interface UploadRef {
  key: string
  url: string
  name: string
}

interface PendingUploadPreview {
  id: string
  name: string
  url: string
}

interface ListingDraft {
  kind: ListingKind
  name: string
  category: string
  city: string
  address: string
  websiteUrl: string
  description: string
  tagsText: string
  productsText: string
  verified: boolean
  coordinates: [number, number] | null
  locationLabel: string
}

function isKnownCategory(category: string): category is KnownListingCategory {
  return Object.hasOwn(categoryAccent, category)
}

function getCategoryAccent(category: string) {
  return isKnownCategory(category) ? categoryAccent[category] : fallbackCategoryAccent
}

function humanizeCategory(category: string) {
  const normalized = category
    .replace(/([a-z\u00e0-\u00ff])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return category
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function getCategoryLabel(language: Language, category: string) {
  return isKnownCategory(category) ? categoryLabels[language][category] : humanizeCategory(category)
}

function normalizeCategoryInput(kind: ListingKind, value: string) {
  const normalized = value.trim().replace(/\s+/g, ' ')
  const fallback = kind === 'online' ? 'onlineStore' : 'restaurant'

  if (!normalized) {
    return fallback
  }

  const knownCategories = kind === 'online' ? onlineCategoryOptions : physicalCategoryOptions
  const folded = normalized.toLocaleLowerCase('es-AR')

  for (const category of knownCategories) {
    const aliases = [
      category,
      categoryLabels.es[category],
      categoryLabels.en[category],
    ]

    if (aliases.some((alias) => alias.toLocaleLowerCase('es-AR') === folded)) {
      return category
    }
  }

  return normalized
}

function hasPublicWebsiteUrl(value: string | null): value is string {
  if (!value) {
    return false
  }

  try {
    const url = new URL(value)
    return !placeholderWebsiteHosts.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

function createDraft(
  kind: ListingKind = 'physical',
  language: Language = defaultLanguage,
): ListingDraft {
  const defaultCategory = kind === 'online' ? categoryLabels[language].onlineStore : categoryLabels[language].restaurant

  return {
    kind,
    name: '',
    category: defaultCategory,
    city: '',
    address: '',
    websiteUrl: '',
    description: '',
    tagsText: '',
    productsText: '',
    verified: false,
    coordinates: null,
    locationLabel: '',
  }
}

function splitCommaList(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function validateDraft(draft: ListingDraft, language: Language) {
  if (draft.name.trim().length < 2) {
    return language === 'es' ? 'Completá el nombre.' : 'Add a name.'
  }

  if (normalizeCategoryInput(draft.kind, draft.category).trim().length < 2) {
    return language === 'es' ? 'Elegí o escribí una categoría.' : 'Choose or type a category.'
  }

  if (draft.description.trim().length < 12) {
    return language === 'es'
      ? 'La descripción tiene que tener al menos 12 caracteres.'
      : 'Description must be at least 12 characters long.'
  }

  if (draft.kind === 'physical') {
    if (!draft.coordinates) {
      return language === 'es'
        ? 'Seleccioná una ubicación en el mapa para el lugar físico.'
        : 'Pick a map location for the physical place.'
    }

    if (draft.city.trim().length < 2) {
      return language === 'es' ? 'Completá la ciudad o barrio.' : 'Fill in the city or area.'
    }

    if (draft.address.trim().length < 3) {
      return language === 'es' ? 'Completá la dirección.' : 'Fill in the address.'
    }

    return null
  }

  if (!draft.websiteUrl.trim()) {
    return language === 'es' ? 'Completá la URL del sitio web.' : 'Add the website URL.'
  }

  try {
    new URL(draft.websiteUrl.trim())
  } catch {
    return language === 'es' ? 'Completá una URL válida.' : 'Enter a valid URL.'
  }

  return null
}

function mergeUploadRefs(current: UploadRef[], incoming: UploadRef[]) {
  const byKey = new Map(current.map((file) => [file.key, file]))

  incoming.forEach((file) => {
    byKey.set(file.key, file)
  })

  return Array.from(byKey.values())
}

function formatDate(value: string | null, language: Language) {
  if (!value) {
    return ''
  }

  return new Intl.DateTimeFormat(language === 'es' ? 'es-AR' : 'en-US', {
    day: 'numeric',
    month: 'short',
  }).format(new Date(value))
}

function getRatingSummary(listing: Listing) {
  const reviewCount = listing.reviews.length

  if (reviewCount === 0) {
    return {
      averageRating: null,
      reviewCount,
    }
  }

  return {
    averageRating:
      listing.reviews.reduce((total, review) => total + review.rating, 0) /
      reviewCount,
    reviewCount,
  }
}

function formatRatingValue(value: number, language: Language) {
  return new Intl.NumberFormat(language === 'es' ? 'es-AR' : 'en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function latRad(lat: number) {
  const sin = Math.sin((lat * Math.PI) / 180)
  const radians = Math.log((1 + sin) / (1 - sin)) / 2
  return clamp(radians, -Math.PI, Math.PI) / 2
}

function zoomForFraction(mapPx: number, fraction: number) {
  if (!Number.isFinite(fraction) || fraction <= 0) {
    return 16
  }

  return Math.floor(Math.log(mapPx / 256 / fraction) / Math.LN2)
}

function getViewportForListings(listings: Listing[]) {
  if (typeof window === 'undefined') {
    return null
  }

  const coordinates = listings
    .map((listing) => listing.coordinates)
    .filter((value): value is [number, number] => value !== null)

  if (coordinates.length === 0) {
    return null
  }

  if (coordinates.length === 1) {
    return {
      center: coordinates[0],
      zoom: 14,
    }
  }

  const latitudes = coordinates.map(([lat]) => lat)
  const longitudes = coordinates.map(([, lng]) => lng)
  const minLat = Math.min(...latitudes)
  const maxLat = Math.max(...latitudes)
  const minLng = Math.min(...longitudes)
  const maxLng = Math.max(...longitudes)
  const latFraction = Math.abs((latRad(maxLat) - latRad(minLat)) / Math.PI)
  const lngDiff = maxLng - minLng
  const lngFraction = ((lngDiff % 360) + 360) % 360 / 360
  const isMobile = window.matchMedia('(max-width: 768px)').matches
  const usableWidth = window.innerWidth * (isMobile ? 0.7 : 0.58)
  const usableHeight = window.innerHeight * (isMobile ? 0.42 : 0.72)
  const zoom = clamp(
    Math.min(zoomForFraction(usableWidth, lngFraction), zoomForFraction(usableHeight, latFraction)),
    10,
    15,
  )
  const latSpan = maxLat - minLat
  const lngSpan = maxLng - minLng
  const latOffset = latSpan * (isMobile ? 0.08 : 0.03)
  const lngOffset = lngSpan * (isMobile ? 0.08 : 0.06)

  return {
    center: [
      (minLat + maxLat) / 2 + latOffset,
      (minLng + maxLng) / 2 - lngOffset,
    ] as [number, number],
    zoom,
  }
}

function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const [language, setLanguage] = useState<Language>(() => {
    if (typeof window === 'undefined') {
      return defaultLanguage
    }

    const saved = window.localStorage.getItem(languageStorageKey)
    return saved === 'en' ? 'en' : 'es'
  })
  const [session, setSession] = useState<SessionPayload | null>(null)
  const [loadingSession, setLoadingSession] = useState(true)
  const [listings, setListings] = useState<Listing[]>([])
  const [pendingListings, setPendingListings] = useState<Listing[]>([])
  const [loadingListings, setLoadingListings] = useState(true)
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [globalNotice, setGlobalNotice] = useState<{
    tone: 'info' | 'success'
    message: string
  } | null>(null)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mapCenter, setMapCenter] = useState<[number, number]>(defaultCenter)
  const [mapZoom, setMapZoom] = useState(12)
  const [didAutoLocateMobile, setDidAutoLocateMobile] = useState(false)
  const [didInitialFitVisibleListings, setDidInitialFitVisibleListings] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [draft, setDraft] = useState<ListingDraft>(() => createDraft('physical', language))
  const [addressQuery, setAddressQuery] = useState('')
  const [addressResults, setAddressResults] = useState<GeocodingResult[]>([])
  const [addressStatus, setAddressStatus] = useState<string | null>(null)
  const [uploadRefs, setUploadRefs] = useState<UploadRef[]>([])
  const [formPending, setFormPending] = useState(false)
  const [formStatus, setFormStatus] = useState<string | null>(null)
  const [reviewComment, setReviewComment] = useState('')
  const [reviewRating, setReviewRating] = useState(5)
  const [reviewPending, setReviewPending] = useState(false)
  const [reviewStatus, setReviewStatus] = useState<string | null>(null)
  const [adminStatus, setAdminStatus] = useState<string | null>(null)
  const deferredSearch = useDeferredValue(search.trim().toLowerCase())
  const t = copy[language]

  useEffect(() => {
    window.localStorage.setItem(languageStorageKey, language)
  }, [language])

  useEffect(() => {
    void refreshSession()
    void refreshListings()
  }, [])

  useEffect(() => {
    if (session?.user?.role === 'admin' && location.pathname === '/admin') {
      void refreshPendingListings()
    }
  }, [location.pathname, session?.user?.role])

  useEffect(() => {
    if (!globalNotice) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setGlobalNotice(null)
    }, 7000)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [globalNotice])

  useEffect(() => {
    if (
      loadingListings ||
      didAutoLocateMobile ||
      location.pathname !== '/' ||
      typeof window === 'undefined'
    ) {
      return
    }

    const hasApprovedPhysicalListings = listings.some(
      (listing) => listing.kind === 'physical' && listing.approvalStatus === 'approved',
    )

    if (
      !window.matchMedia('(max-width: 768px)').matches ||
      !navigator.geolocation ||
      hasApprovedPhysicalListings
    ) {
      setDidAutoLocateMobile(true)
      return
    }

    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setMapCenter([coords.latitude, coords.longitude])
        setMapZoom(14)
        setDidAutoLocateMobile(true)
      },
      () => {
        setDidAutoLocateMobile(true)
      },
      {
        enableHighAccuracy: true,
        maximumAge: 60_000,
        timeout: 8_000,
      },
    )
  }, [didAutoLocateMobile, listings, loadingListings, location.pathname])

  const approvedPhysicalListings = useMemo(
    () =>
      listings.filter(
        (listing) => listing.kind === 'physical' && listing.approvalStatus === 'approved',
      ),
    [listings],
  )
  const approvedOnlineListings = useMemo(
    () =>
      listings.filter(
        (listing) => listing.kind === 'online' && listing.approvalStatus === 'approved',
      ),
    [listings],
  )

  const filteredPhysicalListings = useMemo(
    () =>
      approvedPhysicalListings.filter((listing) => {
        if (categoryFilter !== 'all' && listing.category !== categoryFilter) {
          return false
        }

        if (!listing.verified) {
          return false
        }

        if (!deferredSearch) {
          return true
        }

        const searchable = [
          listing.name,
          listing.description,
          listing.city ?? '',
          listing.address ?? '',
          ...listing.tags,
          ...listing.products,
        ]
          .join(' ')
          .toLowerCase()

        return searchable.includes(deferredSearch)
      }),
    [approvedPhysicalListings, categoryFilter, deferredSearch],
  )

  const filteredOnlineListings = useMemo(
    () =>
      approvedOnlineListings.filter((listing) => {
        if (!deferredSearch) {
          return true
        }

        const searchable = [
          listing.name,
          listing.description,
          listing.websiteUrl ?? '',
          ...listing.tags,
          ...listing.products,
        ]
          .join(' ')
          .toLowerCase()

        return searchable.includes(deferredSearch)
      }),
    [approvedOnlineListings, deferredSearch],
  )

  const selectedListing =
    filteredPhysicalListings.find((listing) => listing.id === selectedId) ?? null

  useEffect(() => {
    if (selectedId && !filteredPhysicalListings.some((listing) => listing.id === selectedId)) {
      setSelectedId(null)
    }
  }, [filteredPhysicalListings, selectedId])

  useEffect(() => {
    if (
      didInitialFitVisibleListings ||
      loadingListings ||
      location.pathname !== '/' ||
      selectedId ||
      formOpen ||
      filteredPhysicalListings.length === 0
    ) {
      return
    }

    const viewport = getViewportForListings(filteredPhysicalListings)

    if (!viewport) {
      return
    }

    setMapCenter(viewport.center)
    setMapZoom(viewport.zoom)
    setDidInitialFitVisibleListings(true)
  }, [
    didInitialFitVisibleListings,
    filteredPhysicalListings,
    formOpen,
    loadingListings,
    location.pathname,
    selectedId,
  ])

  const groupedOnlineListings = useMemo(() => {
    const groups = new globalThis.Map<string, Listing[]>()

    filteredOnlineListings.forEach((listing) => {
      const keys = listing.products.length > 0 ? listing.products : ['Otros']

      keys.forEach((product) => {
        const normalized = product.trim() || 'Otros'
        const current = groups.get(normalized) ?? []
        current.push(listing)
        groups.set(normalized, current)
      })
    })

    return Array.from(groups.entries()).sort((left, right) =>
      left[0].localeCompare(right[0], language === 'es' ? 'es' : 'en'),
    )
  }, [filteredOnlineListings, language])

  const physicalCategoryFilterOptions = useMemo(() => {
    const customCategories = Array.from(
      new Set(
        approvedPhysicalListings
          .map((listing) => listing.category)
          .filter((category) => !isKnownCategory(category)),
      ),
    ).sort((left, right) =>
      getCategoryLabel(language, left).localeCompare(
        getCategoryLabel(language, right),
        language === 'es' ? 'es' : 'en',
      ),
    )

    return [...physicalCategoryOptions, ...customCategories]
  }, [approvedPhysicalListings, language])

  async function refreshSession() {
    setLoadingSession(true)

    try {
      const nextSession = await fetchSession()
      setSession(nextSession)
      return nextSession
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : 'No pude leer la sesión.')
      return null
    } finally {
      setLoadingSession(false)
    }
  }

  async function refreshListings() {
    setLoadingListings(true)

    try {
      const nextListings = await fetchListings({ kind: 'all' })
      setListings(nextListings)
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : 'No pude cargar los items.')
    } finally {
      setLoadingListings(false)
    }
  }

  async function refreshPendingListings() {
    try {
      const queue = await fetchAdminQueue()
      setPendingListings(queue)
    } catch (error) {
      setAdminStatus(error instanceof Error ? error.message : 'No pude cargar el panel admin.')
    }
  }

  function handleLanguageToggle() {
    setLanguage((current) => (current === 'es' ? 'en' : 'es'))
  }

  function handleOpenForm(kind: ListingKind) {
    setDraft(createDraft(kind, language))
    setAddressQuery('')
    setAddressResults([])
    setAddressStatus(null)
    setUploadRefs([])
    setFormStatus(null)
    setFormOpen(true)
  }

  function handleSelectListing(listing: Listing) {
    setSelectedId(listing.id)

    if (listing.coordinates) {
      setMapCenter(listing.coordinates)
      setMapZoom(14)
      if (location.pathname !== '/') {
        navigate('/')
      }
    }
  }

  function updateDraft<K extends keyof ListingDraft>(key: K, value: ListingDraft[K]) {
    setDraft((current) => ({
      ...current,
      [key]: value,
    }))
  }

  async function handleAddressSearch() {
    setAddressStatus(null)
    const query = addressQuery.trim() || [draft.address, draft.city].filter(Boolean).join(', ')

    if (!addressQuery.trim() && query) {
      setAddressQuery(query)
    }

    try {
      const results = await searchAddress(query, language)
      setAddressResults(results)
      setAddressStatus(results.length === 0 ? t.addressNoResults : null)
    } catch (error) {
      setAddressResults([])
      setAddressStatus(error instanceof Error ? error.message : 'Address search failed.')
    }
  }

  function applyGeocodingResult(result: GeocodingResult) {
    setDraft((current) => ({
      ...current,
      city: result.city || current.city,
      address: result.label,
      coordinates: result.coordinates,
      locationLabel: result.label,
    }))
    setMapCenter(result.coordinates)
    setMapZoom(15)
    setAddressResults([])
  }

  function handleMapClick({ latLng }: { latLng: [number, number] }) {
    if (draft.kind !== 'physical' || !formOpen) {
      setSelectedId(null)
      return
    }

    setDraft((current) => ({
      ...current,
      coordinates: latLng,
      locationLabel:
        language === 'es'
          ? 'Ubicación elegida manualmente en el mapa'
          : 'Location selected directly on the map',
    }))
  }

  async function handleCreateListing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!session?.user) {
      setFormStatus(t.signInToSubmit)
      return
    }

    if (!session.csrfToken) {
      setFormStatus('CSRF token missing.')
      return
    }

    const validationError = validateDraft(draft, language)

    if (validationError) {
      setFormStatus(validationError)
      return
    }

    setFormPending(true)
    setFormStatus(null)

    try {
      const activeSession = await fetchSession()
      setSession(activeSession)

      if (!activeSession.user) {
        setFormStatus(t.sessionExpiredToSubmit)
        return
      }

      const payload: CreateListingInput = {
        kind: draft.kind,
        name: draft.name.trim(),
        category: normalizeCategoryInput(draft.kind, draft.category),
        city: draft.city.trim(),
        address: draft.address.trim(),
        coordinates: draft.coordinates,
        websiteUrl: draft.websiteUrl.trim(),
        description: draft.description.trim(),
        tags: splitCommaList(draft.tagsText),
        products: splitCommaList(draft.productsText),
        dedicatedKitchen: false,
        verified: activeSession.user.role === 'admin' ? draft.verified : false,
        photoKeys: uploadRefs.map((photo) => photo.key),
      }

      const createdListing = await createListing(payload, activeSession.csrfToken)
      await refreshListings()

      if (activeSession.user.role === 'admin') {
        await refreshPendingListings()
      }

      const isVisibleOnPublicSurface =
        createdListing.approvalStatus === 'approved' &&
        (createdListing.kind !== 'physical' || createdListing.verified)

      setGlobalNotice({
        tone: isVisibleOnPublicSurface ? 'success' : 'info',
        message:
          createdListing.approvalStatus !== 'approved'
            ? t.submissionPendingReview
            : createdListing.kind === 'physical' && !createdListing.verified
              ? t.submissionSavedNotVisible
              : t.submissionPublished,
      })

      if (
        createdListing.kind === 'physical' &&
        createdListing.approvalStatus === 'approved' &&
        createdListing.verified &&
        createdListing.coordinates
      ) {
        setSelectedId(createdListing.id)
        setMapCenter(createdListing.coordinates)
        setMapZoom(15)
      }

      setFormOpen(false)
      setDraft(createDraft('physical', language))
      setUploadRefs([])
      setFormStatus(null)
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Inicia sesion para continuar.') {
          setFormStatus(t.sessionBackendMismatch)
          return
        }

        setFormStatus(error.message)
        return
      }

      setFormStatus(t.sessionSyncError)
    } finally {
      setFormPending(false)
    }
  }

  async function handleSubmitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!session?.user || !selectedListing || !session.csrfToken) {
      setReviewStatus(language === 'es' ? 'Ingresá para evaluar.' : 'Sign in to review.')
      return
    }

    setReviewPending(true)
    setReviewStatus(null)

    try {
      const updated = await submitReview(
        selectedListing.id,
        {
          rating: reviewRating,
          comment: reviewComment,
        },
        session.csrfToken,
      )

      setListings((current) =>
        current.map((listing) => (listing.id === updated.id ? updated : listing)),
      )
      setReviewComment('')
      setReviewRating(5)
      setReviewStatus(language === 'es' ? 'Reseña guardada.' : 'Review saved.')
    } catch (error) {
      setReviewStatus(error instanceof Error ? error.message : 'Could not save review.')
    } finally {
      setReviewPending(false)
    }
  }

  async function handleModeration(
    listingId: string,
    approvalStatus: 'approved' | 'pending' | 'rejected',
    verified?: boolean,
  ) {
    if (!session?.csrfToken) {
      return
    }

    try {
      setAdminStatus(null)
      await moderateListing(listingId, { approvalStatus, verified }, session.csrfToken)
      await refreshListings()
      await refreshPendingListings()
    } catch (error) {
      setAdminStatus(error instanceof Error ? error.message : 'Could not moderate listing.')
    }
  }

  async function handleLogout() {
    if (!session?.csrfToken) {
      return
    }

    try {
      await logout(session.csrfToken)
      await refreshSession()
      navigate('/')
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : 'No pude cerrar la sesión.')
    }
  }

  const authBaseHref = '/api/auth/login'
  const authWarning = !loadingSession && session && !session.authConfigured
  const uploadWarning = !loadingSession && session && !session.uploadConfigured

  return (
    <div className="shell">
      <div className="brand-cloud">
        <div className="route-switch">
          <NavLink to="/" className={({ isActive }) => navClass(isActive)}>
            {t.mapView}
          </NavLink>
          <NavLink to="/catalog" className={({ isActive }) => navClass(isActive)}>
            {t.catalogView}
          </NavLink>
          <NavLink to="/register" className={({ isActive }) => navClass(isActive)}>
            {t.registerView}
          </NavLink>
          {session?.user?.role === 'admin' ? (
            <NavLink to="/admin" className={({ isActive }) => navClass(isActive)}>
              {t.adminView}
            </NavLink>
          ) : null}
        </div>
      </div>

      <div className="utility-cloud">
        <button type="button" className="ghost-button" onClick={handleLanguageToggle}>
          {language === 'es' ? 'EN' : 'ES'}
        </button>

        {loadingSession ? (
          <span className="session-pill">...</span>
        ) : session?.user ? (
          <>
            <span className="session-pill">{session.user.name}</span>
            <button type="button" className="ghost-button" onClick={handleLogout}>
              {t.signOut}
            </button>
          </>
        ) : (
          <a className="ghost-button" href={`${authBaseHref}?screenHint=sign-in&returnTo=${encodeURIComponent(location.pathname)}`}>
            {t.signIn}
          </a>
        )}
      </div>

      {authWarning ? <FloatingAlert tone="warning">{t.authMissing}</FloatingAlert> : null}
      {uploadWarning ? <FloatingAlert tone="info">{t.uploadMissing}</FloatingAlert> : null}
      {globalError ? <FloatingAlert tone="danger">{globalError}</FloatingAlert> : null}
      {globalNotice ? <FloatingAlert tone={globalNotice.tone}>{globalNotice.message}</FloatingAlert> : null}

      <Routes>
        <Route
          path="/"
          element={
            <MapView
              language={language}
              listings={filteredPhysicalListings}
              selectedListing={selectedListing?.kind === 'physical' ? selectedListing : null}
              loading={loadingListings}
              search={search}
              onSearchChange={(value) =>
                startTransition(() => {
                  setSearch(value)
                })
              }
              categoryFilter={categoryFilter}
              onCategoryFilterChange={setCategoryFilter}
              categoryOptions={physicalCategoryFilterOptions}
              mapCenter={mapCenter}
              mapZoom={mapZoom}
              onMapCenterChange={setMapCenter}
              onMapZoomChange={setMapZoom}
              onMapClick={handleMapClick}
              onSelectListing={handleSelectListing}
              onClearSelectedListing={() => setSelectedId(null)}
              formOpen={formOpen}
              draft={draft}
              onOpenForm={handleOpenForm}
              onDraftChange={updateDraft}
              onAddressQueryChange={setAddressQuery}
              addressQuery={addressQuery}
              addressResults={addressResults}
              addressStatus={addressStatus}
              onAddressSearch={() => void handleAddressSearch()}
              onApplyGeocodingResult={applyGeocodingResult}
              onCloseForm={() => setFormOpen(false)}
              onCreateListing={handleCreateListing}
              formPending={formPending}
              formStatus={formStatus}
              onFormStatusChange={setFormStatus}
              session={session}
              uploadRefs={uploadRefs}
              onUploadRefsChange={setUploadRefs}
              reviewComment={reviewComment}
              reviewRating={reviewRating}
              onReviewCommentChange={setReviewComment}
              onReviewRatingChange={setReviewRating}
              onSubmitReview={handleSubmitReview}
              reviewPending={reviewPending}
              reviewStatus={reviewStatus}
            />
          }
        />
        <Route
          path="/catalog"
          element={
            <CatalogView
              language={language}
              groupedListings={groupedOnlineListings}
              onSelectListing={handleSelectListing}
            />
          }
        />
        <Route
          path="/register"
          element={<RegisterView language={language} />}
        />
        <Route
          path="/admin"
          element={
            <AdminView
              language={language}
              session={session}
              listings={pendingListings}
              status={adminStatus}
              onModerate={handleModeration}
            />
          }
        />
      </Routes>
    </div>
  )
}

function navClass(isActive: boolean) {
  return isActive ? 'nav-pill nav-pill-active' : 'nav-pill'
}

function FloatingAlert({
  children,
  tone,
}: {
  children: string
  tone: 'warning' | 'danger' | 'info' | 'success'
}) {
  return <div className={`floating-alert floating-alert-${tone}`}>{children}</div>
}

function MapListingMarker({
  listing,
  anchor,
  selected,
  onSelect,
  left,
  top,
}: {
  listing: Listing
  anchor: [number, number]
  selected: boolean
  onSelect: (listing: Listing) => void
  left?: number
  top?: number
}) {
  const accent = getCategoryAccent(listing.category)

  return (
    <Marker
      anchor={anchor}
      left={left}
      top={top}
      color={accent}
      width={selected ? 56 : 42}
      hover={selected}
      onClick={({ event }) => {
        event.stopPropagation?.()
        onSelect(listing)
      }}
    />
  )
}

function MapView(props: {
  language: Language
  listings: Listing[]
  selectedListing: Listing | null
  loading: boolean
  search: string
  onSearchChange: (value: string) => void
  categoryFilter: CategoryFilter
  onCategoryFilterChange: (value: CategoryFilter) => void
  categoryOptions: string[]
  mapCenter: [number, number]
  mapZoom: number
  onMapCenterChange: (value: [number, number]) => void
  onMapZoomChange: (value: number) => void
  onMapClick: (input: { latLng: [number, number] }) => void
  onSelectListing: (listing: Listing) => void
  onClearSelectedListing: () => void
  formOpen: boolean
  draft: ListingDraft
  onOpenForm: (kind: ListingKind) => void
  onDraftChange: <K extends keyof ListingDraft>(key: K, value: ListingDraft[K]) => void
  addressQuery: string
  onAddressQueryChange: (value: string) => void
  addressResults: GeocodingResult[]
  addressStatus: string | null
  onAddressSearch: () => void
  onApplyGeocodingResult: (result: GeocodingResult) => void
  onCloseForm: () => void
  onCreateListing: (event: FormEvent<HTMLFormElement>) => void
  formPending: boolean
  formStatus: string | null
  onFormStatusChange: (value: string | null) => void
  session: SessionPayload | null
  uploadRefs: UploadRef[]
  onUploadRefsChange: (value: UploadRef[]) => void
  reviewComment: string
  reviewRating: number
  onReviewCommentChange: (value: string) => void
  onReviewRatingChange: (value: number) => void
  onSubmitReview: (event: FormEvent<HTMLFormElement>) => void
  reviewPending: boolean
  reviewStatus: string | null
}) {
  const {
    language,
    listings,
    selectedListing,
    loading,
    search,
    onSearchChange,
    categoryFilter,
    onCategoryFilterChange,
    categoryOptions,
    mapCenter,
    mapZoom,
    onMapCenterChange,
    onMapZoomChange,
    onMapClick,
    onSelectListing,
    onClearSelectedListing,
    formOpen,
    draft,
    onOpenForm,
    onDraftChange,
    addressQuery,
    onAddressQueryChange,
    addressResults,
    addressStatus,
    onAddressSearch,
    onApplyGeocodingResult,
    onCloseForm,
    onCreateListing,
    formPending,
    formStatus,
    onFormStatusChange,
    session,
    uploadRefs,
    onUploadRefsChange,
    reviewComment,
    reviewRating,
    onReviewCommentChange,
    onReviewRatingChange,
    onSubmitReview,
    reviewPending,
    reviewStatus,
  } = props
  const t = copy[language]
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false)
  const [pendingUploadPreviews, setPendingUploadPreviews] = useState<PendingUploadPreview[]>([])
  const [uploadingPhotos, setUploadingPhotos] = useState(false)
  const [hoverRating, setHoverRating] = useState<number | null>(null)
  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  const selectedListingRating = selectedListing
    ? getRatingSummary(selectedListing)
    : null
  const { startUpload: startCameraUpload } = useListingUpload('listingImage', {
    headers: session?.csrfToken
      ? {
          'X-CSRF-Token': session.csrfToken,
        }
      : undefined,
  })

  function clearPendingUploadPreviews() {
    setPendingUploadPreviews((current) => {
      current.forEach((file) => URL.revokeObjectURL(file.url))
      return []
    })
  }

  function setPendingFiles(files: File[]) {
    clearPendingUploadPreviews()

    if (files.length === 0) {
      setUploadingPhotos(false)
      return
    }

    setPendingUploadPreviews(
      files.map((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}`,
        name: file.name,
        url: URL.createObjectURL(file),
      })),
    )
    setUploadingPhotos(true)
    onFormStatusChange(t.uploadingPhotos)
  }

  function completeUploadedFiles(files: Array<{ key: string; url: string; name: string }>) {
    clearPendingUploadPreviews()
    setUploadingPhotos(false)
    onUploadRefsChange(mergeUploadRefs(uploadRefs, files))

    if (files.length > 0) {
      onFormStatusChange(t.uploadSuccess)
    }
  }

  function failUploadedFiles(error: Error) {
    clearPendingUploadPreviews()
    setUploadingPhotos(false)
    onFormStatusChange(`${t.uploadError} ${error.message}`)
  }

  async function handleCameraFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''

    if (files.length === 0) {
      return
    }

    setPendingFiles(files)

    try {
      const uploaded = await startCameraUpload(files)
      const nextUploads =
        uploaded?.map((file) => ({
          key: file.serverData.key,
          url: file.serverData.url,
          name: file.serverData.name,
        })) ?? []

      completeUploadedFiles(nextUploads)
    } catch (error) {
      failUploadedFiles(error instanceof Error ? error : new Error(t.uploadError))
    }
  }

  useEffect(() => {
    if (!formOpen) {
      clearPendingUploadPreviews()
      setUploadingPhotos(false)
    }
  }, [formOpen])

  useEffect(() => {
    setHoverRating(null)
  }, [selectedListing?.id])

  useEffect(
    () => () => {
      pendingUploadPreviews.forEach((file) => URL.revokeObjectURL(file.url))
    },
    [pendingUploadPreviews],
  )

  return (
    <section className="map-screen">
      <div className="map-search-shell">
        <div className="search-card search-card-map">
          <div className="map-search-bar">
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              className="map-search-input"
              placeholder={t.search}
              aria-label={t.search}
            />
            <span className="search-icon-badge" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="icon-svg">
                <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M16 16l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </span>
            <button
              type="button"
              className={advancedFiltersOpen ? 'filter-icon-button filter-icon-button-active' : 'filter-icon-button'}
              onClick={() => setAdvancedFiltersOpen((current) => !current)}
              aria-expanded={advancedFiltersOpen}
              aria-label={advancedFiltersOpen ? t.hideFilters : t.showFilters}
            >
              <svg viewBox="0 0 24 24" className="icon-svg">
                <path
                  d="M4 7h16M7 12h10M10 17h4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {advancedFiltersOpen ? (
            <div className="advanced-search-panel">
              <div className="filter-grid">
                <label>
                  {t.category}
                  <select
                    value={categoryFilter}
                    onChange={(event) => onCategoryFilterChange(event.target.value as CategoryFilter)}
                    className="compact-select"
                  >
                    <option value="all">{t.allLabel}</option>
                    {categoryOptions.map((category) => (
                      <option key={category} value={category}>
                        {getCategoryLabel(language, category)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="action-row">
                <button type="button" className="ghost-button" onClick={() => onOpenForm('online')}>
                  {t.addOnline}
                </button>
              </div>
            </div>
          ) : null}

          {session?.user ? (
            <div className="map-quick-actions">
              <button type="button" className="solid-button quick-add-button" onClick={() => onOpenForm('physical')}>
                {t.suggestPlace}
              </button>
            </div>
          ) : null}

          {loading ? <p className="helper-text">Loading map...</p> : null}
          {!loading && listings.length === 0 ? <p className="helper-text">{t.emptyMap}</p> : null}
        </div>
      </div>

      <div className="map-overlay-right">
        {selectedListing ? (
          <div className="detail-popup">
            <div className="popup-heading">
              <div>
                <span className="listing-meta" style={{ color: getCategoryAccent(selectedListing.category) }}>
                  {getCategoryLabel(language, selectedListing.category)}
                </span>
                <h2>{selectedListing.name}</h2>
              </div>
              <div className="detail-header-actions">
                <button type="button" className="ghost-button detail-close-button" onClick={onClearSelectedListing}>
                  {t.close}
                </button>
              </div>
            </div>

            <div className="popup-body">
              <p>{selectedListing.description}</p>
              {selectedListing.address ? <p>{selectedListing.address}</p> : null}
              {hasPublicWebsiteUrl(selectedListing.websiteUrl) ? (
                <a href={selectedListing.websiteUrl} target="_blank" rel="noreferrer" className="external-link">
                  {t.website}
                </a>
              ) : null}

              <div className="tag-cloud">
                {selectedListing.tags.map((tag) => (
                  <span key={tag} className="tag-token">
                    {tag}
                  </span>
                ))}
              </div>

              <div className="photo-strip">
                {selectedListing.photos.map((photo) => (
                  <img key={photo.id} src={photo.url} alt={photo.alt} className="photo-thumb" />
                ))}
              </div>

              <div className="review-block">
                <div className="review-summary">
                  <span className="card-title">{t.reviews}</span>
                  <span>
                    {selectedListingRating?.averageRating != null
                      ? formatRatingValue(selectedListingRating.averageRating, language)
                      : language === 'es'
                        ? '0,0'
                        : '0.0'} ({selectedListingRating?.reviewCount ?? 0})
                  </span>
                </div>

                {selectedListing.reviews.length === 0 ? <p>{t.noReviews}</p> : null}
                {selectedListing.reviews.map((review) => (
                  <div key={review.id} className="review-card">
                    <div className="review-card-header">
                      <strong>{review.author.name}</strong>
                      <span>{'★'.repeat(review.rating)}</span>
                    </div>
                    <p>{review.comment}</p>
                    <small>{formatDate(review.updatedAt, language)}</small>
                  </div>
                ))}

                <form className="review-form" onSubmit={onSubmitReview}>
                  <label className="rating-field">
                    {t.ratingLabel}
                    <div
                      className="star-rating"
                      role="radiogroup"
                      aria-label={t.ratingLabel}
                      onMouseLeave={() => setHoverRating(null)}
                    >
                      {[1, 2, 3, 4, 5].map((value) => {
                        const activeValue = hoverRating ?? reviewRating

                        return (
                          <button
                            key={value}
                            type="button"
                            role="radio"
                            aria-checked={reviewRating === value}
                            aria-label={`${value} / 5`}
                            className={`star-button ${activeValue >= value ? 'star-button-active' : ''}`}
                            onClick={() => onReviewRatingChange(value)}
                            onMouseEnter={() => setHoverRating(value)}
                            onFocus={() => setHoverRating(value)}
                            onBlur={() => setHoverRating(null)}
                          >
                            ★
                          </button>
                        )
                      })}
                      <span className="star-rating-value">{reviewRating}/5</span>
                    </div>
                  </label>
                  <label>
                    {t.commentLabel}
                    <textarea
                      value={reviewComment}
                      onChange={(event) => onReviewCommentChange(event.target.value)}
                      rows={3}
                    />
                  </label>
                  <button type="submit" className="solid-button" disabled={reviewPending}>
                    {t.submitReview}
                  </button>
                  {reviewStatus ? <p className="helper-text">{reviewStatus}</p> : null}
                </form>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="map-canvas">
        <PigeonMap
          provider={osm}
          center={mapCenter}
          zoom={mapZoom}
          minZoom={4}
          maxZoom={18}
          animate
          twoFingerDrag
          onClick={onMapClick}
          onBoundsChanged={({ center, zoom }) => {
            onMapCenterChange(center)
            onMapZoomChange(zoom)
          }}
        >
          {listings.map((listing) =>
            listing.coordinates ? (
              <MapListingMarker
                key={listing.id}
                listing={listing}
                anchor={listing.coordinates}
                selected={selectedListing?.id === listing.id}
                onSelect={onSelectListing}
              />
            ) : null,
          )}
        </PigeonMap>
      </div>

      {formOpen ? (
        <div className="form-drawer">
          <form className="drawer-card" onSubmit={onCreateListing}>
            <div className="drawer-header">
              <div>
                <span className="listing-meta">{t.addListing}</span>
                <h3>{draft.kind === 'physical' ? t.addPhysical : t.addOnline}</h3>
              </div>
              <button type="button" className="ghost-button" onClick={onCloseForm}>
                {t.close}
              </button>
            </div>

            <div className="drawer-grid">
              <label>
                {t.name}
                <input
                  value={draft.name}
                  onChange={(event) => onDraftChange('name', event.target.value)}
                  required
                />
              </label>

              <label>
                {t.category}
                <input
                  list={draft.kind === 'online' ? 'online-category-options' : 'physical-category-options'}
                  value={draft.category}
                  onChange={(event) => onDraftChange('category', event.target.value)}
                  placeholder={t.categoryPlaceholder}
                />
                <datalist id="physical-category-options">
                  {physicalCategoryOptions.map((category) => (
                    <option key={category} value={categoryLabels[language][category]} />
                  ))}
                </datalist>
                <datalist id="online-category-options">
                  {onlineCategoryOptions.map((category) => (
                    <option key={category} value={categoryLabels[language][category]} />
                  ))}
                </datalist>
                <small className="input-help">{t.categoryHint}</small>
              </label>

              {draft.kind === 'physical' ? (
                <>
                  <label>
                    {t.city}
                    <input
                      value={draft.city}
                      onChange={(event) => onDraftChange('city', event.target.value)}
                    />
                  </label>
                  <label>
                    {t.address}
                    <input
                      value={draft.address}
                      onChange={(event) => onDraftChange('address', event.target.value)}
                    />
                  </label>
                </>
              ) : (
                <label className="full-width">
                  {t.websiteUrl}
                  <input
                    value={draft.websiteUrl}
                    onChange={(event) => onDraftChange('websiteUrl', event.target.value)}
                  />
                </label>
              )}

              <label className="full-width">
                {t.description}
                <textarea
                  rows={4}
                  value={draft.description}
                  onChange={(event) => onDraftChange('description', event.target.value)}
                />
              </label>

              <label>
                {t.products}
                <input
                  value={draft.productsText}
                  onChange={(event) => onDraftChange('productsText', event.target.value)}
                  placeholder="alfajores, pan lactal, mix para pizza"
                />
              </label>

              <label>
                {t.tags}
                <input
                  value={draft.tagsText}
                  onChange={(event) => onDraftChange('tagsText', event.target.value)}
                  placeholder="delivery, congelados, brunch"
                />
              </label>
            </div>

            {draft.kind === 'physical' ? (
              <div className="address-panel">
                <div className="card-title">{t.mapHint}</div>
                <div className="address-form">
                  <input
                    value={addressQuery}
                    onChange={(event) => onAddressQueryChange(event.target.value)}
                    placeholder={t.addressSearch}
                  />
                  <button type="button" className="ghost-button" onClick={() => void onAddressSearch()}>
                    {t.addressSearch}
                  </button>
                </div>
                {draft.locationLabel ? (
                  <div className="location-pill">
                    <strong>{t.selectedLocation}:</strong> {draft.locationLabel}
                  </div>
                ) : null}
                {addressResults.length > 0 ? (
                  <div className="address-results">
                    {addressResults.map((result) => (
                      <button
                        key={result.id}
                        type="button"
                        className="address-result"
                        onClick={() => onApplyGeocodingResult(result)}
                      >
                        <strong>{result.city || result.label}</strong>
                        <span>{result.label}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {addressStatus ? <p className="helper-text">{addressStatus}</p> : null}
              </div>
            ) : null}

            <div className="toggle-cluster">
              {session?.user?.role === 'admin' ? (
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={draft.verified}
                    onChange={(event) => onDraftChange('verified', event.target.checked)}
                  />
                  <span>{t.verified}</span>
                </label>
              ) : null}
            </div>

            {session?.uploadConfigured && session.csrfToken ? (
              <div className="upload-shell">
                <div className="upload-copy">
                  <div className="card-title">{t.uploadPhotos}</div>
                  <p className="helper-text">{t.uploadHint}</p>
                  <div className="upload-actions">
                    <button
                      type="button"
                      className="ghost-button upload-camera-button"
                      onClick={() => cameraInputRef.current?.click()}
                    >
                      {t.cameraButton}
                    </button>
                    <span className="helper-text">{t.cameraHint}</span>
                  </div>
                  <input
                    ref={cameraInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="camera-input"
                    onChange={handleCameraFileChange}
                  />
                </div>
                <ListingUploadDropzone
                  endpoint="listingImage"
                  headers={{
                    'X-CSRF-Token': session.csrfToken,
                  }}
                  content={{
                    label: () => t.uploadDropLabel,
                    button: () => t.uploadButton,
                    allowedContent: () => t.uploadHint,
                  }}
                  onChange={(files) => {
                    setPendingFiles(files)
                  }}
                  onClientUploadComplete={(
                    files: Array<{ serverData: UploadRef }>,
                  ) => {
                    const nextUploads = files.map((file) => ({
                        key: file.serverData.key,
                        url: file.serverData.url,
                        name: file.serverData.name,
                      }))

                    completeUploadedFiles(nextUploads)
                  }}
                  onUploadError={(error: Error) => {
                    failUploadedFiles(error)
                  }}
                />
                {pendingUploadPreviews.length > 0 || uploadRefs.length > 0 ? (
                  <div className="upload-preview-grid">
                    {pendingUploadPreviews.map((file) => (
                      <figure key={file.id} className="upload-preview-card">
                        <img src={file.url} alt={file.name} className="photo-thumb" />
                        <figcaption className="upload-preview-meta">
                          <span className="upload-status-badge upload-status-badge-uploading">
                            {t.uploadingLabel}
                          </span>
                          <span className="upload-preview-name">{file.name}</span>
                        </figcaption>
                      </figure>
                    ))}
                    {uploadRefs.map((file) => (
                      <figure key={file.key} className="upload-preview-card">
                        <img src={file.url} alt={file.name} className="photo-thumb" />
                        <figcaption className="upload-preview-meta">
                          <span className="upload-status-badge">{t.uploadedLabel}</span>
                          <span className="upload-preview-name">{file.name}</span>
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="action-row">
              <button type="submit" className="solid-button" disabled={formPending || uploadingPhotos}>
                {formPending ? '...' : uploadingPhotos ? t.uploadingLabel : t.save}
              </button>
            </div>
            {formStatus ? <p className="helper-text">{formStatus}</p> : null}
          </form>
        </div>
      ) : null}
    </section>
  )
}

function StatusPills({
  language,
  listing,
}: {
  language: Language
  listing: Listing
}) {
  const t = copy[language]
  return (
    <div className="status-pills">
      <span className={`status-pill status-pill-${listing.approvalStatus}`}>{t[listing.approvalStatus]}</span>
      <span className="status-pill">{listing.verified ? t.verified : t.notVerified}</span>
    </div>
  )
}

function CatalogView({
  language,
  groupedListings,
  onSelectListing,
}: {
  language: Language
  groupedListings: Array<[string, Listing[]]>
  onSelectListing: (listing: Listing) => void
}) {
  const t = copy[language]

  return (
    <section className="panel-page">
      <div className="hero-card">
        <span className="listing-meta">{t.catalogTitle}</span>
        <h1>{t.onlineSection}</h1>
        <p>{t.catalogText}</p>
      </div>

      {groupedListings.length === 0 ? <div className="status-card">{t.emptyCatalog}</div> : null}

      <div className="catalog-groups">
        {groupedListings.map(([product, listings]) => (
          <section key={product} className="catalog-group">
            <div className="group-heading">
              <h2>{product}</h2>
              <span>{listings.length}</span>
            </div>
            <div className="catalog-grid">
              {listings.map((listing) => (
                <article key={listing.id} className="catalog-card">
                  <span className="listing-meta">{getCategoryLabel(language, listing.category)}</span>
                  <h3>{listing.name}</h3>
                  <p>{listing.description}</p>
                  <div className="tag-cloud">
                    {listing.products.map((item) => (
                      <span key={item} className="tag-token">
                        {item}
                      </span>
                    ))}
                  </div>
                  <div className="action-row">
                    {hasPublicWebsiteUrl(listing.websiteUrl) ? (
                      <a href={listing.websiteUrl} target="_blank" rel="noreferrer" className="solid-button">
                        {t.website}
                      </a>
                    ) : null}
                    <button type="button" className="ghost-button" onClick={() => onSelectListing(listing)}>
                      {t.details}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  )
}

function RegisterView({ language }: { language: Language }) {
  const t = copy[language]

  return (
    <section className="panel-page">
      <div className="hero-card hero-card-center">
        <span className="listing-meta">{t.registerTitle}</span>
        <h1>{t.signUp}</h1>
        <p>{t.registerText}</p>
        <div className="action-row">
          <a className="solid-button" href="/api/auth/login?screenHint=sign-up&returnTo=/">
            {t.signUp}
          </a>
          <a className="ghost-button" href="/api/auth/login?screenHint=sign-in&returnTo=/">
            {t.signIn}
          </a>
        </div>
      </div>
    </section>
  )
}

function AdminView({
  language,
  session,
  listings,
  status,
  onModerate,
}: {
  language: Language
  session: SessionPayload | null
  listings: Listing[]
  status: string | null
  onModerate: (
    listingId: string,
    approvalStatus: 'approved' | 'pending' | 'rejected',
    verified?: boolean,
  ) => void
}) {
  const t = copy[language]

  if (session?.user?.role !== 'admin') {
    return (
      <section className="panel-page">
        <div className="status-card">
          {language === 'es'
            ? 'Solo un admin puede acceder a este panel.'
            : 'Only admins can access this view.'}
        </div>
      </section>
    )
  }

  return (
    <section className="panel-page">
      <div className="hero-card">
        <span className="listing-meta">{t.adminTitle}</span>
        <h1>{t.adminView}</h1>
        <p>{t.adminText}</p>
      </div>

      {status ? <div className="status-card">{status}</div> : null}
      {listings.length === 0 ? <div className="status-card">{t.emptyAdmin}</div> : null}

      <div className="admin-grid">
        {listings.map((listing) => (
          <article key={listing.id} className="admin-card">
            <div className="admin-card-header">
              <div>
                <span className="listing-meta">{kindLabels[language][listing.kind]}</span>
                <h3>{listing.name}</h3>
              </div>
              <StatusPills language={language} listing={listing} />
            </div>
            <p>{listing.description}</p>
            <small>
              {t.uploadedBy}: {listing.submittedBy.name}
            </small>

            <div className="action-row">
              <button type="button" className="solid-button" onClick={() => onModerate(listing.id, 'approved', true)}>
                {t.approve}
              </button>
              <button type="button" className="ghost-button" onClick={() => onModerate(listing.id, 'pending')}>
                {t.keepPending}
              </button>
              <button type="button" className="ghost-button" onClick={() => onModerate(listing.id, 'rejected', false)}>
                {t.reject}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

export default App

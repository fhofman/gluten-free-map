import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { FormEvent } from 'react'
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Map as PigeonMap, Marker } from 'pigeon-maps'
import { osm } from 'pigeon-maps/providers'
import { generateUploadDropzone } from '@uploadthing/react'
import '@uploadthing/react/styles.css'
import { createListing, fetchAdminQueue, fetchListings, fetchSession, logout, moderateListing, submitReview } from './api'
import { searchAddress, type GeocodingResult } from './geocoding'
import { categoryLabels, copy, defaultLanguage, kindLabels, languageStorageKey } from './i18n'
import type { CreateListingInput, Language, Listing, ListingCategory, ListingKind, SessionPayload } from './types'
import './styles.css'

const defaultCenter: [number, number] = [-34.603722, -58.381592]

const categoryAccent: Record<ListingCategory, string> = {
  restaurant: '#eb6f3d',
  store: '#0f766e',
  market: '#d5a021',
  productSpot: '#3c78b7',
  onlineStore: '#5b4fc9',
}

const ListingUploadDropzone = generateUploadDropzone<any>({
  url: '/api/uploadthing',
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, {
      ...init,
      credentials: 'include',
    }),
})

type CategoryFilter = ListingCategory | 'all'

interface UploadRef {
  key: string
  url: string
  name: string
}

interface ListingDraft {
  kind: ListingKind
  name: string
  category: ListingCategory
  city: string
  address: string
  websiteUrl: string
  description: string
  tagsText: string
  productsText: string
  dedicatedKitchen: boolean
  verified: boolean
  coordinates: [number, number] | null
  locationLabel: string
}

function createDraft(kind: ListingKind = 'physical'): ListingDraft {
  return {
    kind,
    name: '',
    category: kind === 'online' ? 'onlineStore' : 'restaurant',
    city: '',
    address: '',
    websiteUrl: '',
    description: '',
    tagsText: '',
    productsText: '',
    dedicatedKitchen: false,
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

function formatDate(value: string | null, language: Language) {
  if (!value) {
    return ''
  }

  return new Intl.DateTimeFormat(language === 'es' ? 'es-AR' : 'en-US', {
    day: 'numeric',
    month: 'short',
  }).format(new Date(value))
}

function getAverageRating(listing: Listing) {
  if (listing.reviews.length === 0) {
    return null
  }

  return (
    listing.reviews.reduce((total, review) => total + review.rating, 0) /
    listing.reviews.length
  )
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
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [verifiedOnly, setVerifiedOnly] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mapCenter, setMapCenter] = useState<[number, number]>(defaultCenter)
  const [mapZoom, setMapZoom] = useState(12)
  const [formOpen, setFormOpen] = useState(false)
  const [draft, setDraft] = useState<ListingDraft>(() => createDraft())
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

  const approvedPhysicalListings = listings.filter(
    (listing) => listing.kind === 'physical' && listing.approvalStatus === 'approved',
  )
  const approvedOnlineListings = listings.filter(
    (listing) => listing.kind === 'online' && listing.approvalStatus === 'approved',
  )

  const filteredPhysicalListings = approvedPhysicalListings.filter((listing) => {
    if (categoryFilter !== 'all' && listing.category !== categoryFilter) {
      return false
    }

    if (verifiedOnly && !listing.verified) {
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
  })

  const filteredOnlineListings = approvedOnlineListings.filter((listing) => {
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
  })

  const selectedListing =
    listings.find((listing) => listing.id === selectedId) ??
    filteredPhysicalListings[0] ??
    filteredOnlineListings[0] ??
    null

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

  async function refreshSession() {
    setLoadingSession(true)

    try {
      const nextSession = await fetchSession()
      setSession(nextSession)
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : 'No pude leer la sesión.')
    } finally {
      setLoadingSession(false)
    }
  }

  async function refreshListings() {
    setLoadingListings(true)

    try {
      const nextListings = await fetchListings({ kind: 'all' })
      setListings(nextListings)

      if (!selectedId && nextListings.length > 0) {
        const firstPhysical = nextListings.find((listing) => listing.kind === 'physical')
        setSelectedId(firstPhysical?.id ?? nextListings[0]?.id ?? null)
      }
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
    setDraft(createDraft(kind))
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

    try {
      const results = await searchAddress(addressQuery, language)
      setAddressResults(results)
      setAddressStatus(results.length === 0 ? t.emptyMap : null)
    } catch (error) {
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

    setFormPending(true)
    setFormStatus(null)

    try {
      const payload: CreateListingInput = {
        kind: draft.kind,
        name: draft.name.trim(),
        category: draft.kind === 'online' ? 'onlineStore' : draft.category,
        city: draft.city.trim(),
        address: draft.address.trim(),
        coordinates: draft.coordinates,
        websiteUrl: draft.websiteUrl.trim(),
        description: draft.description.trim(),
        tags: splitCommaList(draft.tagsText),
        products: splitCommaList(draft.productsText),
        dedicatedKitchen: draft.kind === 'physical' ? draft.dedicatedKitchen : false,
        verified: session.user.role === 'admin' ? draft.verified : false,
        photoKeys: uploadRefs.map((photo) => photo.key),
      }

      await createListing(payload, session.csrfToken)
      await refreshListings()

      if (session.user.role === 'admin') {
        await refreshPendingListings()
      }

      setFormOpen(false)
      setDraft(createDraft())
      setUploadRefs([])
      setFormStatus(
        language === 'es'
          ? 'Item enviado correctamente.'
          : 'Listing submitted successfully.',
      )
    } catch (error) {
      setFormStatus(error instanceof Error ? error.message : 'Could not create listing.')
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
        <span className="brand-title">{t.title}</span>
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
          <>
            <a className="ghost-button" href={`${authBaseHref}?screenHint=sign-in&returnTo=${encodeURIComponent(location.pathname)}`}>
              {t.signIn}
            </a>
            <a className="solid-button" href={`${authBaseHref}?screenHint=sign-up&returnTo=${encodeURIComponent(location.pathname)}`}>
              {t.signUp}
            </a>
          </>
        )}
      </div>

      {authWarning ? <FloatingAlert tone="warning">{t.authMissing}</FloatingAlert> : null}
      {uploadWarning ? <FloatingAlert tone="info">{t.uploadMissing}</FloatingAlert> : null}
      {globalError ? <FloatingAlert tone="danger">{globalError}</FloatingAlert> : null}

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
              verifiedOnly={verifiedOnly}
              onVerifiedOnlyChange={setVerifiedOnly}
              mapCenter={mapCenter}
              mapZoom={mapZoom}
              onMapCenterChange={setMapCenter}
              onMapZoomChange={setMapZoom}
              onMapClick={handleMapClick}
              onSelectListing={handleSelectListing}
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
  tone: 'warning' | 'danger' | 'info'
}) {
  return <div className={`floating-alert floating-alert-${tone}`}>{children}</div>
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
  verifiedOnly: boolean
  onVerifiedOnlyChange: (value: boolean) => void
  mapCenter: [number, number]
  mapZoom: number
  onMapCenterChange: (value: [number, number]) => void
  onMapZoomChange: (value: number) => void
  onMapClick: (input: { latLng: [number, number] }) => void
  onSelectListing: (listing: Listing) => void
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
    verifiedOnly,
    onVerifiedOnlyChange,
    mapCenter,
    mapZoom,
    onMapCenterChange,
    onMapZoomChange,
    onMapClick,
    onSelectListing,
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

  return (
    <section className="map-screen">
      <div className="map-overlay-left">
        <div className="search-card">
          <div className="card-title">{t.filters}</div>
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            className="search-input"
            placeholder={t.search}
          />

          <div className="chip-row">
            <button
              type="button"
              className={categoryFilter === 'all' ? 'chip chip-active' : 'chip'}
              onClick={() => onCategoryFilterChange('all')}
            >
              All
            </button>
            {(['restaurant', 'store', 'market', 'productSpot'] as ListingCategory[]).map(
              (category) => (
                <button
                  key={category}
                  type="button"
                  className={categoryFilter === category ? 'chip chip-active' : 'chip'}
                  onClick={() => onCategoryFilterChange(category)}
                >
                  {categoryLabels[language][category]}
                </button>
              ),
            )}
          </div>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={verifiedOnly}
              onChange={(event) => onVerifiedOnlyChange(event.target.checked)}
            />
            <span>{t.verified}</span>
          </label>

          <div className="action-row">
            <button type="button" className="solid-button" onClick={() => onOpenForm('physical')}>
              {t.addPhysical}
            </button>
            <button type="button" className="ghost-button" onClick={() => onOpenForm('online')}>
              {t.addOnline}
            </button>
          </div>
        </div>

        <div className="listing-stack">
          {loading ? <div className="status-card">Loading map...</div> : null}
          {!loading && listings.length === 0 ? <div className="status-card">{t.emptyMap}</div> : null}
          {listings.map((listing) => (
            <button
              key={listing.id}
              type="button"
              className={`listing-card ${selectedListing?.id === listing.id ? 'listing-card-active' : ''}`}
              onClick={() => onSelectListing(listing)}
            >
              <span className="listing-meta" style={{ color: categoryAccent[listing.category] }}>
                {categoryLabels[language][listing.category]}
              </span>
              <strong>{listing.name}</strong>
              <span>{listing.city}</span>
              <div className="listing-traits">
                {listing.verified ? <span>{t.verified}</span> : null}
                {listing.dedicatedKitchen ? <span>{t.dedicatedKitchen}</span> : null}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="map-overlay-right">
        {selectedListing ? (
          <div className="detail-popup">
            <div className="popup-heading">
              <div>
                <span className="listing-meta" style={{ color: categoryAccent[selectedListing.category] }}>
                  {categoryLabels[language][selectedListing.category]}
                </span>
                <h2>{selectedListing.name}</h2>
              </div>
              <StatusPills language={language} listing={selectedListing} />
            </div>

            <div className="popup-body">
              <p>{selectedListing.description}</p>
              {selectedListing.address ? <p>{selectedListing.address}</p> : null}
              {selectedListing.websiteUrl ? (
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
                    {getAverageRating(selectedListing)?.toFixed(1) ?? '0.0'} · {selectedListing.reviews.length}
                  </span>
                </div>

                {selectedListing.reviews.length === 0 ? <p>{t.noReviews}</p> : null}
                {selectedListing.reviews.slice(0, 3).map((review) => (
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
                  <label>
                    {t.ratingLabel}
                    <select
                      value={reviewRating}
                      onChange={(event) => onReviewRatingChange(Number.parseInt(event.target.value, 10))}
                    >
                      {[5, 4, 3, 2, 1].map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
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
              <Marker
                key={listing.id}
                anchor={listing.coordinates}
                color={categoryAccent[listing.category]}
                width={selectedListing?.id === listing.id ? 56 : 42}
                onClick={({ event }) => {
                  event.stopPropagation?.()
                  onSelectListing(listing)
                }}
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
                <select
                  value={draft.category}
                  onChange={(event) => onDraftChange('category', event.target.value as ListingCategory)}
                >
                  {(draft.kind === 'online'
                    ? (['onlineStore'] as ListingCategory[])
                    : (['restaurant', 'store', 'market', 'productSpot'] as ListingCategory[])
                  ).map((category) => (
                    <option key={category} value={category}>
                      {categoryLabels[language][category]}
                    </option>
                  ))}
                </select>
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
              {draft.kind === 'physical' ? (
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={draft.dedicatedKitchen}
                    onChange={(event) => onDraftChange('dedicatedKitchen', event.target.checked)}
                  />
                  <span>{t.dedicatedKitchen}</span>
                </label>
              ) : null}
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
                <div className="card-title">{t.uploadPhotos}</div>
                <ListingUploadDropzone
                  endpoint="listingImage"
                  headers={{
                    'X-CSRF-Token': session.csrfToken,
                  }}
                  onClientUploadComplete={(
                    files: Array<{ serverData: UploadRef }>,
                  ) => {
                    onUploadRefsChange(
                      files.map((file) => ({
                        key: file.serverData.key,
                        url: file.serverData.url,
                        name: file.serverData.name,
                      })),
                    )
                  }}
                  onUploadError={(error: Error) => {
                    onUploadRefsChange([])
                    console.error(error)
                  }}
                />
                {uploadRefs.length > 0 ? (
                  <div className="upload-list">
                    {uploadRefs.map((file) => (
                      <span key={file.key} className="tag-token">
                        {file.name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="action-row">
              <button type="submit" className="solid-button" disabled={formPending}>
                {formPending ? '...' : t.save}
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
                  <span className="listing-meta">{categoryLabels[language][listing.category]}</span>
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
                    {listing.websiteUrl ? (
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

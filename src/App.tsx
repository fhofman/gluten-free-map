import { useDeferredValue, useEffect, useState, startTransition } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Map, Marker } from 'pigeon-maps'
import { osm } from 'pigeon-maps/providers'
import './App.css'
import {
  authMethodLabels,
  getStoredSession,
  requestEmailCode,
  signInAsDemoAdmin,
  signInWithGoogleDemo,
  signOut,
  verifyEmailCode,
  type AuthUser,
} from './lib/auth'
import {
  searchAddress,
  type GeocodingResult,
} from './lib/geocoding'
import {
  approvePlace,
  createPlace,
  defaultMapCenter,
  defaultMapZoom,
  getPlaceRatingSummary,
  placeCategoryMeta,
  placeCategoryOptions,
  placesQueryOptions,
  sortPlaces,
  suggestedPlaceTags,
  upsertPlaceReview,
  type NewPlaceInput,
  type Place,
  type PlaceApprovalStatus,
  type PlaceCategory,
} from './lib/places'

type CategoryFilter = PlaceCategory | 'all'
type TagFilter = string | 'all'
const PLACE_PHOTO_LIMIT = 8

interface PlaceDraft {
  name: string
  category: PlaceCategory
  city: string
  address: string
  description: string
  products: string
  customTags: string
  selectedTags: string[]
  lat: string
  lng: string
  verified: boolean
  dedicatedKitchen: boolean
}

interface GoogleDraft {
  name: string
  email: string
}

interface EmailDraft {
  email: string
  code: string
}

interface ReviewDraft {
  rating: number
  comment: string
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

function createDraft(
  lat = defaultMapCenter[0],
  lng = defaultMapCenter[1],
): PlaceDraft {
  return {
    name: '',
    category: 'restaurant',
    city: 'CABA',
    address: '',
    description: '',
    products: '',
    customTags: '',
    selectedTags: [],
    lat: lat.toFixed(6),
    lng: lng.toFixed(6),
    verified: false,
    dedicatedKitchen: false,
  }
}

function splitCommaList(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function buildDraftTags(draft: PlaceDraft) {
  const mergedTags = [...draft.selectedTags, ...splitCommaList(draft.customTags)]

  if (draft.dedicatedKitchen) {
    mergedTags.push('cocina dedicada')
  }

  return Array.from(new Set(mergedTags.map((tag) => tag.trim()).filter(Boolean)))
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat('es-AR', {
    day: 'numeric',
    month: 'short',
  }).format(new Date(date))
}

function toggleTag(currentTags: string[], targetTag: string) {
  return currentTags.includes(targetTag)
    ? currentTags.filter((tag) => tag !== targetTag)
    : [...currentTags, targetTag]
}

function isStandaloneApp() {
  if (typeof window === 'undefined') {
    return false
  }

  const navigatorWithStandalone = window.navigator as Navigator & {
    standalone?: boolean
  }

  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    navigatorWithStandalone.standalone === true
  )
}

function isAppleMobileDevice() {
  if (typeof window === 'undefined') {
    return false
  }

  return /iphone|ipad|ipod/i.test(window.navigator.userAgent)
}

function getStatusLabel(status: PlaceApprovalStatus) {
  return status === 'approved' ? 'Publicado' : 'Pendiente'
}

function App() {
  const queryClient = useQueryClient()
  const {
    data: places = [],
    isPending,
    isError,
    error: placesError,
  } = useQuery(placesQueryOptions)

  const [session, setSession] = useState<AuthUser | null>(() => getStoredSession())
  const [mapCenter, setMapCenter] = useState<[number, number]>(defaultMapCenter)
  const [mapZoom, setMapZoom] = useState(defaultMapZoom)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [tagFilter, setTagFilter] = useState<TagFilter>('all')
  const [verifiedOnly, setVerifiedOnly] = useState(false)
  const [dedicatedOnly, setDedicatedOnly] = useState(false)
  const [showPendingOnMap, setShowPendingOnMap] = useState(false)
  const [draft, setDraft] = useState<PlaceDraft>(() => createDraft())
  const [selectedPhotos, setSelectedPhotos] = useState<File[]>([])
  const [geocodingResults, setGeocodingResults] = useState<GeocodingResult[]>([])
  const [googleDraft, setGoogleDraft] = useState<GoogleDraft>({
    name: '',
    email: '',
  })
  const [emailDraft, setEmailDraft] = useState<EmailDraft>({
    email: '',
    code: '',
  })
  const [authMessage, setAuthMessage] = useState(
    'Entrá para poder cargar lugares. Los admins publican directo; los usuarios comunes envían a revisión.',
  )
  const [emailPreviewCode, setEmailPreviewCode] = useState<string | null>(null)
  const [formMessage, setFormMessage] = useState(
    'Hacé click en el mapa o buscá la dirección para ubicar el nuevo lugar.',
  )
  const [reviewDraft, setReviewDraft] = useState<ReviewDraft>({
    rating: 5,
    comment: '',
  })
  const [reviewMessage, setReviewMessage] = useState<string | null>(null)
  const [installPromptEvent, setInstallPromptEvent] =
    useState<BeforeInstallPromptEvent | null>(null)
  const [isInstalled, setIsInstalled] = useState(() => isStandaloneApp())
  const [showIosInstallHint, setShowIosInstallHint] = useState(false)

  const deferredSearch = useDeferredValue(search.trim().toLowerCase())
  const isAdmin = session?.role === 'admin'
  const appleMobileDevice = isAppleMobileDevice()
  const canShowInstallEntry =
    !isInstalled && (installPromptEvent !== null || appleMobileDevice)

  useEffect(() => {
    const mediaQuery = window.matchMedia('(display-mode: standalone)')
    const legacyMediaQuery = mediaQuery as MediaQueryList & {
      addListener?: (listener: (event: MediaQueryListEvent) => void) => void
      removeListener?: (listener: (event: MediaQueryListEvent) => void) => void
    }
    let usesLegacyMediaQueryListener = false

    const syncInstalledState = () => {
      const standalone = isStandaloneApp()
      setIsInstalled(standalone)

      if (standalone) {
        setInstallPromptEvent(null)
        setShowIosInstallHint(false)
      }
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      const nextEvent = event as BeforeInstallPromptEvent
      nextEvent.preventDefault()
      setInstallPromptEvent(nextEvent)
    }

    const handleDisplayModeChange = () => {
      syncInstalledState()
    }

    const handleAppInstalled = () => {
      syncInstalledState()
    }

    syncInstalledState()
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleAppInstalled)

    try {
      mediaQuery.addEventListener('change', handleDisplayModeChange)
    } catch {
      usesLegacyMediaQueryListener = true
      legacyMediaQuery.addListener?.(handleDisplayModeChange)
    }

    return () => {
      window.removeEventListener(
        'beforeinstallprompt',
        handleBeforeInstallPrompt,
      )
      window.removeEventListener('appinstalled', handleAppInstalled)

      if (!usesLegacyMediaQueryListener) {
        mediaQuery.removeEventListener('change', handleDisplayModeChange)
      } else {
        legacyMediaQuery.removeListener?.(handleDisplayModeChange)
      }
    }
  }, [])

  const approvedPlaces = places.filter((place) => place.approvalStatus === 'approved')
  const pendingPlaces = places.filter((place) => place.approvalStatus === 'pending')
  const browsablePlaces =
    isAdmin && showPendingOnMap ? places : approvedPlaces

  const allTagOptions = Array.from(
    new Set([...suggestedPlaceTags, ...places.flatMap((place) => place.tags)]),
  ).sort((left, right) => left.localeCompare(right, 'es'))

  const filteredPlaces = browsablePlaces.filter((place) => {
    const matchesCategory =
      categoryFilter === 'all' || place.category === categoryFilter
    const matchesVerified = !verifiedOnly || place.verified
    const matchesDedicated = !dedicatedOnly || place.dedicatedKitchen
    const matchesTag =
      tagFilter === 'all' || place.tags.some((tag) => tag === tagFilter)
    const matchesSearch =
      deferredSearch.length === 0 ||
      [
        place.name,
        place.city,
        place.address,
        place.description,
        place.submittedBy.name,
        ...place.tags,
        ...place.products,
      ]
        .join(' ')
        .toLowerCase()
        .includes(deferredSearch)

    return (
      matchesCategory &&
      matchesVerified &&
      matchesDedicated &&
      matchesTag &&
      matchesSearch
    )
  })

  const selectedPlace = places.find((place) => place.id === selectedId) ?? null
  const activePlace = selectedPlace ?? filteredPlaces[0] ?? approvedPlaces[0] ?? null

  const addPlaceMutation = useMutation<
    Place,
    Error,
    { place: NewPlaceInput; actor: AuthUser; photos: File[] }
  >({
    mutationFn: createPlace,
    onSuccess: (newPlace) => {
      queryClient.setQueryData<Place[]>(placesQueryOptions.queryKey, (current) =>
        sortPlaces([newPlace, ...(current ?? [])]),
      )

      startTransition(() => {
        setMapCenter(newPlace.coordinates)
        setMapZoom(14)
        setDraft(createDraft(newPlace.coordinates[0], newPlace.coordinates[1]))
        setSelectedPhotos([])
        setGeocodingResults([])
        setSelectedId(newPlace.approvalStatus === 'approved' ? newPlace.id : null)
        if (newPlace.approvalStatus === 'approved') {
          setFormMessage(`"${newPlace.name}" quedó publicado inmediatamente.`)
        } else {
          setFormMessage(
            `"${newPlace.name}" quedó pendiente. Un admin debe aprobarlo para mostrarlo en el mapa.`,
          )
        }
      })
    },
    onError: (error) => {
      setFormMessage(
        error instanceof Error
          ? error.message
          : 'No pude guardar el lugar.',
      )
    },
  })

  const approvePlaceMutation = useMutation<
    Place,
    Error,
    { placeId: string; actor: AuthUser }
  >({
    mutationFn: approvePlace,
    onSuccess: (approvedPlace) => {
      queryClient.setQueryData<Place[]>(placesQueryOptions.queryKey, (current) =>
        sortPlaces(
          (current ?? []).map((place) =>
            place.id === approvedPlace.id ? approvedPlace : place,
          ),
        ),
      )

      startTransition(() => {
        setSelectedId(approvedPlace.id)
        setMapCenter(approvedPlace.coordinates)
        setMapZoom(14)
        setShowPendingOnMap(false)
        setFormMessage(`"${approvedPlace.name}" ya está publicado.`)
      })
    },
  })

  const reviewPlaceMutation = useMutation<
    Place,
    Error,
    { placeId: string; actor: AuthUser; rating: number; comment: string }
  >({
    mutationFn: upsertPlaceReview,
    onSuccess: (updatedPlace) => {
      queryClient.setQueryData<Place[]>(placesQueryOptions.queryKey, (current) =>
        sortPlaces(
          (current ?? []).map((place) =>
            place.id === updatedPlace.id ? updatedPlace : place,
          ),
        ),
      )

      startTransition(() => {
        setReviewDraft({
          rating: 5,
          comment: '',
        })
        setReviewMessage('Tu reseña quedó guardada.')
      })
    },
    onError: (error) => {
      setReviewMessage(
        error instanceof Error
          ? error.message
          : 'No pude guardar tu reseña.',
      )
    },
  })

  const geocodingMutation = useMutation({
    mutationFn: searchAddress,
    onSuccess: (results) => {
      setGeocodingResults(results)

      if (results.length === 0) {
        setFormMessage('No encontré coincidencias para esa dirección.')
        return
      }

      if (results.length === 1) {
        applyGeocodingResult(results[0], false)
        setFormMessage('Encontré 1 coincidencia y la ubiqué en el mapa.')
        return
      }

      setFormMessage(
        `Encontré ${results.length} coincidencias. Elegí la correcta debajo del buscador.`,
      )
    },
    onError: (error) => {
      setGeocodingResults([])
      setFormMessage(
        error instanceof Error
          ? error.message
          : 'No pude buscar la dirección.',
      )
    },
  })

  const googleLoginMutation = useMutation({
    mutationFn: signInWithGoogleDemo,
    onSuccess: (user) => {
      setSession(user)
      setAuthMessage(
        `Sesión iniciada como ${user.name}. Tus nuevos lugares quedarán pendientes hasta aprobación de un admin.`,
      )
      setGoogleDraft({
        name: '',
        email: '',
      })
    },
    onError: (error) => {
      setAuthMessage(
        error instanceof Error ? error.message : 'No pude iniciar sesión con Google.',
      )
    },
  })

  const emailCodeRequestMutation = useMutation({
    mutationFn: requestEmailCode,
    onSuccess: (result) => {
      setEmailPreviewCode(result.code)
      setEmailDraft((current) => ({
        ...current,
        email: result.email,
        code: '',
      }))
      setAuthMessage(
        `Código generado para ${result.email}. En esta demo local se muestra en pantalla y vence en 10 minutos.`,
      )
    },
    onError: (error) => {
      setAuthMessage(
        error instanceof Error ? error.message : 'No pude generar el código.',
      )
    },
  })

  const emailCodeVerifyMutation = useMutation({
    mutationFn: verifyEmailCode,
    onSuccess: (user) => {
      setSession(user)
      setEmailPreviewCode(null)
      setAuthMessage(
        `Sesión iniciada como ${user.email}. Tus nuevos lugares quedarán pendientes hasta aprobación de un admin.`,
      )
      setEmailDraft({
        email: '',
        code: '',
      })
    },
    onError: (error) => {
      setAuthMessage(
        error instanceof Error ? error.message : 'No pude verificar el código.',
      )
    },
  })

  const demoAdminMutation = useMutation({
    mutationFn: signInAsDemoAdmin,
    onSuccess: (user) => {
      setSession(user)
      setAuthMessage(
        'Entraste como admin demo. Podés publicar directo y aprobar pendientes.',
      )
    },
  })

  function applyGeocodingResult(
    result: GeocodingResult,
    clearResults = true,
  ) {
    startTransition(() => {
      setDraft((current) => ({
        ...current,
        lat: result.coordinates[0].toFixed(6),
        lng: result.coordinates[1].toFixed(6),
        city: result.city || current.city,
      }))
      setMapCenter(result.coordinates)
      setMapZoom(15)
      if (clearResults) {
        setGeocodingResults([])
      }
    })
  }

  const focusPlace = (place: Place) => {
    startTransition(() => {
      setSelectedId(place.id)
      setMapCenter(place.coordinates)
      setMapZoom(14)
      setReviewMessage(null)
      if (place.approvalStatus === 'pending') {
        setShowPendingOnMap(true)
      }
    })
  }

  const handlePhotoSelection = (event: ChangeEvent<HTMLInputElement>) => {
    const nextPhotos = Array.from(event.target.files ?? []).slice(0, PLACE_PHOTO_LIMIT)

    setSelectedPhotos(nextPhotos)
    event.target.value = ''

    if ((event.target.files?.length ?? 0) > PLACE_PHOTO_LIMIT) {
      setFormMessage(`Podés subir hasta ${PLACE_PHOTO_LIMIT} fotos por lugar.`)
    }
  }

  const removeSelectedPhoto = (targetIndex: number) => {
    setSelectedPhotos((current) =>
      current.filter((_, index) => index !== targetIndex),
    )
  }

  const handleMapClick = ({ latLng }: { latLng: [number, number] }) => {
    startTransition(() => {
      setDraft((current) => ({
        ...current,
        lat: latLng[0].toFixed(6),
        lng: latLng[1].toFixed(6),
      }))
      setFormMessage(
        `Coordenadas listas: ${latLng[0].toFixed(4)}, ${latLng[1].toFixed(4)}.`,
      )
    })
  }

  const handleSubmitPlace = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!session) {
      setFormMessage('Necesitás iniciar sesión para cargar un lugar.')
      return
    }

    const latitude = Number.parseFloat(draft.lat)
    const longitude = Number.parseFloat(draft.lng)

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      setFormMessage('Las coordenadas no son válidas. Buscá la dirección o elegilas en el mapa.')
      return
    }

    const payload: NewPlaceInput = {
      name: draft.name,
      category: draft.category,
      city: draft.city,
      address: draft.address,
      description: draft.description,
      coordinates: [latitude, longitude],
      products: splitCommaList(draft.products),
      tags: buildDraftTags(draft),
      verified: isAdmin ? draft.verified : false,
      dedicatedKitchen: draft.dedicatedKitchen,
    }

    addPlaceMutation.mutate({
      place: payload,
      actor: session,
      photos: selectedPhotos,
    })
  }

  const handleSubmitReview = (
    event: FormEvent<HTMLFormElement>,
    placeId: string,
    approvalStatus: PlaceApprovalStatus,
  ) => {
    event.preventDefault()

    if (!session) {
      setReviewMessage('Necesitás iniciar sesión para puntuar y comentar.')
      return
    }

    if (approvalStatus !== 'approved') {
      setReviewMessage('Las reseñas se habilitan cuando el lugar esté publicado.')
      return
    }

    const comment = reviewDraft.comment.trim()

    if (!comment) {
      setReviewMessage('Escribí un comentario para compartir tu experiencia.')
      return
    }

    reviewPlaceMutation.mutate({
      placeId,
      actor: session,
      rating: reviewDraft.rating,
      comment,
    })
  }

  const handleGoogleLogin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    googleLoginMutation.mutate(googleDraft)
  }

  const handleEmailRequest = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    emailCodeRequestMutation.mutate({
      email: emailDraft.email,
    })
  }

  const handleEmailVerify = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    emailCodeVerifyMutation.mutate(emailDraft)
  }

  const handleSignOut = async () => {
    await signOut()
    startTransition(() => {
      setSession(null)
      setShowPendingOnMap(false)
      setSelectedId(null)
      setAuthMessage('Sesión cerrada.')
      setReviewMessage(null)
      setReviewDraft({
        rating: 5,
        comment: '',
      })
    })
  }

  const resetFilters = () => {
    startTransition(() => {
      setSearch('')
      setCategoryFilter('all')
      setTagFilter('all')
      setVerifiedOnly(false)
      setDedicatedOnly(false)
      setSelectedId(null)
      setShowPendingOnMap(false)
      setMapCenter(defaultMapCenter)
      setMapZoom(defaultMapZoom)
    })
  }

  const useMapCenterForDraft = () => {
    startTransition(() => {
      setDraft((current) => ({
        ...current,
        lat: mapCenter[0].toFixed(6),
        lng: mapCenter[1].toFixed(6),
      }))
      setFormMessage(
        `Formulario alineado al centro del mapa: ${mapCenter[0].toFixed(4)}, ${mapCenter[1].toFixed(4)}.`,
      )
    })
  }

  const handleInstallApp = async () => {
    if (installPromptEvent) {
      await installPromptEvent.prompt()
      const result = await installPromptEvent.userChoice

      if (result.outcome === 'accepted') {
        setInstallPromptEvent(null)
      }

      return
    }

    if (appleMobileDevice) {
      setShowIosInstallHint(true)
    }
  }

  return (
    <div className="app-shell">
      <header className="hero-panel">
        <div className="eyebrow-row">
          <span className="eyebrow">Mapa comunitario para celíacos</span>
          <span className="eyebrow eyebrow-secondary">
            TanStack Query + Pigeon Maps + moderación
          </span>
        </div>

        <div className="hero-grid">
          <div className="hero-copy">
            <h1>Mapa colaborativo para lugares, productos y negocios aptos.</h1>
            <p>
              Ahora el flujo ya contempla roles, login y revisión. Los usuarios
              comunes cargan lugares con Google o código por email y sus aportes
              quedan pendientes hasta que un admin los aprueba. El admin puede
              publicar directo y moderar desde la misma pantalla.
            </p>
          </div>

          <div className="hero-actions">
            {canShowInstallEntry ? (
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  void handleInstallApp()
                }}
              >
                {installPromptEvent ? 'Instalar app' : 'Agregar al inicio'}
              </button>
            ) : null}
            <button
              className="ghost-button"
              type="button"
              onClick={() => {
                startTransition(() => {
                  setMapCenter(defaultMapCenter)
                  setMapZoom(defaultMapZoom)
                })
              }}
            >
              Centrar en CABA
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={resetFilters}
            >
              Limpiar filtros
            </button>
            {isInstalled ? (
              <p className="hero-note install-note">
                Ya está corriendo en modo app, con pantalla completa y acceso
                desde el inicio.
              </p>
            ) : showIosInstallHint ? (
              <p className="hero-note install-note">
                En iPhone abrí el menú de compartir de Safari y elegí
                &quot;Agregar a pantalla de inicio&quot;.
              </p>
            ) : installPromptEvent ? (
              <p className="hero-note install-note">
                Podés instalarla y abrirla como una app, sin la barra del
                navegador.
              </p>
            ) : null}
            <p className="hero-note">
              Google y email code están modelados como demo local dentro del
              navegador. Para producción hace falta un backend o un proveedor de
              autenticación.
            </p>
          </div>
        </div>

        <div className="stats-grid">
          <StatCard
            value={approvedPlaces.length.toString().padStart(2, '0')}
            label="publicados"
            detail="visibles para cualquier visitante"
          />
          <StatCard
            value={pendingPlaces.length.toString().padStart(2, '0')}
            label="pendientes"
            detail="esperando moderación de admin"
          />
          <StatCard
            value={places.filter((place) => place.verified).length.toString().padStart(2, '0')}
            label="verificados"
            detail="lugares de mayor confianza"
          />
          <StatCard
            value={allTagOptions.length.toString().padStart(2, '0')}
            label="etiquetas"
            detail="para describir el tipo de oferta"
          />
        </div>
      </header>

      <main className="workspace">
        <section className="panel map-panel">
          <div className="panel-header">
            <div>
              <p className="section-label">Explorar</p>
              <h2>Mapa de lugares aptos</h2>
            </div>
            <div className="legend-row">
              {placeCategoryOptions.map((option) => (
                <LegendChip
                  key={option.value}
                  label={placeCategoryMeta[option.value].shortLabel}
                  color={placeCategoryMeta[option.value].color}
                />
              ))}
              {isAdmin ? (
                <button
                  className={`filter-chip ${showPendingOnMap ? 'filter-chip-active' : ''}`}
                  type="button"
                  onClick={() => setShowPendingOnMap((current) => !current)}
                >
                  {showPendingOnMap ? 'Ocultar pendientes' : 'Ver pendientes'}
                </button>
              ) : null}
            </div>
          </div>

          <div className="map-meta">
            <span>{filteredPlaces.length} resultados visibles</span>
            <span>Click en el mapa para cargar coordenadas en el formulario</span>
          </div>

          {isPending ? (
            <div className="state-card">Cargando lugares...</div>
          ) : (
            <>
              {isError ? (
                <div className="state-card">
                  {placesError instanceof Error
                    ? placesError.message
                    : 'No pude cargar los lugares desde el backend.'}
                </div>
              ) : null}

              <div className="map-canvas">
                <Map
                  provider={osm}
                  center={mapCenter}
                  zoom={mapZoom}
                  minZoom={4}
                  maxZoom={18}
                  animate
                  twoFingerDrag
                  onClick={handleMapClick}
                  onBoundsChanged={({ center, zoom }) => {
                    setMapCenter(center)
                    setMapZoom(zoom)
                  }}
                >
                  {filteredPlaces.map((place) => (
                    <Marker
                      key={place.id}
                      anchor={place.coordinates}
                      color={
                        place.approvalStatus === 'pending'
                          ? '#8b6f61'
                          : placeCategoryMeta[place.category].color
                      }
                      width={activePlace?.id === place.id ? 52 : 42}
                      onClick={({ event }) => {
                        event.stopPropagation?.()
                        focusPlace(place)
                      }}
                    />
                  ))}
                </Map>
              </div>

              <PlaceSpotlight
                place={activePlace}
                onLocate={focusPlace}
                session={session}
                reviewDraft={reviewDraft}
                reviewMessage={reviewMessage}
                reviewPending={reviewPlaceMutation.isPending}
                onReviewDraftChange={setReviewDraft}
                onSubmitReview={handleSubmitReview}
              />
            </>
          )}
        </section>

        <aside className="sidebar">
          <section className="panel auth-panel">
            <div className="panel-header">
              <div>
                <p className="section-label">Acceso</p>
                <h2>{session ? 'Sesión activa' : 'Ingresar para publicar'}</h2>
              </div>
              {session ? (
                <span className={`role-pill ${session.role === 'admin' ? 'role-pill-admin' : 'role-pill-member'}`}>
                  {session.role === 'admin' ? 'Admin' : 'Usuario'}
                </span>
              ) : null}
            </div>

            {session ? (
              <div className="user-card">
                <div>
                  <strong>{session.name}</strong>
                  <p>{session.email}</p>
                  <p>
                    Método: {authMethodLabels[session.authMethod]} · Rol:{' '}
                    {session.role === 'admin' ? 'admin' : 'común'}
                  </p>
                </div>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={handleSignOut}
                >
                  Cerrar sesión
                </button>
              </div>
            ) : (
              <div className="auth-stack">
                <form className="auth-method" onSubmit={handleGoogleLogin}>
                  <div>
                    <h3>Google</h3>
                    <p className="helper-copy">
                      Flujo demo local para representar login con Google.
                    </p>
                  </div>

                  <div className="field-grid">
                    <label className="field">
                      <span>Nombre</span>
                      <input
                        required
                        value={googleDraft.name}
                        onChange={(event) =>
                          setGoogleDraft((current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                        placeholder="Tu nombre"
                      />
                    </label>

                    <label className="field">
                      <span>Email</span>
                      <input
                        required
                        type="email"
                        value={googleDraft.email}
                        onChange={(event) =>
                          setGoogleDraft((current) => ({
                            ...current,
                            email: event.target.value,
                          }))
                        }
                        placeholder="tu@email.com"
                      />
                    </label>
                  </div>

                  <button
                    className="primary-button"
                    type="submit"
                    disabled={googleLoginMutation.isPending}
                  >
                    {googleLoginMutation.isPending
                      ? 'Ingresando...'
                      : 'Entrar con Google'}
                  </button>
                </form>

                <div className="divider-line">
                  <span>o</span>
                </div>

                <form className="auth-method" onSubmit={handleEmailRequest}>
                  <div>
                    <h3>Código por email</h3>
                    <p className="helper-copy">
                      La demo genera el código en el navegador para que puedas
                      probar el flujo sin backend.
                    </p>
                  </div>

                  <div className="inline-form">
                    <label className="field field-grow">
                      <span>Email</span>
                      <input
                        required
                        type="email"
                        value={emailDraft.email}
                        onChange={(event) =>
                          setEmailDraft((current) => ({
                            ...current,
                            email: event.target.value,
                          }))
                        }
                        placeholder="tu@email.com"
                      />
                    </label>
                    <button
                      className="ghost-button"
                      type="submit"
                      disabled={emailCodeRequestMutation.isPending}
                    >
                      {emailCodeRequestMutation.isPending
                        ? 'Generando...'
                        : 'Enviar código'}
                    </button>
                  </div>
                </form>

                {emailPreviewCode ? (
                  <div className="dev-card">
                    Código demo: <strong>{emailPreviewCode}</strong>
                  </div>
                ) : null}

                <form className="auth-method" onSubmit={handleEmailVerify}>
                  <div className="inline-form">
                    <label className="field field-grow">
                      <span>Código recibido</span>
                      <input
                        required
                        value={emailDraft.code}
                        onChange={(event) =>
                          setEmailDraft((current) => ({
                            ...current,
                            code: event.target.value,
                          }))
                        }
                        placeholder="123456"
                      />
                    </label>
                    <button
                      className="primary-button"
                      type="submit"
                      disabled={emailCodeVerifyMutation.isPending}
                    >
                      {emailCodeVerifyMutation.isPending
                        ? 'Verificando...'
                        : 'Verificar'}
                    </button>
                  </div>
                </form>

                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => demoAdminMutation.mutate()}
                  disabled={demoAdminMutation.isPending}
                >
                  Entrar como admin demo
                </button>
              </div>
            )}

            <p className="form-note auth-note">{authMessage}</p>
          </section>

          <section className="panel filters-panel">
            <div className="panel-header">
              <div>
                <p className="section-label">Filtrar</p>
                <h2>Encontrar rápido</h2>
              </div>
            </div>

            <label className="field">
              <span>Buscar por nombre, zona, etiqueta o producto</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Ej: Palermo, brunch, premezcla"
              />
            </label>

            <div className="chip-row">
              <FilterChip
                active={categoryFilter === 'all'}
                label="Todo"
                onClick={() => setCategoryFilter('all')}
              />
              {placeCategoryOptions.map((option) => (
                <FilterChip
                  key={option.value}
                  active={categoryFilter === option.value}
                  label={placeCategoryMeta[option.value].shortLabel}
                  onClick={() => setCategoryFilter(option.value)}
                />
              ))}
            </div>

            <div className="chip-group">
              <span className="detail-label">Etiquetas</span>
              <div className="chip-row">
                <FilterChip
                  active={tagFilter === 'all'}
                  label="Todas"
                  onClick={() => setTagFilter('all')}
                />
                {allTagOptions.slice(0, 12).map((tag) => (
                  <FilterChip
                    key={tag}
                    active={tagFilter === tag}
                    label={tag}
                    onClick={() => setTagFilter(tag)}
                  />
                ))}
              </div>
            </div>

            <div className="toggle-grid">
              <label className="toggle-card">
                <input
                  type="checkbox"
                  checked={verifiedOnly}
                  onChange={(event) => setVerifiedOnly(event.target.checked)}
                />
                <span>Solo verificados</span>
              </label>
              <label className="toggle-card">
                <input
                  type="checkbox"
                  checked={dedicatedOnly}
                  onChange={(event) => setDedicatedOnly(event.target.checked)}
                />
                <span>Solo cocina dedicada</span>
              </label>
            </div>
          </section>

          <section className="panel results-panel">
            <div className="panel-header">
              <div>
                <p className="section-label">Resultados</p>
                <h2>{filteredPlaces.length} lugares visibles</h2>
              </div>
            </div>

            <div className="results-list">
              {isError ? (
                <div className="empty-card">
                  No pude cargar la lista de lugares. Verificá que el backend esté activo.
                </div>
              ) : filteredPlaces.length === 0 ? (
                <div className="empty-card">
                  No hay coincidencias con esos filtros.
                </div>
              ) : (
                filteredPlaces.map((place) => (
                  <button
                    key={place.id}
                    type="button"
                    className={`place-card ${activePlace?.id === place.id ? 'place-card-active' : ''}`}
                    onClick={() => focusPlace(place)}
                  >
                    <div className="place-card-header">
                      <div>
                        <span
                          className="mini-badge"
                          style={{ color: placeCategoryMeta[place.category].color }}
                        >
                          {placeCategoryMeta[place.category].shortLabel}
                        </span>
                        <h3>{place.name}</h3>
                      </div>
                      <span
                        className={`status-badge ${place.approvalStatus === 'approved' ? 'status-approved' : 'status-pending'}`}
                      >
                        {getStatusLabel(place.approvalStatus)}
                      </span>
                    </div>

                    <p className="place-city">{place.city}</p>
                    <p className="place-address">{place.address}</p>

                    <div className="place-card-meta">
                      <RatingBadge place={place} />
                      {place.photos.length > 0 ? (
                        <span className="meta-pill">
                          {place.photos.length} foto{place.photos.length === 1 ? '' : 's'}
                        </span>
                      ) : null}
                    </div>

                    <div className="tag-row">
                      {place.verified ? (
                        <span className="soft-pill soft-pill-strong">Verificado</span>
                      ) : null}
                      {place.tags.slice(0, 3).map((tag) => (
                        <span key={tag} className="soft-pill">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </button>
                ))
              )}
            </div>
          </section>

          {isAdmin ? (
            <section className="panel moderation-panel">
              <div className="panel-header">
                <div>
                  <p className="section-label">Moderación</p>
                  <h2>{pendingPlaces.length} pendientes</h2>
                </div>
              </div>

              <div className="results-list">
                {pendingPlaces.length === 0 ? (
                  <div className="empty-card">No hay lugares pendientes.</div>
                ) : (
                  pendingPlaces.map((place) => (
                    <article key={place.id} className="moderation-card">
                      <div className="place-card-header">
                        <div>
                          <span
                            className="mini-badge"
                            style={{ color: placeCategoryMeta[place.category].color }}
                          >
                            {placeCategoryMeta[place.category].shortLabel}
                          </span>
                          <h3>{place.name}</h3>
                        </div>
                        <span className="status-badge status-pending">
                          Pendiente
                        </span>
                      </div>

                      <p className="place-address">{place.address}</p>
                      <p className="helper-copy">
                        Subido por {place.submittedBy.name} vía{' '}
                        {authMethodLabels[place.submittedBy.authMethod]}.
                      </p>
                      <p className="helper-copy">
                        {place.photos.length} foto{place.photos.length === 1 ? '' : 's'} cargada
                        {place.photos.length === 1 ? '' : 's'}.
                      </p>

                      <div className="form-actions">
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() => focusPlace(place)}
                        >
                          Ver en mapa
                        </button>
                        <button
                          className="primary-button"
                          type="button"
                          onClick={() => {
                            if (!session) {
                              return
                            }

                            approvePlaceMutation.mutate({
                              placeId: place.id,
                              actor: session,
                            })
                          }}
                          disabled={approvePlaceMutation.isPending}
                        >
                          Aprobar y publicar
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          ) : null}

          <section className="panel form-panel">
            <div className="panel-header">
              <div>
                <p className="section-label">Cargar lugar</p>
                <h2>Agregar un nuevo punto</h2>
              </div>
            </div>

            <p className="form-note">{formMessage}</p>

            <form className="place-form" onSubmit={handleSubmitPlace}>
              <fieldset className="form-fieldset" disabled={!session}>
                <label className="field">
                  <span>Nombre del lugar</span>
                  <input
                    required
                    value={draft.name}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                    placeholder="Ej: Casa Cero Gluten"
                  />
                </label>

                <div className="field-grid">
                  <label className="field">
                    <span>Tipo</span>
                    <select
                      value={draft.category}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          category: event.target.value as PlaceCategory,
                        }))
                      }
                    >
                      {placeCategoryOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="field">
                    <span>Ciudad o barrio</span>
                    <input
                      required
                      value={draft.city}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          city: event.target.value,
                        }))
                      }
                      placeholder="Ej: Chacarita, CABA"
                    />
                  </label>
                </div>

                <label className="field">
                  <span>Dirección</span>
                  <div className="inline-form">
                    <input
                      required
                      value={draft.address}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          address: event.target.value,
                        }))
                      }
                      placeholder="Calle y altura"
                    />
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() =>
                        geocodingMutation.mutate(
                          [draft.address, draft.city].filter(Boolean).join(', '),
                        )
                      }
                      disabled={geocodingMutation.isPending}
                    >
                      {geocodingMutation.isPending ? 'Buscando...' : 'Buscar'}
                    </button>
                  </div>
                </label>

                {geocodingResults.length > 1 ? (
                  <div className="search-results">
                    {geocodingResults.map((result) => (
                      <button
                        key={result.id}
                        className="search-result"
                        type="button"
                        onClick={() => {
                          applyGeocodingResult(result)
                          setFormMessage(`Ubicado en el mapa: ${result.label}.`)
                        }}
                      >
                        {result.label}
                      </button>
                    ))}
                  </div>
                ) : null}

                <label className="field">
                  <span>Descripción</span>
                  <textarea
                    required
                    rows={4}
                    value={draft.description}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        description: event.target.value,
                      }))
                    }
                    placeholder="Qué lo hace útil para una persona celíaca"
                  />
                </label>

                <label className="field">
                  <span>Productos destacados</span>
                  <textarea
                    rows={3}
                    value={draft.products}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        products: event.target.value,
                      }))
                    }
                    placeholder="Separados por coma: pizzas, alfajores, cerveza"
                  />
                </label>

                <label className="field">
                  <span>Fotos del lugar o del producto</span>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handlePhotoSelection}
                  />
                </label>

                {selectedPhotos.length > 0 ? (
                  <div className="upload-list">
                    {selectedPhotos.map((photo, index) => (
                      <div key={`${photo.name}-${index}`} className="upload-card">
                        <div>
                          <strong>{photo.name}</strong>
                          <p>{Math.max(1, Math.round(photo.size / 1024))} KB</p>
                        </div>
                        <button
                          className="ghost-button upload-remove"
                          type="button"
                          onClick={() => removeSelectedPhoto(index)}
                        >
                          Quitar
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="helper-copy">
                    Podés subir hasta {PLACE_PHOTO_LIMIT} fotos de 6 MB por lugar.
                  </p>
                )}

                <div className="chip-group">
                  <span className="detail-label">Etiquetas sugeridas</span>
                  <div className="chip-row">
                    {suggestedPlaceTags.map((tag) => (
                      <FilterChip
                        key={tag}
                        active={draft.selectedTags.includes(tag)}
                        label={tag}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            selectedTags: toggleTag(current.selectedTags, tag),
                          }))
                        }
                      />
                    ))}
                  </div>
                </div>

                <label className="field">
                  <span>Etiquetas personalizadas</span>
                  <input
                    value={draft.customTags}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        customTags: event.target.value,
                      }))
                    }
                    placeholder="Separadas por coma: menú infantil, cerveza, congelados"
                  />
                </label>

                <div className="field-grid">
                  <label className="field">
                    <span>Latitud</span>
                    <input
                      required
                      type="number"
                      step="0.000001"
                      value={draft.lat}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          lat: event.target.value,
                        }))
                      }
                    />
                  </label>

                  <label className="field">
                    <span>Longitud</span>
                    <input
                      required
                      type="number"
                      step="0.000001"
                      value={draft.lng}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          lng: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>

                <div className="toggle-grid">
                  <label className="toggle-card">
                    <input
                      type="checkbox"
                      checked={draft.dedicatedKitchen}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          dedicatedKitchen: event.target.checked,
                        }))
                      }
                    />
                    <span>Indicar cocina dedicada</span>
                  </label>

                  {isAdmin ? (
                    <label className="toggle-card">
                      <input
                        type="checkbox"
                        checked={draft.verified}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            verified: event.target.checked,
                          }))
                        }
                      />
                      <span>Marcar como verificado</span>
                    </label>
                  ) : (
                    <div className="toggle-card toggle-card-info">
                      <span>
                        Como usuario común, tu aporte queda pendiente hasta que
                        un admin lo apruebe.
                      </span>
                    </div>
                  )}
                </div>

                <div className="form-actions">
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={useMapCenterForDraft}
                  >
                    Usar centro del mapa
                  </button>
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={addPlaceMutation.isPending}
                  >
                    {addPlaceMutation.isPending
                      ? 'Guardando...'
                      : isAdmin
                        ? 'Publicar lugar'
                        : 'Enviar a revisión'}
                  </button>
                </div>
              </fieldset>
            </form>

            {!session ? (
              <div className="empty-card">
                Iniciá sesión para habilitar la carga de nuevos lugares.
              </div>
            ) : null}
          </section>
        </aside>
      </main>
    </div>
  )
}

function StatCard({
  value,
  label,
  detail,
}: {
  value: string
  label: string
  detail: string
}) {
  return (
    <article className="stat-card">
      <strong>{value}</strong>
      <span>{label}</span>
      <p>{detail}</p>
    </article>
  )
}

function LegendChip({ label, color }: { label: string; color: string }) {
  return (
    <span className="legend-chip">
      <span className="legend-dot" style={{ backgroundColor: color }} />
      {label}
    </span>
  )
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      className={`filter-chip ${active ? 'filter-chip-active' : ''}`}
      type="button"
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function getReviewCountLabel(reviewCount: number) {
  return `${reviewCount} reseña${reviewCount === 1 ? '' : 's'}`
}

function formatRatingValue(value: number) {
  return value.toFixed(1).replace('.', ',')
}

function renderStars(value: number) {
  const safeValue = Math.min(5, Math.max(1, Math.round(value)))
  return `${'★'.repeat(safeValue)}${'☆'.repeat(5 - safeValue)}`
}

function RatingStars({
  averageRating,
  reviewCount,
  compact = false,
}: {
  averageRating: number | null
  reviewCount: number
  compact?: boolean
}) {
  if (averageRating === null || reviewCount === 0) {
    return (
      <span className={`rating-line ${compact ? 'rating-line-compact' : ''}`}>
        Sin reseñas todavía
      </span>
    )
  }

  return (
    <span className={`rating-line ${compact ? 'rating-line-compact' : ''}`}>
      <strong>{renderStars(averageRating)}</strong>
      <span>{formatRatingValue(averageRating)}</span>
      <span>{getReviewCountLabel(reviewCount)}</span>
    </span>
  )
}

function RatingBadge({ place }: { place: Place }) {
  const { averageRating, reviewCount } = getPlaceRatingSummary(place)

  return (
    <RatingStars
      averageRating={averageRating}
      reviewCount={reviewCount}
      compact
    />
  )
}

function PlaceSpotlight({
  place,
  onLocate,
  session,
  reviewDraft,
  reviewMessage,
  reviewPending,
  onReviewDraftChange,
  onSubmitReview,
}: {
  place: Place | null
  onLocate: (place: Place) => void
  session: AuthUser | null
  reviewDraft: ReviewDraft
  reviewMessage: string | null
  reviewPending: boolean
  onReviewDraftChange: (
    value: ReviewDraft | ((current: ReviewDraft) => ReviewDraft),
  ) => void
  onSubmitReview: (
    event: FormEvent<HTMLFormElement>,
    placeId: string,
    approvalStatus: PlaceApprovalStatus,
  ) => void
}) {
  if (!place) {
    return (
      <div className="empty-card">
        Seleccioná un marcador para ver el detalle del lugar.
      </div>
    )
  }

  const category = placeCategoryMeta[place.category]
  const { averageRating, reviewCount } = getPlaceRatingSummary(place)

  return (
    <article className="spotlight-card">
      <div className="spotlight-header">
        <div>
          <p className="section-label">Lugar destacado</p>
          <h3>{place.name}</h3>
        </div>
        <span className="spotlight-category" style={{ color: category.color }}>
          {category.label}
        </span>
      </div>

      <div className="spotlight-meta-row">
        <RatingStars
          averageRating={averageRating}
          reviewCount={reviewCount}
        />
        <div className="tag-row">
          <span className="soft-pill">
            {place.photos.length === 0
              ? 'Sin fotos todavía'
              : `${place.photos.length} foto${place.photos.length === 1 ? '' : 's'}`}
          </span>
          {place.verified ? (
            <span className="soft-pill soft-pill-strong">Verificado</span>
          ) : null}
        </div>
      </div>

      {place.photos.length > 0 ? (
        <div className="photo-gallery">
          {place.photos.map((photo) => (
            <figure key={photo.id} className="photo-card">
              <img src={photo.url} alt={photo.alt} loading="lazy" />
            </figure>
          ))}
        </div>
      ) : (
        <div className="empty-inline">
          Todavía no hay fotos cargadas para este lugar.
        </div>
      )}

      <p className="spotlight-description">{place.description}</p>

      <div className="spotlight-grid">
        <div>
          <span className="detail-label">Estado</span>
          <strong>{getStatusLabel(place.approvalStatus)}</strong>
        </div>
        <div>
          <span className="detail-label">Zona</span>
          <strong>{place.city}</strong>
        </div>
        <div>
          <span className="detail-label">Dirección</span>
          <strong>{place.address}</strong>
        </div>
        <div>
          <span className="detail-label">Subido por</span>
          <strong>{place.submittedBy.name}</strong>
        </div>
        <div>
          <span className="detail-label">Actualizado</span>
          <strong>{formatDate(place.updatedAt)}</strong>
        </div>
        <div>
          <span className="detail-label">Aprobado por</span>
          <strong>{place.approvedByName ?? 'Aún sin aprobar'}</strong>
        </div>
      </div>

      <div className="tag-row">
        {place.dedicatedKitchen ? (
          <span className="soft-pill">Cocina dedicada</span>
        ) : null}
        {place.tags.map((tag) => (
          <span key={tag} className="soft-pill">
            {tag}
          </span>
        ))}
      </div>

      {place.products.length > 0 ? (
        <>
          <p className="detail-label">Productos o destacados</p>
          <div className="tag-row">
            {place.products.map((product) => (
              <span key={product} className="soft-pill soft-pill-strong">
                {product}
              </span>
            ))}
          </div>
        </>
      ) : null}

      <section className="reviews-section">
        <div className="reviews-header">
          <div>
            <p className="section-label">Reseñas</p>
            <h4>
              {reviewCount === 0
                ? 'Sin reseñas todavía'
                : getReviewCountLabel(reviewCount)}
            </h4>
          </div>
          {averageRating !== null ? (
            <span className="soft-pill soft-pill-strong">
              Promedio {formatRatingValue(averageRating)}/5
            </span>
          ) : null}
        </div>

        {place.approvalStatus !== 'approved' ? (
          <div className="empty-inline">
            Las reseñas se habilitan cuando el lugar ya está publicado.
          </div>
        ) : !session ? (
          <div className="empty-inline">
            Iniciá sesión para puntuar y dejar un comentario.
          </div>
        ) : (
          <form
            className="review-form"
            onSubmit={(event) =>
              onSubmitReview(event, place.id, place.approvalStatus)
            }
          >
            <div className="field-grid">
              <label className="field">
                <span>Puntuación</span>
                <select
                  value={String(reviewDraft.rating)}
                  onChange={(event) =>
                    onReviewDraftChange((current) => ({
                      ...current,
                      rating: Number.parseInt(event.target.value, 10),
                    }))
                  }
                >
                  <option value="5">5 · Excelente</option>
                  <option value="4">4 · Muy bueno</option>
                  <option value="3">3 · Bien</option>
                  <option value="2">2 · Flojo</option>
                  <option value="1">1 · Malo</option>
                </select>
              </label>
            </div>

            <label className="field">
              <span>Comentario</span>
              <textarea
                rows={4}
                value={reviewDraft.comment}
                onChange={(event) =>
                  onReviewDraftChange((current) => ({
                    ...current,
                    comment: event.target.value,
                  }))
                }
                placeholder="Contá cómo te fue, qué compraste o si volverías."
              />
            </label>

            <div className="form-actions review-actions">
              <p className="helper-copy">
                Si ya dejaste una reseña, la próxima publicación actualiza la tuya.
              </p>
              <button
                className="primary-button"
                type="submit"
                disabled={reviewPending}
              >
                {reviewPending ? 'Guardando reseña...' : 'Publicar reseña'}
              </button>
            </div>
          </form>
        )}

        {reviewMessage ? (
          <p className="form-note review-note">{reviewMessage}</p>
        ) : null}

        {place.reviews.length === 0 ? (
          <div className="empty-inline">
            Nadie dejó comentarios todavía.
          </div>
        ) : (
          <div className="review-list">
            {place.reviews.map((review) => (
              <article key={review.id} className="review-card">
                <div className="review-card-header">
                  <div>
                    <strong>{review.author.name}</strong>
                    <p className="helper-copy">
                      {authMethodLabels[review.author.authMethod]} ·{' '}
                      {formatDate(review.updatedAt)}
                    </p>
                  </div>
                  <span className="soft-pill soft-pill-strong">
                    {renderStars(review.rating)}
                  </span>
                </div>
                <p className="review-comment">{review.comment}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      <button
        className="ghost-button spotlight-button"
        type="button"
        onClick={() => onLocate(place)}
      >
        Recentrar marcador
      </button>
    </article>
  )
}

export default App

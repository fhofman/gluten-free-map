export interface GeocodingResult {
  id: string
  label: string
  city: string
  coordinates: [number, number]
}

interface NominatimResult {
  place_id: number
  display_name: string
  lat: string
  lon: string
  address?: {
    city?: string
    town?: string
    village?: string
    suburb?: string
    hamlet?: string
    city_district?: string
    municipality?: string
    county?: string
    state_district?: string
    province?: string
    state?: string
  }
}

function normalizeSearchQuery(query: string) {
  return query
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(', ')
    .replace(/\s+/g, ' ')
    .trim()
}

function foldText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es-AR')
}

function isCountrySegment(value: string) {
  return foldText(value) === 'argentina'
}

function isStateSegment(value: string) {
  const folded = foldText(value)

  return [
    'buenos aires',
    'provincia de buenos aires',
    'bs as',
    'caba',
    'capital federal',
    'ciudad de buenos aires',
    'ciudad autonoma de buenos aires',
  ].includes(folded)
}

function createBaseParams() {
  const params = new URLSearchParams()
  params.set('format', 'jsonv2')
  params.set('addressdetails', '1')
  params.set('limit', '5')
  params.set('countrycodes', 'ar')
  return params
}

function pushCandidate(
  candidates: URLSearchParams[],
  seenKeys: Set<string>,
  configure: (params: URLSearchParams) => void,
) {
  const params = createBaseParams()
  configure(params)

  const key = params.toString()

  if (seenKeys.has(key)) {
    return
  }

  seenKeys.add(key)
  candidates.push(params)
}

function buildSearchCandidates(normalizedQuery: string) {
  const candidates: URLSearchParams[] = []
  const seenKeys = new Set<string>()
  const querySegments = normalizedQuery
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)
  const foldedQuery = foldText(normalizedQuery)
  const hasCountry = foldedQuery.includes('argentina')
  const hasBuenosAires = foldedQuery.includes('buenos aires')

  if (querySegments.length >= 2) {
    const [street, city, thirdSegment, ...remainingSegments] = querySegments
    const county =
      thirdSegment && !isStateSegment(thirdSegment) && !isCountrySegment(thirdSegment)
        ? thirdSegment
        : ''
    const explicitState = [
      thirdSegment && isStateSegment(thirdSegment) ? thirdSegment : '',
      ...remainingSegments.filter((segment) => !isCountrySegment(segment)),
    ]
      .filter(Boolean)
      .join(', ')
    const inferredState =
      explicitState || (county && !hasBuenosAires ? 'Buenos Aires' : '')

    pushCandidate(candidates, seenKeys, (params) => {
      params.set('street', street)
      params.set('city', city)

      if (county) {
        params.set('county', county)
      }

      if (inferredState) {
        params.set('state', inferredState)
      }

      if (!hasCountry) {
        params.set('country', 'Argentina')
      }
    })

    pushCandidate(candidates, seenKeys, (params) => {
      params.set('street', street)
      params.set('city', city)

      if (inferredState) {
        params.set('state', inferredState)
      }

      if (!hasCountry) {
        params.set('country', 'Argentina')
      }
    })
  }

  pushCandidate(candidates, seenKeys, (params) => {
    params.set('q', normalizedQuery)
  })

  if (!hasBuenosAires || !hasCountry) {
    pushCandidate(candidates, seenKeys, (params) => {
      params.set(
        'q',
        [normalizedQuery, !hasBuenosAires ? 'Buenos Aires' : '', !hasCountry ? 'Argentina' : '']
          .filter(Boolean)
          .join(', '),
      )
    })
  }

  if (!hasBuenosAires) {
    pushCandidate(candidates, seenKeys, (params) => {
      params.set('q', `${normalizedQuery}, Buenos Aires`)
    })
  }

  if (!hasCountry) {
    pushCandidate(candidates, seenKeys, (params) => {
      params.set('q', `${normalizedQuery}, Argentina`)
    })
  }

  return candidates
}

async function requestNominatim(
  params: URLSearchParams,
  language: 'es' | 'en',
) {
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.search = params.toString()

  const response = await fetch(url.toString(), {
    headers: {
      'Accept-Language': language === 'es' ? 'es-AR,es;q=0.9,en;q=0.8' : 'en-US,en;q=0.9,es;q=0.8',
    },
  })

  if (!response.ok) {
    throw new Error(
      language === 'es'
        ? 'No pude consultar direcciones.'
        : 'Could not query addresses.',
    )
  }

  return (await response.json()) as NominatimResult[]
}

function getResultCity(result: NominatimResult) {
  return (
    result.address?.city ??
    result.address?.town ??
    result.address?.village ??
    result.address?.hamlet ??
    result.address?.suburb ??
    result.address?.city_district ??
    result.address?.municipality ??
    result.address?.county ??
    result.address?.state_district ??
    result.address?.province ??
    result.address?.state ??
    ''
  )
}

export async function searchAddress(query: string, language: 'es' | 'en') {
  const normalizedQuery = normalizeSearchQuery(query)

  if (!normalizedQuery) {
    throw new Error(language === 'es' ? 'Ingresá una dirección.' : 'Enter an address.')
  }

  const uniqueResults = new Map<number, GeocodingResult>()

  for (const candidate of buildSearchCandidates(normalizedQuery)) {
    const results = await requestNominatim(candidate, language)

    results.forEach((result) => {
      const latitude = Number.parseFloat(result.lat)
      const longitude = Number.parseFloat(result.lon)

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return
      }

      if (uniqueResults.has(result.place_id)) {
        return
      }

      uniqueResults.set(result.place_id, {
        id: `geo-${result.place_id}`,
        label: result.display_name,
        city: getResultCity(result),
        coordinates: [latitude, longitude] as [number, number],
      })
    })

    if (uniqueResults.size >= 5) {
      break
    }
  }

  return Array.from(uniqueResults.values()).slice(0, 5)
}

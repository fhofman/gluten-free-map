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
    state?: string
  }
}

export async function searchAddress(query: string, language: 'es' | 'en') {
  const normalizedQuery = query.trim()

  if (!normalizedQuery) {
    throw new Error(language === 'es' ? 'Ingresá una dirección.' : 'Enter an address.')
  }

  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', normalizedQuery)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('addressdetails', '1')
  url.searchParams.set('limit', '5')
  url.searchParams.set('countrycodes', 'ar')

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

  const data = (await response.json()) as NominatimResult[]

  return data
    .map((result) => {
      const latitude = Number.parseFloat(result.lat)
      const longitude = Number.parseFloat(result.lon)

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null
      }

      return {
        id: `geo-${result.place_id}`,
        label: result.display_name,
        city:
          result.address?.city ??
          result.address?.town ??
          result.address?.village ??
          result.address?.suburb ??
          result.address?.state ??
          '',
        coordinates: [latitude, longitude] as [number, number],
      } satisfies GeocodingResult
    })
    .filter((result): result is GeocodingResult => result !== null)
}

import express from 'express'
import multer from 'multer'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { demoAuthor, seedPlaces } from './seed-data.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const legacyDataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data')
const legacyUploadsDir = process.env.LEGACY_UPLOADS_DIR
  ? path.resolve(process.env.LEGACY_UPLOADS_DIR)
  : path.join(__dirname, 'uploads')
const legacyPlacesFile = path.join(legacyDataDir, 'places.json')
const distDir = path.join(projectRoot, 'dist')
const port = Number.parseInt(process.env.PORT ?? '3001', 10)
const host = process.env.HOST ?? '127.0.0.1'
const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL es obligatorio. Usá docker compose o configurá Postgres antes de iniciar el backend.',
  )
}

const pool = new Pool({
  connectionString: databaseUrl,
})

pool.on('error', (error) => {
  console.error('Postgres error:', error)
})

const VALID_CATEGORIES = new Set([
  'restaurant',
  'store',
  'market',
  'productSpot',
])
const VALID_ROLES = new Set(['admin', 'member'])
const VALID_AUTH_METHODS = new Set(['google', 'email-code', 'demo-admin'])

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

function makeId(prefix = 'id') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeList(values) {
  const seen = new Set()

  return values
    .map((value) => `${value}`.trim())
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

function sortPlaces(places) {
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

function normalizeAuthor(actor) {
  if (!actor || typeof actor !== 'object') {
    throw new HttpError(400, 'La sesion del usuario no es valida.')
  }

  const userId = `${actor.id ?? actor.userId ?? ''}`.trim()
  const name = `${actor.name ?? ''}`.trim()
  const email = `${actor.email ?? ''}`.trim().toLowerCase()
  const role = `${actor.role ?? ''}`.trim()
  const authMethod = `${actor.authMethod ?? ''}`.trim()

  if (!userId || !name || !email || !email.includes('@')) {
    throw new HttpError(400, 'La sesion del usuario no es valida.')
  }

  if (!VALID_ROLES.has(role) || !VALID_AUTH_METHODS.has(authMethod)) {
    throw new HttpError(400, 'La sesion del usuario no es valida.')
  }

  return {
    userId,
    name,
    email,
    role,
    authMethod,
  }
}

function normalizeReview(review) {
  const rating = Number.parseInt(`${review.rating ?? ''}`, 10)

  return {
    id: `${review.id ?? makeId('review')}`.trim(),
    rating: Number.isInteger(rating) ? Math.min(5, Math.max(1, rating)) : 1,
    comment: `${review.comment ?? ''}`.trim(),
    createdAt: `${review.createdAt ?? new Date().toISOString()}`,
    updatedAt: `${review.updatedAt ?? review.createdAt ?? new Date().toISOString()}`,
    author: normalizeAuthor(review.author),
  }
}

function normalizePlace(place) {
  return {
    id: `${place.id}`,
    name: `${place.name}`.trim(),
    category: VALID_CATEGORIES.has(place.category) ? place.category : 'store',
    city: `${place.city}`.trim(),
    address: `${place.address}`.trim(),
    coordinates:
      Array.isArray(place.coordinates) &&
      place.coordinates.length === 2 &&
      Number.isFinite(Number(place.coordinates[0])) &&
      Number.isFinite(Number(place.coordinates[1]))
        ? [Number(place.coordinates[0]), Number(place.coordinates[1])]
        : [-34.603722, -58.381592],
    description: `${place.description}`.trim(),
    tags: normalizeList(Array.isArray(place.tags) ? place.tags : []),
    products: normalizeList(Array.isArray(place.products) ? place.products : []),
    verified: Boolean(place.verified),
    dedicatedKitchen: Boolean(place.dedicatedKitchen),
    source: place.source === 'community' ? 'community' : 'demo',
    approvalStatus: place.approvalStatus === 'pending' ? 'pending' : 'approved',
    submittedBy: normalizeAuthor(place.submittedBy ?? demoAuthor),
    approvedByName:
      typeof place.approvedByName === 'string' && place.approvedByName.trim()
        ? place.approvedByName.trim()
        : undefined,
    approvedAt:
      typeof place.approvedAt === 'string' && place.approvedAt.trim()
        ? place.approvedAt
        : undefined,
    updatedAt: `${place.updatedAt ?? new Date().toISOString()}`,
    photos: Array.isArray(place.photos)
      ? place.photos
          .filter((photo) => photo && typeof photo.url === 'string')
          .map((photo, index) => ({
            id: `${photo.id ?? makeId('photo')}`,
            url: `${photo.url}`,
            alt:
              typeof photo.alt === 'string' && photo.alt.trim()
                ? photo.alt.trim()
                : `${place.name} - foto ${index + 1}`,
            uploadedAt: `${photo.uploadedAt ?? place.updatedAt ?? new Date().toISOString()}`,
          }))
      : [],
    reviews: Array.isArray(place.reviews)
      ? place.reviews
          .map(normalizeReview)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      : [],
  }
}

function parseJsonField(rawValue, fieldName) {
  if (typeof rawValue !== 'string') {
    throw new HttpError(400, `Falta el campo ${fieldName}.`)
  }

  try {
    return JSON.parse(rawValue)
  } catch {
    throw new HttpError(400, `El campo ${fieldName} no es valido.`)
  }
}

function ensureText(value, fieldName) {
  const normalized = `${value ?? ''}`.trim()

  if (!normalized) {
    throw new HttpError(400, `Completa el campo ${fieldName}.`)
  }

  return normalized
}

function ensureCoordinates(value) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new HttpError(400, 'Las coordenadas no son validas.')
  }

  const latitude = Number(value[0])
  const longitude = Number(value[1])

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new HttpError(400, 'Las coordenadas no son validas.')
  }

  return [latitude, longitude]
}

function ensureStringArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new HttpError(400, `El campo ${fieldName} no es valido.`)
  }

  return normalizeList(value)
}

function getPhotoUrl(photoId) {
  return `/api/photos/${photoId}`
}

function inferContentType(filename) {
  const extension = path.extname(filename).toLowerCase()

  if (extension === '.png') {
    return 'image/png'
  }

  if (extension === '.webp') {
    return 'image/webp'
  }

  if (extension === '.gif') {
    return 'image/gif'
  }

  if (extension === '.svg') {
    return 'image/svg+xml'
  }

  return 'image/jpeg'
}

function mapPlaceRow(row) {
  return normalizePlace({
    id: row.id,
    name: row.name,
    category: row.category,
    city: row.city,
    address: row.address,
    coordinates: [Number(row.latitude), Number(row.longitude)],
    description: row.description,
    tags: row.tags ?? [],
    products: row.products ?? [],
    verified: row.verified,
    dedicatedKitchen: row.dedicatedKitchen,
    source: row.source,
    approvalStatus: row.approvalStatus,
    submittedBy: row.submittedBy,
    approvedByName: row.approvedByName,
    approvedAt:
      row.approvedAt instanceof Date ? row.approvedAt.toISOString() : row.approvedAt,
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : `${row.updatedAt}`,
    photos: Array.isArray(row.photos) ? row.photos : [],
    reviews: Array.isArray(row.reviews) ? row.reviews : [],
  })
}

function buildSelectPlacesQuery(whereClause = '') {
  return `
    SELECT
      p.id,
      p.name,
      p.category,
      p.city,
      p.address,
      p.latitude,
      p.longitude,
      p.description,
      p.tags,
      p.products,
      p.verified,
      p.dedicated_kitchen AS "dedicatedKitchen",
      p.source,
      p.approval_status AS "approvalStatus",
      json_build_object(
        'userId', p.submitted_by_user_id,
        'name', p.submitted_by_name,
        'email', p.submitted_by_email,
        'role', p.submitted_by_role,
        'authMethod', p.submitted_by_auth_method
      ) AS "submittedBy",
      p.approved_by_name AS "approvedByName",
      p.approved_at AS "approvedAt",
      p.updated_at AS "updatedAt",
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'id', ph.id,
              'url', '/api/photos/' || ph.id,
              'alt', ph.alt,
              'uploadedAt', ph.uploaded_at
            )
            ORDER BY ph.uploaded_at
          )
          FROM place_photos ph
          WHERE ph.place_id = p.id
        ),
        '[]'::json
      ) AS photos,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'id', pr.id,
              'rating', pr.rating,
              'comment', pr.comment,
              'createdAt', pr.created_at,
              'updatedAt', pr.updated_at,
              'author', json_build_object(
                'userId', pr.author_user_id,
                'name', pr.author_name,
                'email', pr.author_email,
                'role', pr.author_role,
                'authMethod', pr.author_auth_method
              )
            )
            ORDER BY pr.updated_at DESC
          )
          FROM place_reviews pr
          WHERE pr.place_id = p.id
        ),
        '[]'::json
      ) AS reviews
    FROM places p
    ${whereClause}
    ORDER BY
      CASE WHEN p.approval_status = 'approved' THEN 0 ELSE 1 END,
      CASE WHEN p.verified THEN 0 ELSE 1 END,
      CASE WHEN p.dedicated_kitchen THEN 0 ELSE 1 END,
      p.updated_at DESC
  `
}

async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS places (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      city TEXT NOT NULL,
      address TEXT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      description TEXT NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      products TEXT[] NOT NULL DEFAULT '{}',
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      dedicated_kitchen BOOLEAN NOT NULL DEFAULT FALSE,
      source TEXT NOT NULL,
      approval_status TEXT NOT NULL,
      submitted_by_user_id TEXT NOT NULL,
      submitted_by_name TEXT NOT NULL,
      submitted_by_email TEXT NOT NULL,
      submitted_by_role TEXT NOT NULL,
      submitted_by_auth_method TEXT NOT NULL,
      approved_by_name TEXT,
      approved_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS place_photos (
      id TEXT PRIMARY KEY,
      place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
      alt TEXT NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      image_data BYTEA NOT NULL
    );

    CREATE TABLE IF NOT EXISTS place_reviews (
      id TEXT PRIMARY KEY,
      place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
      author_user_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_email TEXT NOT NULL,
      author_role TEXT NOT NULL,
      author_auth_method TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT place_reviews_unique_author UNIQUE (place_id, author_email)
    );

    CREATE INDEX IF NOT EXISTS place_photos_place_id_idx
      ON place_photos (place_id);

    CREATE INDEX IF NOT EXISTS place_reviews_place_id_idx
      ON place_reviews (place_id);
  `)
}

async function readLegacyPlaces() {
  try {
    const rawValue = await fs.readFile(legacyPlacesFile, 'utf8')
    const data = JSON.parse(rawValue)

    if (!Array.isArray(data)) {
      throw new Error('Formato invalido')
    }

    return data.map(normalizePlace)
  } catch {
    return seedPlaces.map(normalizePlace)
  }
}

async function resolveLegacyPhoto(photo, placeName) {
  if (!photo || typeof photo !== 'object' || typeof photo.url !== 'string') {
    return null
  }

  const filename = path.basename(photo.url)
  const filePath = path.join(legacyUploadsDir, filename)

  try {
    const imageData = await fs.readFile(filePath)

    return {
      id: `${photo.id ?? makeId('photo')}`,
      alt:
        typeof photo.alt === 'string' && photo.alt.trim()
          ? photo.alt.trim()
          : `${placeName} - foto`,
      uploadedAt: `${photo.uploadedAt ?? new Date().toISOString()}`,
      filename,
      contentType: inferContentType(filename),
      imageData,
    }
  } catch {
    return null
  }
}

async function insertPlace(client, place, photoPayloads = []) {
  await client.query(
    `
      INSERT INTO places (
        id,
        name,
        category,
        city,
        address,
        latitude,
        longitude,
        description,
        tags,
        products,
        verified,
        dedicated_kitchen,
        source,
        approval_status,
        submitted_by_user_id,
        submitted_by_name,
        submitted_by_email,
        submitted_by_role,
        submitted_by_auth_method,
        approved_by_name,
        approved_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::text[], $11, $12,
        $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
      )
    `,
    [
      place.id,
      place.name,
      place.category,
      place.city,
      place.address,
      place.coordinates[0],
      place.coordinates[1],
      place.description,
      place.tags,
      place.products,
      place.verified,
      place.dedicatedKitchen,
      place.source,
      place.approvalStatus,
      place.submittedBy.userId,
      place.submittedBy.name,
      place.submittedBy.email,
      place.submittedBy.role,
      place.submittedBy.authMethod,
      place.approvedByName ?? null,
      place.approvedAt ?? null,
      place.updatedAt,
    ],
  )

  for (const photo of photoPayloads) {
    await client.query(
      `
        INSERT INTO place_photos (
          id,
          place_id,
          alt,
          uploaded_at,
          filename,
          content_type,
          image_data
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        photo.id,
        place.id,
        photo.alt,
        photo.uploadedAt,
        photo.filename,
        photo.contentType,
        photo.imageData,
      ],
    )
  }

  for (const review of place.reviews) {
    await client.query(
      `
        INSERT INTO place_reviews (
          id,
          place_id,
          author_user_id,
          author_name,
          author_email,
          author_role,
          author_auth_method,
          rating,
          comment,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        review.id,
        place.id,
        review.author.userId,
        review.author.name,
        review.author.email,
        review.author.role,
        review.author.authMethod,
        review.rating,
        review.comment,
        review.createdAt,
        review.updatedAt,
      ],
    )
  }
}

async function seedDatabaseIfEmpty() {
  const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM places')

  if ((countResult.rows[0]?.count ?? 0) > 0) {
    return
  }

  const initialPlaces = await readLegacyPlaces()
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    for (const place of initialPlaces) {
      const legacyPhotos = await Promise.all(
        place.photos.map((photo) => resolveLegacyPhoto(photo, place.name)),
      )

      await insertPlace(
        client,
        place,
        legacyPhotos.filter((photo) => photo !== null),
      )
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function readPlaces(placeId = null) {
  const response = await pool.query(
    buildSelectPlacesQuery(placeId ? 'WHERE p.id = $1' : ''),
    placeId ? [placeId] : [],
  )

  return sortPlaces(response.rows.map(mapPlaceRow))
}

async function readPlaceOrThrow(placeId) {
  const places = await readPlaces(placeId)
  const place = places[0]

  if (!place) {
    throw new HttpError(404, 'No encontre ese lugar.')
  }

  return place
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 8,
    fileSize: 6 * 1024 * 1024,
  },
  fileFilter: (_request, file, callback) => {
    if (!file.mimetype.startsWith('image/')) {
      callback(new HttpError(400, 'Solo se permiten imagenes.'))
      return
    }

    callback(null, true)
  },
})

const app = express()

app.use(express.json({ limit: '1mb' }))

app.get('/api/health', async (_request, response, next) => {
  try {
    await pool.query('SELECT 1')
    response.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.get('/api/places', async (_request, response, next) => {
  try {
    response.json(await readPlaces())
  } catch (error) {
    next(error)
  }
})

app.get('/api/photos/:photoId', async (request, response, next) => {
  try {
    const result = await pool.query(
      `
        SELECT content_type AS "contentType", image_data AS "imageData"
        FROM place_photos
        WHERE id = $1
      `,
      [request.params.photoId],
    )

    const photo = result.rows[0]

    if (!photo) {
      throw new HttpError(404, 'No encontre esa foto.')
    }

    response.setHeader('Content-Type', photo.contentType)
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    response.send(photo.imageData)
  } catch (error) {
    next(error)
  }
})

app.post('/api/places', upload.array('photos', 8), async (request, response, next) => {
  const uploadedFiles = Array.isArray(request.files) ? request.files : []

  try {
    const actor = normalizeAuthor(parseJsonField(request.body.actor, 'actor'))
    const category = ensureText(request.body.category, 'tipo')

    if (!VALID_CATEGORIES.has(category)) {
      throw new HttpError(400, 'La categoria no es valida.')
    }

    const coordinates = ensureCoordinates(
      parseJsonField(request.body.coordinates, 'coordinates'),
    )
    const tags = ensureStringArray(parseJsonField(request.body.tags, 'tags'), 'tags')
    const products = ensureStringArray(
      parseJsonField(request.body.products, 'products'),
      'products',
    )
    const now = new Date().toISOString()
    const isAdmin = actor.role === 'admin'
    const placeName = ensureText(request.body.name, 'nombre del lugar')
    const nextPlace = normalizePlace({
      id: makeId('place'),
      name: placeName,
      category,
      city: ensureText(request.body.city, 'ciudad o barrio'),
      address: ensureText(request.body.address, 'direccion'),
      coordinates,
      description: ensureText(request.body.description, 'descripcion'),
      tags,
      products,
      verified: request.body.verified === 'true' && isAdmin,
      dedicatedKitchen: request.body.dedicatedKitchen === 'true',
      source: 'community',
      approvalStatus: isAdmin ? 'approved' : 'pending',
      submittedBy: actor,
      approvedByName: isAdmin ? actor.name : undefined,
      approvedAt: isAdmin ? now : undefined,
      updatedAt: now,
      photos: [],
      reviews: [],
    })
    const photoPayloads = uploadedFiles.map((file, index) => ({
      id: makeId('photo'),
      alt: `${placeName} - foto ${index + 1}`,
      uploadedAt: now,
      filename: file.originalname || `foto-${index + 1}.jpg`,
      contentType: file.mimetype || inferContentType(file.originalname || '.jpg'),
      imageData: file.buffer,
    }))
    const client = await pool.connect()

    try {
      await client.query('BEGIN')
      await insertPlace(client, nextPlace, photoPayloads)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    response.status(201).json(
      normalizePlace({
        ...nextPlace,
        photos: photoPayloads.map((photo) => ({
          id: photo.id,
          url: getPhotoUrl(photo.id),
          alt: photo.alt,
          uploadedAt: photo.uploadedAt,
        })),
      }),
    )
  } catch (error) {
    next(error)
  }
})

app.post('/api/places/:placeId/approve', async (request, response, next) => {
  try {
    const actor = normalizeAuthor(request.body?.actor)

    if (actor.role !== 'admin') {
      throw new HttpError(403, 'Solo un admin puede aprobar lugares.')
    }

    const now = new Date().toISOString()
    const result = await pool.query(
      `
        UPDATE places
        SET
          approval_status = 'approved',
          approved_by_name = $2,
          approved_at = $3,
          updated_at = $3
        WHERE id = $1
        RETURNING id
      `,
      [request.params.placeId, actor.name, now],
    )

    if (result.rowCount === 0) {
      throw new HttpError(404, 'No encontre ese lugar para aprobar.')
    }

    response.json(await readPlaceOrThrow(request.params.placeId))
  } catch (error) {
    next(error)
  }
})

app.post('/api/places/:placeId/reviews', async (request, response, next) => {
  try {
    const actor = normalizeAuthor(request.body?.actor)
    const rating = Number.parseInt(`${request.body?.rating ?? ''}`, 10)
    const comment = ensureText(request.body?.comment, 'comentario')

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new HttpError(400, 'La puntuacion debe estar entre 1 y 5.')
    }

    const placeExists = await pool.query(
      'SELECT 1 FROM places WHERE id = $1',
      [request.params.placeId],
    )

    if (placeExists.rowCount === 0) {
      throw new HttpError(404, 'No encontre ese lugar para comentar.')
    }

    const now = new Date().toISOString()
    await pool.query(
      `
        INSERT INTO place_reviews (
          id,
          place_id,
          author_user_id,
          author_name,
          author_email,
          author_role,
          author_auth_method,
          rating,
          comment,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
        ON CONFLICT (place_id, author_email)
        DO UPDATE SET
          author_user_id = EXCLUDED.author_user_id,
          author_name = EXCLUDED.author_name,
          author_role = EXCLUDED.author_role,
          author_auth_method = EXCLUDED.author_auth_method,
          rating = EXCLUDED.rating,
          comment = EXCLUDED.comment,
          updated_at = EXCLUDED.updated_at
      `,
      [
        makeId('review'),
        request.params.placeId,
        actor.userId,
        actor.name,
        actor.email,
        actor.role,
        actor.authMethod,
        rating,
        comment,
        now,
      ],
    )

    response.json(await readPlaceOrThrow(request.params.placeId))
  } catch (error) {
    next(error)
  }
})

try {
  await fs.access(distDir)
  app.use(express.static(distDir))
  app.get(/^\/(?!api).*/, (_request, response) => {
    response.sendFile(path.join(distDir, 'index.html'))
  })
} catch {}

app.use((error, _request, response, _next) => {
  const status =
    typeof error?.status === 'number'
      ? error.status
      : error instanceof multer.MulterError
        ? 400
        : 500

  const message =
    error instanceof multer.MulterError
      ? error.code === 'LIMIT_FILE_SIZE'
        ? 'Cada imagen puede pesar hasta 6 MB.'
        : error.code === 'LIMIT_FILE_COUNT'
          ? 'Puedes subir hasta 8 fotos por lugar.'
          : 'No pude procesar los archivos enviados.'
      : error instanceof Error && error.message
        ? error.message
        : 'Error interno del servidor.'

  if (status >= 500) {
    console.error(error)
  }

  response.status(status).json({ message })
})

await createSchema()
await seedDatabaseIfEmpty()

app.listen(port, host, () => {
  console.log(`API lista en http://${host}:${port}`)
})

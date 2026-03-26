import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { doubleCsrf } from 'csrf-csrf'
import { Pool } from 'pg'
import { WorkOS } from '@workos-inc/node'
import { z } from 'zod'
import { createRouteHandler as createUploadthingRouteHandler, createUploadthing } from 'uploadthing/express'
import { seedListings } from './seed-data.mjs'

const VALID_KINDS = new Set(['physical', 'online'])
const VALID_CATEGORIES = new Set([
  'restaurant',
  'store',
  'market',
  'productSpot',
  'onlineStore',
])
const VALID_APPROVAL_STATUSES = new Set(['approved', 'pending', 'rejected'])
const VALID_ROLES = new Set(['admin', 'member'])
const SESSION_COOKIE_NAME = 'gfm.session'
const AUTH_STATE_COOKIE_NAME = 'gfm.auth.state'
const AUTH_RETURN_COOKIE_NAME = 'gfm.auth.return'
const serverDir = dirname(fileURLToPath(import.meta.url))
const frontendDistDir = resolve(serverDir, '../dist/frontend')
const frontendIndexPath = resolve(frontendDistDir, 'index.html')
const hasFrontendBuild = existsSync(frontendIndexPath)

const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number.parseInt(process.env.PORT ?? '3001', 10),
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl: process.env.DATABASE_URL ?? '',
  frontendUrl: (process.env.FRONTEND_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, ''),
  backendUrl: (process.env.BACKEND_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, ''),
  workosApiKey: process.env.WORKOS_API_KEY ?? '',
  workosClientId: process.env.WORKOS_CLIENT_ID ?? '',
  workosCookiePassword: process.env.WORKOS_COOKIE_PASSWORD ?? '',
  workosRedirectUri:
    process.env.WORKOS_REDIRECT_URI ??
    `${(process.env.BACKEND_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '')}/api/auth/callback`,
  uploadthingToken: process.env.UPLOADTHING_TOKEN ?? '',
  cookieSameSite: process.env.COOKIE_SAME_SITE ?? 'lax',
  cookieDomain: process.env.COOKIE_DOMAIN ?? '',
  csrfSecret: process.env.CSRF_SECRET ?? process.env.WORKOS_COOKIE_PASSWORD ?? 'dev-csrf-secret',
  trustProxy: process.env.TRUST_PROXY ?? '1',
  allowedOrigins:
    process.env.ALLOWED_ORIGINS ??
    [
      process.env.FRONTEND_URL,
      process.env.BACKEND_URL,
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      'http://127.0.0.1:3001',
      'http://localhost:3001',
    ]
      .filter(Boolean)
      .join(','),
}

if (!env.databaseUrl) {
  throw new Error('DATABASE_URL es obligatorio para iniciar el backend.')
}

const pool = new Pool({
  connectionString: env.databaseUrl,
})

pool.on('error', (error) => {
  console.error('Postgres error:', error)
})

const workos = env.workosApiKey
  ? new WorkOS({
      apiKey: env.workosApiKey,
      clientId: env.workosClientId || undefined,
    })
  : null

const app = express()

if (env.trustProxy) {
  app.set('trust proxy', env.trustProxy === 'true' ? true : Number.parseInt(env.trustProxy, 10))
}

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: {
      policy: 'cross-origin',
    },
  }),
)

const allowedOrigins = new Set(
  env.allowedOrigins
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
)

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.size === 0 || allowedOrigins.has(origin)) {
        callback(null, true)
        return
      }

      callback(new Error('Origen no permitido por CORS.'))
    },
    credentials: true,
  }),
)

app.use(cookieParser())
app.use(express.json({ limit: '1mb' }))

function cookieOptions(overrides = {}) {
  return {
    httpOnly: true,
    sameSite: env.cookieSameSite,
    secure: env.nodeEnv === 'production',
    domain: env.cookieDomain || undefined,
    path: '/',
    ...overrides,
  }
}

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
})

const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
})

const {
  generateCsrfToken,
  doubleCsrfProtection,
  invalidCsrfTokenError,
} = doubleCsrf({
  getSecret: () => env.csrfSecret,
  getSessionIdentifier: (request) =>
    request.cookies[SESSION_COOKIE_NAME] ?? request.ip ?? 'anonymous',
  cookieName: 'gfm.csrf',
  cookieOptions: {
    sameSite: env.cookieSameSite,
    secure: env.nodeEnv === 'production',
    httpOnly: true,
    domain: env.cookieDomain || undefined,
    path: '/',
  },
  getCsrfTokenFromRequest: (request) => request.headers['x-csrf-token'],
  skipCsrfProtection: (request) =>
    request.path === '/api/auth/login' || request.path === '/api/auth/callback',
})

app.use('/api', doubleCsrfProtection)

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

function ensureWorkosConfigured() {
  if (!workos || !env.workosClientId || !env.workosCookiePassword) {
    throw new HttpError(
      503,
      'WorkOS no está configurado. Define WORKOS_API_KEY, WORKOS_CLIENT_ID y WORKOS_COOKIE_PASSWORD.',
    )
  }
}

function ensureUploadthingConfigured() {
  if (!env.uploadthingToken) {
    throw new HttpError(
      503,
      'UploadThing no está configurado. Define UPLOADTHING_TOKEN.',
    )
  }
}

function makeId(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID()}`
}

function normalizeStringList(values) {
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

function toNullableText(value) {
  const normalized = `${value ?? ''}`.trim()
  return normalized || null
}

function clampReturnTo(value) {
  const normalized = `${value ?? ''}`.trim()

  if (!normalized.startsWith('/')) {
    return '/'
  }

  if (normalized.startsWith('//')) {
    return '/'
  }

  return normalized
}

function redirectToFrontend(pathname = '/') {
  return new URL(clampReturnTo(pathname), `${env.frontendUrl}/`).toString()
}

const listingInputSchema = z
  .object({
    kind: z.enum(['physical', 'online']),
    name: z.string().trim().min(2).max(120),
    category: z.enum([
      'restaurant',
      'store',
      'market',
      'productSpot',
      'onlineStore',
    ]),
    city: z.string().trim().max(120).optional().nullable(),
    address: z.string().trim().max(160).optional().nullable(),
    coordinates: z
      .tuple([
        z.number().min(-90).max(90),
        z.number().min(-180).max(180),
      ])
      .nullable()
      .optional(),
    websiteUrl: z.string().trim().url().optional().nullable(),
    description: z.string().trim().min(12).max(2000),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
    products: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
    dedicatedKitchen: z.boolean().default(false),
    verified: z.boolean().default(false),
    photoKeys: z.array(z.string().trim().min(1)).max(8).default([]),
  })
  .superRefine((value, context) => {
    if (value.kind === 'physical') {
      if (!value.coordinates) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Selecciona una ubicacion en el mapa para el lugar fisico.',
          path: ['coordinates'],
        })
      }

      if (!value.city || value.city.length < 2) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Completa la ciudad o barrio.',
          path: ['city'],
        })
      }

      if (!value.address || value.address.length < 3) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Completa la direccion.',
          path: ['address'],
        })
      }
    }

    if (value.kind === 'online' && !value.websiteUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Completa la URL del sitio web.',
        path: ['websiteUrl'],
      })
    }
  })

const reviewInputSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().min(3).max(1000),
})

const moderationInputSchema = z.object({
  approvalStatus: z.enum(['approved', 'pending', 'rejected']),
  verified: z.boolean().optional(),
})

function mapListingRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    category: row.category,
    city: row.city,
    address: row.address,
    coordinates:
      Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude))
        ? [Number(row.latitude), Number(row.longitude)]
        : null,
    websiteUrl: row.websiteUrl,
    description: row.description,
    tags: Array.isArray(row.tags) ? row.tags : [],
    products: Array.isArray(row.products) ? row.products : [],
    verified: Boolean(row.verified),
    dedicatedKitchen: Boolean(row.dedicatedKitchen),
    source: row.source,
    approvalStatus: row.approvalStatus,
    submittedBy: {
      userId: row.submittedByUserId,
      name: row.submittedByName,
      email: row.submittedByEmail,
      role: row.submittedByRole,
    },
    approvedByName: row.approvedByName,
    approvedAt:
      row.approvedAt instanceof Date ? row.approvedAt.toISOString() : row.approvedAt,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    photos: Array.isArray(row.photos) ? row.photos : [],
    reviews: Array.isArray(row.reviews) ? row.reviews : [],
  }
}

function buildSelectListingsQuery(whereClause = '') {
  return `
    SELECT
      l.id,
      l.kind,
      l.name,
      l.category,
      l.city,
      l.address,
      l.latitude,
      l.longitude,
      l.website_url AS "websiteUrl",
      l.description,
      l.tags,
      l.products,
      l.verified,
      l.dedicated_kitchen AS "dedicatedKitchen",
      l.source,
      l.approval_status AS "approvalStatus",
      l.submitted_by_user_id AS "submittedByUserId",
      l.submitted_by_name AS "submittedByName",
      l.submitted_by_email AS "submittedByEmail",
      l.submitted_by_role AS "submittedByRole",
      l.approved_by_name AS "approvedByName",
      l.approved_at AS "approvedAt",
      l.created_at AS "createdAt",
      l.updated_at AS "updatedAt",
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'id', lp.id,
              'key', lp.storage_key,
              'url', lp.file_url,
              'alt', lp.alt,
              'uploadedAt', lp.uploaded_at
            )
            ORDER BY lp.sort_order, lp.uploaded_at
          )
          FROM listing_photos lp
          WHERE lp.listing_id = l.id
        ),
        '[]'::json
      ) AS photos,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'id', lr.id,
              'rating', lr.rating,
              'comment', lr.comment,
              'createdAt', lr.created_at,
              'updatedAt', lr.updated_at,
              'author', json_build_object(
                'userId', lr.author_user_id,
                'name', lr.author_name,
                'email', lr.author_email,
                'role', lr.author_role
              )
            )
            ORDER BY lr.updated_at DESC
          )
          FROM listing_reviews lr
          WHERE lr.listing_id = l.id
        ),
        '[]'::json
      ) AS reviews
    FROM listings l
    ${whereClause}
    ORDER BY
      CASE l.approval_status
        WHEN 'approved' THEN 0
        WHEN 'pending' THEN 1
        ELSE 2
      END,
      CASE WHEN l.verified THEN 0 ELSE 1 END,
      l.updated_at DESC
  `
}

async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      workos_user_id TEXT UNIQUE,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      preferred_language TEXT NOT NULL DEFAULT 'es',
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      city TEXT,
      address TEXT,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      website_url TEXT,
      description TEXT NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      products TEXT[] NOT NULL DEFAULT '{}',
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      dedicated_kitchen BOOLEAN NOT NULL DEFAULT FALSE,
      source TEXT NOT NULL,
      approval_status TEXT NOT NULL,
      submitted_by_user_id TEXT,
      submitted_by_name TEXT NOT NULL,
      submitted_by_email TEXT NOT NULL,
      submitted_by_role TEXT NOT NULL,
      approved_by_user_id TEXT,
      approved_by_name TEXT,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS listing_photos (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      storage_provider TEXT NOT NULL,
      storage_key TEXT,
      file_url TEXT NOT NULL,
      file_name TEXT NOT NULL,
      alt TEXT NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS listing_reviews (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      author_user_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_email TEXT NOT NULL,
      author_role TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT listing_reviews_unique_author UNIQUE (listing_id, author_email)
    );

    CREATE TABLE IF NOT EXISTS pending_uploads (
      file_key TEXT PRIMARY KEY,
      file_url TEXT NOT NULL,
      file_name TEXT NOT NULL,
      uploader_user_id TEXT NOT NULL,
      uploader_email TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS listings_kind_idx ON listings (kind);
    CREATE INDEX IF NOT EXISTS listings_approval_status_idx ON listings (approval_status);
    CREATE INDEX IF NOT EXISTS listings_verified_idx ON listings (verified);
    CREATE INDEX IF NOT EXISTS listing_photos_listing_id_idx ON listing_photos (listing_id);
    CREATE INDEX IF NOT EXISTS listing_reviews_listing_id_idx ON listing_reviews (listing_id);
    CREATE INDEX IF NOT EXISTS pending_uploads_uploader_idx ON pending_uploads (uploader_user_id, consumed_at);
  `)
}

async function upsertUserFromWorkos(workosUser) {
  const userId = makeId('user')
  const now = new Date().toISOString()
  const email = `${workosUser.email ?? ''}`.trim().toLowerCase()
  const name = `${workosUser.firstName ?? ''} ${workosUser.lastName ?? ''}`.trim()
  const fallbackName = name || `${workosUser.email ?? 'Miembro'}`

  const result = await pool.query(
    `
      INSERT INTO users (
        id,
        workos_user_id,
        email,
        name,
        role,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, 'member', $5, $5)
      ON CONFLICT (email)
      DO UPDATE SET
        workos_user_id = COALESCE(users.workos_user_id, EXCLUDED.workos_user_id),
        name = EXCLUDED.name,
        updated_at = EXCLUDED.updated_at
      RETURNING id, email, name, role
    `,
    [userId, workosUser.id ?? null, email, fallbackName, now],
  )

  return result.rows[0]
}

async function readSessionFromRequest(request) {
  if (!workos || !env.workosCookiePassword) {
    return null
  }

  const sessionData = request.cookies[SESSION_COOKIE_NAME]

  if (!sessionData) {
    return null
  }

  const session = await workos.userManagement.authenticateWithSessionCookie({
    sessionData,
    cookiePassword: env.workosCookiePassword,
  })

  if (!session.authenticated) {
    return null
  }

  const user = await upsertUserFromWorkos(session.user)

  return {
    sessionId: session.sessionId,
    workosUser: session.user,
    user,
  }
}

async function requireSession(request) {
  ensureWorkosConfigured()
  const session = await readSessionFromRequest(request)

  if (!session) {
    throw new HttpError(401, 'Inicia sesion para continuar.')
  }

  return session
}

async function requireAdmin(request) {
  const session = await requireSession(request)

  if (session.user.role !== 'admin') {
    throw new HttpError(403, 'Solo un admin puede acceder a esta accion.')
  }

  return session
}

async function insertListing(client, listing, photos = [], reviews = []) {
  await client.query(
    `
      INSERT INTO listings (
        id,
        kind,
        name,
        category,
        city,
        address,
        latitude,
        longitude,
        website_url,
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
        approved_by_user_id,
        approved_by_name,
        approved_at,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12::text[], $13,
        $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
      )
    `,
    [
      listing.id,
      listing.kind,
      listing.name,
      listing.category,
      listing.city,
      listing.address,
      listing.coordinates?.[0] ?? null,
      listing.coordinates?.[1] ?? null,
      listing.websiteUrl,
      listing.description,
      listing.tags,
      listing.products,
      listing.verified,
      listing.dedicatedKitchen,
      listing.source,
      listing.approvalStatus,
      listing.submittedBy.userId,
      listing.submittedBy.name,
      listing.submittedBy.email,
      listing.submittedBy.role,
      listing.approvedByUserId ?? null,
      listing.approvedByName ?? null,
      listing.approvedAt ?? null,
      listing.createdAt,
      listing.updatedAt,
    ],
  )

  for (const [index, photo] of photos.entries()) {
    await client.query(
      `
        INSERT INTO listing_photos (
          id,
          listing_id,
          storage_provider,
          storage_key,
          file_url,
          file_name,
          alt,
          uploaded_at,
          sort_order
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        photo.id,
        listing.id,
        photo.storageProvider,
        photo.storageKey,
        photo.fileUrl,
        photo.fileName,
        photo.alt,
        photo.uploadedAt,
        index,
      ],
    )
  }

  for (const review of reviews) {
    await client.query(
      `
        INSERT INTO listing_reviews (
          id,
          listing_id,
          author_user_id,
          author_name,
          author_email,
          author_role,
          rating,
          comment,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        review.id,
        listing.id,
        review.author.userId,
        review.author.name,
        review.author.email,
        review.author.role,
        review.rating,
        review.comment,
        review.createdAt,
        review.updatedAt,
      ],
    )
  }
}

async function readListings({ kind = 'all', approval = 'approved' } = {}) {
  const values = []
  const where = []

  if (kind !== 'all') {
    values.push(kind)
    where.push(`l.kind = $${values.length}`)
  }

  if (approval !== 'all') {
    values.push(approval)
    where.push(`l.approval_status = $${values.length}`)
  }

  const response = await pool.query(
    buildSelectListingsQuery(where.length ? `WHERE ${where.join(' AND ')}` : ''),
    values,
  )

  return response.rows.map(mapListingRow)
}

async function readListingOrThrow(listingId) {
  const response = await pool.query(buildSelectListingsQuery('WHERE l.id = $1'), [listingId])
  const listing = response.rows[0]

  if (!listing) {
    throw new HttpError(404, 'No encontre ese item.')
  }

  return mapListingRow(listing)
}

async function tableExists(name) {
  const result = await pool.query(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [`public.${name}`],
  )

  return Boolean(result.rows[0]?.exists)
}

async function migrateLegacyPlacesIfNeeded() {
  const listingCount = await pool.query('SELECT COUNT(*)::int AS count FROM listings')

  if ((listingCount.rows[0]?.count ?? 0) > 0) {
    return
  }

  const legacyPlacesExists = await tableExists('places')
  const legacyPhotosExists = await tableExists('place_photos')
  const legacyReviewsExists = await tableExists('place_reviews')

  if (!legacyPlacesExists) {
    return
  }

  const legacyPlaces = await pool.query(`
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
      p.submitted_by_user_id AS "submittedByUserId",
      p.submitted_by_name AS "submittedByName",
      p.submitted_by_email AS "submittedByEmail",
      p.submitted_by_role AS "submittedByRole",
      p.approved_by_name AS "approvedByName",
      p.approved_at AS "approvedAt",
      p.updated_at AS "updatedAt"
    FROM places p
    ORDER BY p.updated_at DESC
  `)

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    for (const row of legacyPlaces.rows) {
      const listing = {
        id: row.id,
        kind: 'physical',
        name: row.name,
        category: row.category,
        city: row.city,
        address: row.address,
        coordinates: [Number(row.latitude), Number(row.longitude)],
        websiteUrl: null,
        description: row.description,
        tags: Array.isArray(row.tags) ? row.tags : [],
        products: Array.isArray(row.products) ? row.products : [],
        verified: Boolean(row.verified),
        dedicatedKitchen: Boolean(row.dedicatedKitchen),
        source: row.source ?? 'legacy',
        approvalStatus: row.approvalStatus ?? 'approved',
        submittedBy: {
          userId: row.submittedByUserId,
          name: row.submittedByName,
          email: row.submittedByEmail,
          role: row.submittedByRole ?? 'member',
        },
        approvedByUserId: null,
        approvedByName: row.approvedByName,
        approvedAt:
          row.approvedAt instanceof Date ? row.approvedAt.toISOString() : row.approvedAt,
        createdAt:
          row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
        updatedAt:
          row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
      }

      const photos = legacyPhotosExists
        ? (
            await client.query(
              `
                SELECT id, filename, uploaded_at AS "uploadedAt"
                FROM place_photos
                WHERE place_id = $1
                ORDER BY uploaded_at
              `,
              [row.id],
            )
          ).rows.map((photo) => ({
            id: photo.id,
            storageProvider: 'legacy-db',
            storageKey: photo.id,
            fileUrl: `${env.backendUrl}/api/legacy-photos/${photo.id}`,
            fileName: photo.filename ?? `${photo.id}.jpg`,
            alt: `${row.name} - foto`,
            uploadedAt:
              photo.uploadedAt instanceof Date
                ? photo.uploadedAt.toISOString()
                : photo.uploadedAt,
          }))
        : []

      const reviews = legacyReviewsExists
        ? (
            await client.query(
              `
                SELECT
                  id,
                  author_user_id AS "authorUserId",
                  author_name AS "authorName",
                  author_email AS "authorEmail",
                  author_role AS "authorRole",
                  rating,
                  comment,
                  created_at AS "createdAt",
                  updated_at AS "updatedAt"
                FROM place_reviews
                WHERE place_id = $1
                ORDER BY updated_at DESC
              `,
              [row.id],
            )
          ).rows.map((review) => ({
            id: review.id,
            author: {
              userId: review.authorUserId,
              name: review.authorName,
              email: review.authorEmail,
              role: review.authorRole ?? 'member',
            },
            rating: review.rating,
            comment: review.comment,
            createdAt:
              review.createdAt instanceof Date
                ? review.createdAt.toISOString()
                : review.createdAt,
            updatedAt:
              review.updatedAt instanceof Date
                ? review.updatedAt.toISOString()
                : review.updatedAt,
          }))
        : []

      await insertListing(client, listing, photos, reviews)
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function seedListingsIfEmpty() {
  const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM listings')

  if ((countResult.rows[0]?.count ?? 0) > 0) {
    return
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    for (const listing of seedListings) {
      await insertListing(client, listing, listing.photos, listing.reviews)
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function reserveUploadedPhotos(user, photoKeys) {
  if (photoKeys.length === 0) {
    return []
  }

  const result = await pool.query(
    `
      SELECT file_key AS "fileKey", file_url AS "fileUrl", file_name AS "fileName"
      FROM pending_uploads
      WHERE
        file_key = ANY($1::text[])
        AND uploader_user_id = $2
        AND consumed_at IS NULL
      ORDER BY created_at ASC
    `,
    [photoKeys, user.id],
  )

  if (result.rows.length !== photoKeys.length) {
    throw new HttpError(
      400,
      'Hay fotos que no te pertenecen, vencieron o no terminaron de subir.',
    )
  }

  return result.rows.map((photo) => ({
    id: makeId('photo'),
    storageProvider: 'uploadthing',
    storageKey: photo.fileKey,
    fileUrl: photo.fileUrl,
    fileName: photo.fileName,
    alt: `${photo.fileName}`.replace(/\.[^.]+$/, ''),
    uploadedAt: new Date().toISOString(),
  }))
}

async function consumeUploadedPhotos(client, photoKeys) {
  if (photoKeys.length === 0) {
    return
  }

  await client.query(
    `
      UPDATE pending_uploads
      SET consumed_at = NOW()
      WHERE file_key = ANY($1::text[])
    `,
    [photoKeys],
  )
}

const uploadThing = createUploadthing()

const uploadRouter = {
  listingImage: uploadThing(
    {
      image: {
        maxFileSize: '4MB',
        maxFileCount: 8,
      },
    },
    {
      awaitServerData: true,
    },
  )
    .middleware(async ({ req }) => {
      ensureUploadthingConfigured()
      const session = await requireSession(req)

      return {
        userId: session.user.id,
        email: session.user.email,
      }
    })
    .onUploadComplete(async ({ metadata, file }) => {
      await pool.query(
        `
          INSERT INTO pending_uploads (
            file_key,
            file_url,
            file_name,
            uploader_user_id,
            uploader_email,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (file_key)
          DO UPDATE SET
            file_url = EXCLUDED.file_url,
            file_name = EXCLUDED.file_name,
            uploader_user_id = EXCLUDED.uploader_user_id,
            uploader_email = EXCLUDED.uploader_email
        `,
        [file.key, file.ufsUrl, file.name, metadata.userId, metadata.email],
      )

      return {
        key: file.key,
        url: file.ufsUrl,
        name: file.name,
      }
    }),
}

app.use(
  '/api/uploadthing',
  writeLimiter,
  createUploadthingRouteHandler({
    router: uploadRouter,
    config: {
      token: env.uploadthingToken,
      callbackUrl: `${env.backendUrl}/api/uploadthing`,
      isDev: env.nodeEnv !== 'production',
    },
  }),
)

app.get('/api/health', async (_request, response, next) => {
  try {
    await pool.query('SELECT 1')
    response.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.get('/api/auth/session', async (request, response, next) => {
  try {
    const session = await readSessionFromRequest(request)

    response.json({
      authConfigured: Boolean(workos && env.workosClientId && env.workosCookiePassword),
      uploadConfigured: Boolean(env.uploadthingToken),
      csrfToken: generateCsrfToken(request, response),
      user: session?.user ?? null,
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/auth/login', authLimiter, async (request, response, next) => {
  try {
    ensureWorkosConfigured()
    const screenHint =
      request.query.screenHint === 'sign-up' ? 'sign-up' : 'sign-in'
    const state = crypto.randomUUID()
    const returnTo = clampReturnTo(request.query.returnTo)

    response.cookie(AUTH_STATE_COOKIE_NAME, state, cookieOptions({ maxAge: 10 * 60 * 1000 }))
    response.cookie(
      AUTH_RETURN_COOKIE_NAME,
      returnTo,
      cookieOptions({ maxAge: 10 * 60 * 1000 }),
    )

    const authorizationUrl = workos.userManagement.getAuthorizationUrl({
      provider: 'authkit',
      clientId: env.workosClientId,
      redirectUri: env.workosRedirectUri,
      state,
      screenHint,
    })

    response.redirect(authorizationUrl)
  } catch (error) {
    next(error)
  }
})

app.get('/api/auth/callback', authLimiter, async (request, response, next) => {
  try {
    ensureWorkosConfigured()
    const code = `${request.query.code ?? ''}`.trim()
    const state = `${request.query.state ?? ''}`.trim()
    const expectedState = request.cookies[AUTH_STATE_COOKIE_NAME]
    const returnTo = request.cookies[AUTH_RETURN_COOKIE_NAME] ?? '/'

    response.clearCookie(AUTH_STATE_COOKIE_NAME, cookieOptions())
    response.clearCookie(AUTH_RETURN_COOKIE_NAME, cookieOptions())

    if (!code || !state || !expectedState || state !== expectedState) {
      throw new HttpError(400, 'No pude validar el regreso desde WorkOS.')
    }

    const authentication = await workos.userManagement.authenticateWithCode({
      code,
      clientId: env.workosClientId,
      userAgent: request.get('user-agent') ?? undefined,
      ipAddress: request.ip,
      session: {
        sealSession: true,
        cookiePassword: env.workosCookiePassword,
      },
    })

    if (!authentication.sealedSession) {
      throw new HttpError(500, 'WorkOS no devolvio una sesion valida.')
    }

    await upsertUserFromWorkos(authentication.user)

    response.cookie(
      SESSION_COOKIE_NAME,
      authentication.sealedSession,
      cookieOptions({
        maxAge: 1000 * 60 * 60 * 24 * 7,
      }),
    )

    response.redirect(redirectToFrontend(returnTo))
  } catch (error) {
    next(error)
  }
})

app.post('/api/auth/logout', authLimiter, async (request, response, next) => {
  try {
    ensureWorkosConfigured()
    const sessionData = request.cookies[SESSION_COOKIE_NAME]

    if (sessionData) {
      const session = await workos.userManagement.authenticateWithSessionCookie({
        sessionData,
        cookiePassword: env.workosCookiePassword,
      })

      if (session.authenticated) {
        await workos.userManagement.revokeSession({
          sessionId: session.sessionId,
        })
      }
    }

    response.clearCookie(SESSION_COOKIE_NAME, cookieOptions())
    response.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.get('/api/listings', async (request, response, next) => {
  try {
    const kind = VALID_KINDS.has(`${request.query.kind ?? ''}`)
      ? `${request.query.kind}`
      : 'all'
    const includeAll =
      `${request.query.approval ?? 'approved'}` === 'all' &&
      (await readSessionFromRequest(request))?.user.role === 'admin'
    const approval = includeAll ? 'all' : 'approved'

    response.json(await readListings({ kind, approval }))
  } catch (error) {
    next(error)
  }
})

app.get('/api/listings/:listingId', async (request, response, next) => {
  try {
    const session = await readSessionFromRequest(request)
    const listing = await readListingOrThrow(request.params.listingId)

    if (listing.approvalStatus !== 'approved' && session?.user.role !== 'admin') {
      throw new HttpError(404, 'No encontre ese item.')
    }

    response.json(listing)
  } catch (error) {
    next(error)
  }
})

app.get('/api/admin/pending', async (request, response, next) => {
  try {
    await requireAdmin(request)
    const items = await readListings({ kind: 'all', approval: 'all' })
    response.json(items.filter((item) => item.approvalStatus !== 'approved' || !item.verified))
  } catch (error) {
    next(error)
  }
})

app.get('/api/legacy-photos/:photoId', async (request, response, next) => {
  try {
    const exists = await tableExists('place_photos')

    if (!exists) {
      throw new HttpError(404, 'No encontre esa foto heredada.')
    }

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
      throw new HttpError(404, 'No encontre esa foto heredada.')
    }

    response.setHeader('Content-Type', photo.contentType)
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    response.send(photo.imageData)
  } catch (error) {
    next(error)
  }
})

app.post('/api/listings', writeLimiter, async (request, response, next) => {
  try {
    const session = await requireSession(request)
    const parsed = listingInputSchema.safeParse(request.body)

    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Los datos del item no son validos.')
    }

    const input = parsed.data
    const now = new Date().toISOString()
    const isAdmin = session.user.role === 'admin'
    const photoKeys = normalizeStringList(input.photoKeys)
    const photos = await reserveUploadedPhotos(session.user, photoKeys)

    const listing = {
      id: makeId('listing'),
      kind: input.kind,
      name: input.name,
      category: input.category,
      city: input.kind === 'online' ? null : toNullableText(input.city),
      address: input.kind === 'online' ? null : toNullableText(input.address),
      coordinates: input.kind === 'physical' ? input.coordinates : null,
      websiteUrl: input.kind === 'online' ? input.websiteUrl : toNullableText(input.websiteUrl),
      description: input.description,
      tags: normalizeStringList(input.tags),
      products: normalizeStringList(input.products),
      verified: isAdmin ? Boolean(input.verified) : false,
      dedicatedKitchen: input.kind === 'physical' ? Boolean(input.dedicatedKitchen) : false,
      source: 'community',
      approvalStatus: isAdmin ? 'approved' : 'pending',
      submittedBy: {
        userId: session.user.id,
        name: session.user.name,
        email: session.user.email,
        role: session.user.role,
      },
      approvedByUserId: isAdmin ? session.user.id : null,
      approvedByName: isAdmin ? session.user.name : null,
      approvedAt: isAdmin ? now : null,
      createdAt: now,
      updatedAt: now,
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')
      await insertListing(client, listing, photos, [])
      await consumeUploadedPhotos(client, photoKeys)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    response.status(201).json(await readListingOrThrow(listing.id))
  } catch (error) {
    next(error)
  }
})

app.post('/api/listings/:listingId/reviews', writeLimiter, async (request, response, next) => {
  try {
    const session = await requireSession(request)
    const parsed = reviewInputSchema.safeParse(request.body)

    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'La review no es valida.')
    }

    const listing = await readListingOrThrow(request.params.listingId)

    if (listing.approvalStatus !== 'approved') {
      throw new HttpError(400, 'Solo puedes evaluar items ya aprobados.')
    }

    const now = new Date().toISOString()

    await pool.query(
      `
        INSERT INTO listing_reviews (
          id,
          listing_id,
          author_user_id,
          author_name,
          author_email,
          author_role,
          rating,
          comment,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
        ON CONFLICT (listing_id, author_email)
        DO UPDATE SET
          author_user_id = EXCLUDED.author_user_id,
          author_name = EXCLUDED.author_name,
          author_role = EXCLUDED.author_role,
          rating = EXCLUDED.rating,
          comment = EXCLUDED.comment,
          updated_at = EXCLUDED.updated_at
      `,
      [
        makeId('review'),
        listing.id,
        session.user.id,
        session.user.name,
        session.user.email,
        session.user.role,
        parsed.data.rating,
        parsed.data.comment,
        now,
      ],
    )

    response.json(await readListingOrThrow(listing.id))
  } catch (error) {
    next(error)
  }
})

app.post('/api/admin/listings/:listingId/moderate', writeLimiter, async (request, response, next) => {
  try {
    const session = await requireAdmin(request)
    const parsed = moderationInputSchema.safeParse(request.body)

    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? 'La moderacion no es valida.',
      )
    }

    const now = new Date().toISOString()
    const { approvalStatus, verified } = parsed.data
    const result = await pool.query(
      `
        UPDATE listings
        SET
          approval_status = $2,
          verified = COALESCE($3, verified),
          approved_by_user_id = CASE WHEN $2 = 'approved' THEN $4 ELSE approved_by_user_id END,
          approved_by_name = CASE WHEN $2 = 'approved' THEN $5 ELSE approved_by_name END,
          approved_at = CASE WHEN $2 = 'approved' THEN $6 ELSE approved_at END,
          updated_at = $6
        WHERE id = $1
        RETURNING id
      `,
      [request.params.listingId, approvalStatus, verified ?? null, session.user.id, session.user.name, now],
    )

    if (result.rowCount === 0) {
      throw new HttpError(404, 'No encontre ese item para moderar.')
    }

    response.json(await readListingOrThrow(request.params.listingId))
  } catch (error) {
    next(error)
  }
})

app.use('/api', (_request, response) => {
  response.status(404).json({ message: 'No encontre esa ruta.' })
})

if (hasFrontendBuild) {
  app.use(
    express.static(frontendDistDir, {
      index: false,
    }),
  )

  app.get(/^\/(?!api(?:\/|$)).*/, (_request, response) => {
    response.sendFile(frontendIndexPath)
  })
}

app.use((error, _request, response, _next) => {
  if (error === invalidCsrfTokenError) {
    response.status(403).json({
      message: 'La sesion de seguridad vencio. Recarga la pagina e intenta de nuevo.',
    })
    return
  }

  const status = typeof error?.status === 'number' ? error.status : 500
  const message =
    error instanceof Error && error.message
      ? error.message
      : 'Error interno del servidor.'

  if (status >= 500) {
    console.error(error)
  }

  response.status(status).json({ message })
})

await createSchema()
await migrateLegacyPlacesIfNeeded()
await seedListingsIfEmpty()

app.listen(env.port, env.host, () => {
  console.log(`Backend listo en http://${env.host}:${env.port}`)
})

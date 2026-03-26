import crypto from 'node:crypto'
import { Pool } from 'pg'

const email = `${process.argv[2] ?? ''}`.trim().toLowerCase()
const name = `${process.argv[3] ?? ''}`.trim() || 'Admin Gluten Free Map'
const databaseUrl = process.env.DATABASE_URL ?? ''

if (!databaseUrl) {
  throw new Error('DATABASE_URL es obligatorio.')
}

if (!email || !email.includes('@')) {
  throw new Error('Uso: node backend/scripts/create-admin.mjs admin@example.com "Nombre Admin"')
}

const pool = new Pool({
  connectionString: databaseUrl,
})

const now = new Date().toISOString()

try {
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
  `)

  const result = await pool.query(
    `
      INSERT INTO users (
        id,
        email,
        name,
        role,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, 'admin', $4, $4)
      ON CONFLICT (email)
      DO UPDATE SET
        name = EXCLUDED.name,
        role = 'admin',
        updated_at = EXCLUDED.updated_at
      RETURNING id, email, name, role
    `,
    [`user_${crypto.randomUUID()}`, email, name, now],
  )

  console.log(JSON.stringify(result.rows[0], null, 2))
} finally {
  await pool.end()
}

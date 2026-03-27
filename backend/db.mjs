function readSslModeFromConnectionString(databaseUrl) {
  try {
    const url = new URL(databaseUrl)
    return `${url.searchParams.get('sslmode') ?? ''}`.trim().toLowerCase()
  } catch {
    return ''
  }
}

export function buildPoolConfig(databaseUrl) {
  const sslMode =
    readSslModeFromConnectionString(databaseUrl) ||
    `${process.env.DATABASE_SSL ?? process.env.PGSSLMODE ?? ''}`.trim().toLowerCase()

  const requiresTls = ['require', 'verify-ca', 'verify-full'].includes(sslMode)

  return {
    connectionString: databaseUrl,
    ...(requiresTls
      ? {
          ssl: {
            rejectUnauthorized: false,
          },
        }
      : {}),
  }
}

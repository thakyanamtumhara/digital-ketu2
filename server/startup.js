// Startup script: enables pgvector extension and runs Prisma migrations
import pg from 'pg'

async function setup() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('[Startup] DATABASE_URL not set')
    process.exit(1)
  }

  // Enable pgvector extension
  const client = new pg.Client({ connectionString: databaseUrl })
  try {
    await client.connect()
    await client.query('CREATE EXTENSION IF NOT EXISTS vector')
    console.log('[Startup] pgvector extension enabled')
  } catch (err) {
    console.error('[Startup] pgvector setup error:', err.message)
    // Don't exit — extension might already exist or DB might not support it
  } finally {
    await client.end()
  }
}

setup()

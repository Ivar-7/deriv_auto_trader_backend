import { config as loadDotenv } from 'dotenv'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PoolClient } from 'pg'
import { createDatabasePool } from '../src/config/database'
import { loadAppConfig } from '../src/config/env'

const migrationFilePattern = /^\d{3}_[a-z0-9_]+\.sql$/

async function applyMigrations(
  client: PoolClient,
  migrationDirectory: string
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  const migrationFiles = (await readdir(migrationDirectory))
    .filter((file) => migrationFilePattern.test(file))
    .sort()

  for (const migrationFile of migrationFiles) {
    const migrationId = migrationFile.replace(/\.sql$/, '')
    const applied = await client.query<{ id: string }>(
      'SELECT id FROM schema_migrations WHERE id = $1',
      [migrationId]
    )

    if (applied.rowCount !== 0) {
      continue
    }

    const sql = await readFile(join(migrationDirectory, migrationFile), 'utf8')
    await client.query(sql)
    await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [
      migrationId
    ])
  }
}

async function main(): Promise<void> {
  loadDotenv({ quiet: true })
  const appConfig = loadAppConfig(process.env)
  const pool = createDatabasePool(appConfig)
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    await applyMigrations(client, join(process.cwd(), 'migrations'))
    await client.query('COMMIT')
  } catch (error: unknown) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

void main().catch((error: unknown) => {
  console.error('Database migration failed.', error)
  process.exitCode = 1
})

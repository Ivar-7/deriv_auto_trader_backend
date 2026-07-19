import { Pool, PoolConfig } from 'pg'
import { AppConfig } from './env'

export function resolveDatabaseSslOptions(
  nodeEnv: AppConfig['nodeEnv']
): PoolConfig['ssl'] {
  if (nodeEnv !== 'production') {
    return undefined
  }

  // DigitalOcean App Platform's attached development database uses TLS with a
  // private certificate. The connection remains encrypted inside the trusted
  // App Platform network, but public certificate-chain verification is not
  // available for that database tier.
  return { rejectUnauthorized: false }
}

export function createDatabasePool(config: AppConfig): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    ssl: resolveDatabaseSslOptions(config.nodeEnv)
  })
}

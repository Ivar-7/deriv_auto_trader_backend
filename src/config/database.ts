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

export function resolveDatabaseConnectionString(config: AppConfig): string {
  if (config.nodeEnv !== 'production') {
    return config.databaseUrl
  }

  const databaseUrl = new URL(config.databaseUrl)

  // pg lets ssl options encoded in a connection URL override the `ssl` object
  // passed to Pool. Remove DigitalOcean's sslmode=require before supplying the
  // trusted-network TLS configuration above.
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) {
    databaseUrl.searchParams.delete(key)
  }

  return databaseUrl.toString()
}

export function createDatabasePool(config: AppConfig): Pool {
  return new Pool({
    connectionString: resolveDatabaseConnectionString(config),
    ssl: resolveDatabaseSslOptions(config.nodeEnv)
  })
}

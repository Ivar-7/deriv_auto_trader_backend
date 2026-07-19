import Fastify from 'fastify'
import app from './app'

function resolvePort(portValue: string | undefined): number {
  const port = Number(portValue ?? '3000')

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be a valid TCP port number.')
  }

  return port
}

async function startServer(): Promise<void> {
  const server = Fastify({ logger: true })
  await server.register(app)

  const closeServer = async (signal: string): Promise<void> => {
    server.log.info({ signal }, 'Stopping HTTP server')
    await server.close()
  }

  process.once('SIGINT', () => void closeServer('SIGINT'))
  process.once('SIGTERM', () => void closeServer('SIGTERM'))

  await server.listen({
    host: '0.0.0.0',
    port: resolvePort(process.env.PORT)
  })
}

void startServer().catch((error: unknown) => {
  process.stderr.write(`Unable to start the HTTP server: ${String(error)}\n`)
  process.exitCode = 1
})

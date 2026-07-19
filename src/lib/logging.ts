import type { FastifyLoggerOptions } from 'fastify'

type SafeLoggerOptions = FastifyLoggerOptions &
  Readonly<{
    redact: Readonly<{
      paths: string[]
      censor: string
    }>
  }>

export function requestPathForLog(url: string): string {
  const queryStart = url.indexOf('?')
  return queryStart === -1 ? url : url.slice(0, queryStart)
}

export const loggerOptions: SafeLoggerOptions = {
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers.set-cookie'
    ],
    censor: '[Redacted]'
  },
  serializers: {
    req(request) {
      return {
        method: request.method,
        url: requestPathForLog(request.url),
        host: request.host,
        remoteAddress: request.ip,
        remotePort: request.socket.remotePort
      }
    }
  }
}

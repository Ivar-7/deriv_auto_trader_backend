import fp from 'fastify-plugin'
import { AppError } from '../errors/app-error'

export default fp(async (fastify) => {
  fastify.setErrorHandler((error, request, reply) => {
    request.log.error(error)

    const appError = error instanceof AppError ? error : null
    const statusCode = appError?.statusCode ?? 500
    const code = appError?.code ?? 'INTERNAL_ERROR'
    const message = appError?.message ?? 'An unexpected error occurred.'

    void reply.status(statusCode).send({
      error: {
        code,
        message,
        requestId: request.id
      }
    })
  })
})

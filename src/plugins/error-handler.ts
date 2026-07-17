import fp from 'fastify-plugin'
import { AppError } from '../errors/app-error'

export default fp(async (fastify) => {
  fastify.setErrorHandler((error, request, reply) => {
    request.log.error(error)

    const appError = error instanceof AppError ? error : null
    const validationError = isValidationError(error)
    const statusCode = appError?.statusCode ?? (validationError ? 400 : 500)
    const code =
      appError?.code ??
      (validationError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR')
    const message =
      appError?.message ??
      (validationError
        ? 'The request is invalid.'
        : 'An unexpected error occurred.')

    void reply.status(statusCode).send({
      error: {
        code,
        message,
        requestId: request.id
      }
    })
  })
})

function isValidationError(
  error: unknown
): error is { readonly validation: unknown } {
  return typeof error === 'object' && error !== null && 'validation' in error
}

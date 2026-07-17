import { z } from 'zod'

const requiredDerivAppId = z
  .string()
  .trim()
  .min(1)
  .refine((value) => value !== 'YOUR_DERIV_APP_ID', {
    message: 'must be an assigned Deriv App ID'
  })

const appConfigSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().url(),
  DERIV_APP_ID: requiredDerivAppId,
  DERIV_OAUTH_REDIRECT_URI: z.string().url()
})

export type AppConfig = Readonly<{
  nodeEnv: 'development' | 'test' | 'production'
  host: string
  port: number
  corsOrigin: string
  databaseUrl: string
  derivAppId: string
  derivOauthRedirectUri: string
}>

export function loadAppConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const parsed = appConfigSchema.safeParse(environment)

  if (!parsed.success) {
    const invalidFields = parsed.error.issues
      .map((issue) => issue.path.join('.'))
      .filter((field, index, fields) => fields.indexOf(field) === index)
      .join(', ')

    throw new Error(`Invalid server environment: ${invalidFields}`)
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    corsOrigin: parsed.data.CORS_ORIGIN,
    databaseUrl: parsed.data.DATABASE_URL,
    derivAppId: parsed.data.DERIV_APP_ID,
    derivOauthRedirectUri: parsed.data.DERIV_OAUTH_REDIRECT_URI
  }
}

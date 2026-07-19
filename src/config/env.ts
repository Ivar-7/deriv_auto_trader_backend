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
  CORS_ORIGIN: z.union([z.literal('*'), z.string().url()]),
  FRONTEND_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().url(),
  DERIV_APP_ID: requiredDerivAppId,
  DERIV_OAUTH_REDIRECT_URI: z.string().url(),
  DERIV_AUTHORIZATION_URL: z
    .string()
    .url()
    .default('https://auth.deriv.com/oauth2/auth'),
  DERIV_TOKEN_URL: z
    .string()
    .url()
    .default('https://auth.deriv.com/oauth2/token'),
  DERIV_API_BASE_URL: z.string().url().default('https://api.derivws.com'),
  SESSION_COOKIE_SECRET: z.string().min(32)
})

export type AppConfig = Readonly<{
  nodeEnv: 'development' | 'test' | 'production'
  corsOrigin: string
  frontendOrigin: string
  databaseUrl: string
  derivAppId: string
  derivOauthRedirectUri: string
  derivAuthorizationUrl: string
  derivTokenUrl: string
  derivApiBaseUrl: string
  sessionCookieSecret: string
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
    corsOrigin: parsed.data.CORS_ORIGIN,
    frontendOrigin: parsed.data.FRONTEND_ORIGIN,
    databaseUrl: parsed.data.DATABASE_URL,
    derivAppId: parsed.data.DERIV_APP_ID,
    derivOauthRedirectUri: parsed.data.DERIV_OAUTH_REDIRECT_URI,
    derivAuthorizationUrl: parsed.data.DERIV_AUTHORIZATION_URL,
    derivTokenUrl: parsed.data.DERIV_TOKEN_URL,
    derivApiBaseUrl: parsed.data.DERIV_API_BASE_URL,
    sessionCookieSecret: parsed.data.SESSION_COOKIE_SECRET
  }
}

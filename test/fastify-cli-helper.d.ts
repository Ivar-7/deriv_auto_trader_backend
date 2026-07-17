declare module 'fastify-cli/helper.js' {
  import type { FastifyInstance } from 'fastify'

  export function build(
    args: readonly string[],
    additionalOptions: Readonly<Record<string, boolean>>
  ): Promise<FastifyInstance>
}

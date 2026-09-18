import { defineConfig } from 'drizzle-kit'

// `generate` works without a database — only `migrate` needs a connection, so
// a missing `DATABASE_URL` must not break migration generation.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
})

import { defineConfig } from 'drizzle-kit'

// `generate` працює без бази — з'єднання потрібне тільки `migrate`, тож
// відсутній `DATABASE_URL` не має ламати генерацію міграції.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
})

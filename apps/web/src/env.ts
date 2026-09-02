// Оточення збірки консолі.
//
// Vite підставляє ці значення у бандл під час збірки, тож секрету тут бути не
// може ніколи: `VITE_PRIVY_APP_ID` — публічний ідентифікатор застосунку, а не
// ключ. Секрети Privy читає тільки `apps/api` (`PRIVY_APP_SECRET`).
//
// Розбір лежить окремою чистою функцією, а не виконується при завантаженні
// модуля: інакше кожен тест, який просто торкнувся б цього файла, падав би на
// відсутньому оточенні. Оточення читає `main.tsx` — один раз, на старті, і далі
// віддає готове значення вниз як залежність (той самий підхід, що
// `createServer(deps)` в api).
import { z } from 'zod'

/** Те саме значення, що відхиляє `apps/api/src/config.ts`. */
const PLACEHOLDER = 'REPLACE_ME'

const filled = (label: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .refine((v) => !v.includes(PLACEHOLDER), `${label} is still the .env.example placeholder`)

export const webEnvSchema = z.object({
  /**
   * Базовий URL api. Кінцевий слеш зрізається тут, бо шляхи склеюються
   * рядками: `http://host/` + `/api/session` дало б `//api/session`, і CORS
   * відмовив би на походженні, яке візуально не відрізняється від дозволеного.
   */
  VITE_API_URL: filled('VITE_API_URL')
    // Протокол перевіряється явно: `z.url()` спирається на `new URL()`, а той
    // приймає `localhost:8787` як дійсний URL зі схемою `localhost:`. Бандл із
    // таким значенням зібрався б, і кожен запит падав би вже в браузері.
    .pipe(z.url({ protocol: /^https?$/ }))
    .transform((v) => v.replace(/\/+$/, '')),
  VITE_PRIVY_APP_ID: filled('VITE_PRIVY_APP_ID'),
})

export type WebEnv = z.infer<typeof webEnvSchema>

export class WebEnvError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`console is misconfigured:\n${problems.map((p) => `  · ${p}`).join('\n')}`)
    this.name = 'WebEnvError'
  }
}

/**
 * Читає оточення й називає **всі** проблеми одразу.
 *
 * Правити змінні по одній, перезбираючи бандл на кожну, — найдорожчий спосіб
 * дізнатись, що їх бракує двох.
 */
export function readWebEnv(source: unknown): WebEnv {
  const parsed = webEnvSchema.safeParse(source)
  if (parsed.success) return parsed.data

  throw new WebEnvError(
    parsed.error.issues.map((issue) => {
      const name = issue.path.join('.')
      return name === '' ? issue.message : `${name}: ${issue.message}`
    }),
  )
}

import { z } from 'zod'

/**
 * Скінченний перелік кодів помилки API. Формат — за `02-CODE-RULES`.
 *
 * Це **не** коди відмови в переказі: ті живуть у `refusal.ts`, приходять із
 * мережі й нічого не кажуть про здоров'я API. Відмова політики — це успішна
 * відповідь ручки симуляції й невдала транзакція, а не помилка запиту.
 */
export const ERROR_CODES = [
  'INVALID_INPUT',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'RATE_LIMITED',
  'INTERNAL',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export const errorCodeSchema = z.enum(ERROR_CODES)

export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})

export type ApiError = z.infer<typeof apiErrorSchema>

/**
 * Єдине місце, де код помилки перетворюється на HTTP-статус. Тримається тут,
 * а не в маршрутах, щоб дві ручки не відповідали різними статусами на те саме.
 */
export const HTTP_STATUS_BY_ERROR_CODE = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const satisfies Record<ErrorCode, number>

export type HttpStatus = (typeof HTTP_STATUS_BY_ERROR_CODE)[ErrorCode]

export function httpStatusFor(code: ErrorCode): HttpStatus {
  return HTTP_STATUS_BY_ERROR_CODE[code]
}

/**
 * Будує тіло помилки. Жоден маршрут не складає цей об'єкт руками.
 *
 * `details` не потрапляє в тіло, якщо його немає: `{ details: undefined }`
 * серіалізується в те саме, що й відсутнє поле, але порівнюється інакше — і
 * тест на точну форму відповіді ловив би різницю, якої клієнт не бачить.
 */
export function apiError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  return details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } }
}

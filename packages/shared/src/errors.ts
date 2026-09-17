import { z } from 'zod'

/**
 * Finite list of API error codes. Format follows `02-CODE-RULES`.
 *
 * These are **not** transfer refusal codes: those live in `refusal.ts`, come
 * from the network and say nothing about the health of the API. A policy
 * refusal is a successful response of the simulation handler and a failed
 * transaction, not a request error.
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
 * The single place where an error code becomes an HTTP status. Kept here
 * rather than in the routes so that two handlers cannot answer the same thing
 * with different statuses.
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
 * Builds the error body. No route assembles this object by hand.
 *
 * `details` is left out of the body when absent: `{ details: undefined }`
 * serialises to the same thing as a missing field but compares differently —
 * and a test on the exact shape of the response would catch a difference the
 * client never sees.
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

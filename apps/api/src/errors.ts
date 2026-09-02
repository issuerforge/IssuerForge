// Помилка як значення й один-єдиний перетворювач її на відповідь.
//
// Формат тіла й перелік кодів живуть у `@forge/shared/errors` — тут лише спосіб
// кинути помилку з маршруту й місце, де вона стає HTTP-відповіддю. Маршрути не
// складають тіло помилки руками й не обирають статус: інакше дві ручки
// відповідають різними статусами на те саме.
import { type ApiError, apiError, type ErrorCode, httpStatusFor } from '@forge/shared/errors'
import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { ZodError } from 'zod'
import type { AppEnv } from './env.ts'

export class ApiProblem extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiProblem'
  }

  toBody(): ApiError {
    return apiError(this.code, this.message, this.details)
  }
}

export const invalidInput = (message: string, details?: Record<string, unknown>) =>
  new ApiProblem('INVALID_INPUT', message, details)

/**
 * 401 покриває і «немає токена», і «токен є, але ця людина не в складі жодного
 * емітента». Окремого 403 у переліку кодів немає навмисно: різниця між ними
 * розповідає тому, хто підбирає токени, чи вгадав він щось — а користь від неї
 * має тільки він, бо консоль в обох випадках веде на екран входу.
 */
export const unauthorized = (message: string, details?: Record<string, unknown>) =>
  new ApiProblem('UNAUTHORIZED', message, details)

export const notFound = (message: string, details?: Record<string, unknown>) =>
  new ApiProblem('NOT_FOUND', message, details)

export const internal = (message: string, details?: Record<string, unknown>) =>
  new ApiProblem('INTERNAL', message, details)

function respond(c: Context<AppEnv>, problem: ApiProblem) {
  return c.json(problem.toBody(), httpStatusFor(problem.code))
}

/**
 * Єдиний вихід помилки назовні.
 *
 * Невідома помилка не потрапляє в тіло ніколи — назовні йде `requestId`, за
 * яким рядок лога знаходиться однозначно. Повідомлення виключення тут — це або
 * текст драйвера бази з рядком з'єднання, або стек, і обидва не мають бути в
 * відповіді, яку читає браузер емітента.
 */
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get('requestId')
  const log = c.get('log')

  if (err instanceof ApiProblem) {
    // 500 лишається подією рівня error навіть коли її кинули свідомо.
    log[err.code === 'INTERNAL' ? 'error' : 'warn']({ code: err.code, err }, err.message)
    return respond(c, err)
  }

  if (err instanceof ZodError) {
    log.warn({ issues: err.issues }, 'request failed validation')
    return respond(
      c,
      invalidInput('request failed validation', {
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      }),
    )
  }

  // `HTTPException` кидає сам Hono (наприклад, на битому JSON у тілі).
  if (err instanceof HTTPException && err.status === 400) {
    log.warn({ err }, 'malformed request')
    return respond(c, invalidInput('malformed request body'))
  }

  log.error({ err }, 'unhandled error')
  return respond(c, internal('unexpected server error', { requestId }))
}

export const onNotFound: NotFoundHandler<AppEnv> = (c) =>
  respond(c, notFound(`no route for ${c.req.method} ${c.req.path}`))

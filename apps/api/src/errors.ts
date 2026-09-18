// The error as a value, and the one and only converter of it into a response.
//
// The body format and the list of codes live in `@forge/shared/errors` — here
// there is only the way to throw an error from a route and the place where it
// becomes an HTTP response. Routes neither assemble the error body by hand nor
// pick the status: otherwise two handlers answer the same thing with different
// statuses.
import { type ApiError, apiError, type ErrorCode, httpStatusFor } from '@forge/shared/errors'
import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { ZodError } from 'zod'
import type { AppEnv } from './env.ts'

export class ApiProblem extends Error {
  // The same as in `config.ts`: a parameter property does not survive the type
  // stripping Node runs this process with.
  readonly code: ErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiProblem'
    this.code = code
    this.details = details
  }

  toBody(): ApiError {
    return apiError(this.code, this.message, this.details)
  }
}

export const invalidInput = (message: string, details?: Record<string, unknown>) =>
  new ApiProblem('INVALID_INPUT', message, details)

/**
 * 401 covers both "no token" and "there is a token, but this person is not a
 * member of any issuer". There is deliberately no separate 403 in the list of
 * codes: the difference between them tells whoever is guessing tokens whether
 * they guessed something — and only they benefit from it, because the console
 * leads to the login screen in both cases.
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
 * The only way an error gets out.
 *
 * An unknown error never reaches the body — what goes out is the `requestId`,
 * by which the log line is found unambiguously. The exception message here is
 * either the database driver's text with the connection string in it, or a
 * stack, and neither belongs in a response the issuer's browser reads.
 */
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get('requestId')
  const log = c.get('log')

  if (err instanceof ApiProblem) {
    // A 500 stays an error-level event even when it was thrown deliberately.
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

  // `HTTPException` is thrown by Hono itself (for instance on malformed JSON in the body).
  if (err instanceof HTTPException && err.status === 400) {
    log.warn({ err }, 'malformed request')
    return respond(c, invalidInput('malformed request body'))
  }

  log.error({ err }, 'unhandled error')
  return respond(c, internal('unexpected server error', { requestId }))
}

export const onNotFound: NotFoundHandler<AppEnv> = (c) =>
  respond(c, notFound(`no route for ${c.req.method} ${c.req.path}`))

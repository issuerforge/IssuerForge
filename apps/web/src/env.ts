// The console build environment.
//
// Vite bakes these values into the bundle at build time, so there can never
// be a secret here: `VITE_PRIVY_APP_ID` is the app's public identifier, not a
// key. Privy secrets are read only by `apps/api` (`PRIVY_APP_SECRET`).
//
// Parsing is a separate pure function rather than running on module load:
// otherwise every test that merely touched this file would fail on a missing
// environment. `main.tsx` reads the environment — once, at start-up — and
// then passes the ready value down as a dependency (the same approach as
// `createServer(deps)` in the api).
import { z } from 'zod'

/** The same value that `apps/api/src/config.ts` rejects. */
const PLACEHOLDER = 'REPLACE_ME'

const filled = (label: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .refine((v) => !v.includes(PLACEHOLDER), `${label} is still the .env.example placeholder`)

export const webEnvSchema = z.object({
  /**
   * The api base URL. The trailing slash is stripped here because paths are
   * joined as strings: `http://host/` + `/api/session` would give
   * `//api/session`, and CORS would refuse an origin visually
   * indistinguishable from the allowed one.
   */
  VITE_API_URL: filled('VITE_API_URL')
    // The protocol is checked explicitly: `z.url()` relies on `new URL()`,
    // which accepts `localhost:8787` as a valid URL with the scheme
    // `localhost:`. A bundle with that value would build, and every request
    // would fail in the browser.
    .pipe(z.url({ protocol: /^https?$/ }))
    .transform((v) => v.replace(/\/+$/, '')),
  VITE_PRIVY_APP_ID: filled('VITE_PRIVY_APP_ID'),
  /**
   * The node the console **itself** sends signed transactions to.
   *
   * The variable is separate from the server's `DEVNET_RPC_URL`, and that is
   * not duplication: the api goes through a paid node with a key in the query
   * string, while the bundle is read by everyone who opens the page. The
   * public devnet node, which needs no key, goes here — so the only way to
   * "accidentally" publish the Helius key is to write it into this variable
   * by hand.
   */
  VITE_DEVNET_RPC_URL: filled('VITE_DEVNET_RPC_URL')
    .pipe(z.url({ protocol: /^https?$/ }))
    .transform((v) => v.replace(/\/+$/, '')),
})

export type WebEnv = z.infer<typeof webEnvSchema>

export class WebEnvError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`console is misconfigured:\n${problems.map((p) => `  · ${p}`).join('\n')}`)
    this.name = 'WebEnvError'
    this.problems = problems
  }
}

/**
 * Reads the environment and names **all** the problems at once.
 *
 * Fixing variables one at a time, rebuilding the bundle for each, is the
 * costliest way to learn that two are missing.
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

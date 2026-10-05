// Logging the demo into the api the way the console does, and waiting for the
// api's own indexer to learn the issuer. Shared by every scenario that reads
// through the api.
import type { PublicKey } from '@solana/web3.js'
import { type ApiClient, ApiRefused, createApiClient } from './api.ts'
import type { createContext } from './context.ts'
import { type LoginSession, startLogin } from './login.ts'

/** The environment variable without which the `--api` path does not start. */
export function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '' || value.includes('REPLACE_ME')) {
    throw new Error(`${name} is required for --api (read from .env via --env-file-if-exists)`)
  }
  return value
}

/**
 * How long the demo waits for the api to know the issuer it just created.
 *
 * The membership reaches the database through the indexer alone — the demo
 * writes none of it. The indexer runs inside the api (`RUN_WORKER`), reads
 * the confirmed `initialize_issuer` from the node and mirrors it; on devnet
 * that is a few seconds, with the backfill timer (30 s) as the slow path if
 * the socket dropped the notification. A minute is well past both.
 */
const MEMBERSHIP_TIMEOUT_MS = 60_000
const MEMBERSHIP_POLL_MS = 2_000

/**
 * Polls the session until the api answers with the issuer, i.e. until the
 * indexer has mirrored the membership. Any other refusal is a real one and
 * is thrown as it is.
 */
async function awaitMembership(api: ApiClient, issuerId: string): Promise<void> {
  const deadline = Date.now() + MEMBERSHIP_TIMEOUT_MS
  for (;;) {
    try {
      const session = await api.session()
      if (session.issuerId === issuerId) return
    } catch (error) {
      if (!(error instanceof ApiRefused && error.status === 401)) throw error
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the api did not learn about issuer ${issuerId} within ${MEMBERSHIP_TIMEOUT_MS / 1000} s — is it running with RUN_WORKER=true?`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, MEMBERSHIP_POLL_MS))
  }
}

/**
 * Everything needed for the demo to log into the api the same way the
 * console does.
 *
 * Two steps, and neither is a login bypass: the fixture answers the same
 * request Privy does, and the token is signed with the key whose public
 * half the api reads from the environment and verifies itself. The
 * membership itself is not written here at all — the api's own indexer
 * mirrors it from the chain, and the demo waits for that like any client
 * would.
 */
export async function openApiSession(
  context: ReturnType<typeof createContext>,
  issuerId: PublicKey,
  baseUrl: string,
): Promise<{ api: ApiClient; login: LoginSession; close: () => Promise<void> }> {
  const { keys } = context

  // The port is taken from the same address the api reads: two numbers would
  // diverge silently, and the api would call into the void.
  const fixtureUrl = new URL(required('PRIVY_API_URL'))

  const login = await startLogin(
    {
      signingKeyPem: required('LOGIN_SIGNING_KEY').replaceAll('\\n', '\n'),
      appId: required('PRIVY_APP_ID'),
      port: Number(fixtureUrl.port || '80'),
    },
    // Exactly the addresses in the membership: the fixture has no right to
    // "prove" more than Privy would.
    [
      keys.founder.publicKey.toBase58(),
      keys.officer.publicKey.toBase58(),
      keys.attestor.publicKey.toBase58(),
    ],
  )

  const api = createApiClient({
    baseUrl: baseUrl.replace(/\/+$/, ''),
    accessToken: login.accessToken,
    issuerId: issuerId.toBase58(),
  })
  const waited = Date.now()
  try {
    await awaitMembership(api, issuerId.toBase58())
  } catch (error) {
    // Nobody else holds the fixture yet: left open, it keeps the process
    // alive after the error and the port taken for the next run.
    await login.close()
    throw error
  }
  console.log(`mirror:  membership indexed after ${((Date.now() - waited) / 1000).toFixed(1)} s`)

  return {
    api,
    login,
    // The fixture holds the event loop: without this the process does not
    // exit even when all the numbers are already printed.
    close: async () => {
      await login.close()
    },
  }
}

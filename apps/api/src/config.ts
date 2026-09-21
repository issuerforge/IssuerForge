// The process config, validated with Zod at start-up.
//
// The rule of membership: this holds exactly what the api reads **today**.
// Variables needed by future tasks (`PLATFORM_TREASURY`, `OFFRAMP_BASE_URL`)
// arrive with their tasks. Otherwise the process would fail at start-up over
// a missing value nobody reads — and the team would learn to put anything in
// there just to get it running. `OPERATIONAL_SECRET_KEY` arrived with its own
// task (T022): the first delegated operation is signed with it; `RUN_WORKER`
// with the indexer (T031).
//
// There is deliberately no `PROGRAM_ID` here: the program address is taken
// **only** from the vendored IDL (`packages/chain`, decision T007). A second
// source of the address creates the state "IDL from one deploy, address from
// another", which nothing catches.
import { base58ByteLength } from '@forge/chain'
import { LOG_LEVELS, type LogLevel } from '@forge/shared/log'
import { z } from 'zod'

/**
 * `.env.example` gives every secret this value. Letting it through would mean
 * letting the process come up and fail on the very first request to Privy
 * with a signature error; better not to come up at all and say which variable
 * is missing.
 */
const PLACEHOLDER = 'REPLACE_ME'

// We look for an occurrence, not equality: in `.env.example` the placeholder
// also sits inside values (`?api-key=REPLACE_ME`, the body of a PEM key), and
// it is exactly such half-filled lines that survive to deployment.
const secret = (label: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .refine((v) => !v.includes(PLACEHOLDER), `${label} is still the .env.example placeholder`)

/**
 * The Privy token verification key — an ES256 public key in PEM SPKI format.
 *
 * In an environment variable a multi-line PEM usually travels with escaped
 * `\n` (hosting panels, docker `--env`), so the line breaks are restored here.
 * This is the only place where the key format is discussed at all: from here
 * on it is a ready PEM.
 */
const verificationKeySchema = secret('PRIVY_VERIFICATION_KEY')
  .transform((v) => v.replaceAll('\\n', '\n').trim())
  .refine(
    (v) => v.startsWith('-----BEGIN PUBLIC KEY-----') && v.endsWith('-----END PUBLIC KEY-----'),
    'expected a PEM public key (-----BEGIN PUBLIC KEY----- … -----END PUBLIC KEY-----)',
  )

/**
 * An address one can reach over the network.
 *
 * `z.url()` by itself accepts any scheme — `ftp:`, `file:` and even
 * `javascript:` pass as a "valid URL". For the console origin that would mean
 * a CORS header the browser matches against nothing, and for the RPC an
 * address nobody answers at; both fail far from the cause.
 */
const httpUrlSchema = z.url({ protocol: /^https?$/ })

/**
 * The origins allowed to read the api. Several — comma-separated.
 *
 * An empty string and stray whitespace are dropped here, not in CORS:
 * `origin: ['']` would yield a header the browser matches against nothing,
 * and an error without a cause.
 */
const originsSchema = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  )
  .pipe(z.array(httpUrlSchema).min(1, 'WEB_ORIGIN must list at least one origin'))

/** The length of an ed25519 secret key in bytes: 32 of seed + 32 of public key. */
const SECRET_KEY_BYTES = 64

/**
 * The platform's operational key — an ed25519 private key, base58 (FR-035).
 *
 * Parsed **at start-up**, not at the first thaw: otherwise the process would
 * come up with a string nobody checked, and the first delegated operation
 * would fail with an exception from the depths of the codec — at the moment
 * the issuer is already waiting for confirmation, and with no hint of what to
 * fix in the hosting panel.
 *
 * The length is checked separately from parsing: a 32-byte string is valid
 * base58 too, and that is exactly what a **public** address pasted here by
 * mistake looks like.
 */
const operationalKeySchema = secret('OPERATIONAL_SECRET_KEY').refine((value) => {
  const length = base58ByteLength(value)
  return length === SECRET_KEY_BYTES
}, `expected a base58 ed25519 secret key of ${SECRET_KEY_BYTES} bytes`)

/**
 * A flag that is a word, not a presence: `RUN_WORKER=false` must mean off.
 * A schema that only checked "is the variable set" would start the indexer
 * on the line someone wrote to turn it off.
 */
const flagSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true')

const databaseUrlSchema = secret('DATABASE_URL').refine(
  (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
  'expected a postgres:// connection string',
)

export const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  // `.prefault`, not `.default`: in Zod 4 `.default` returns the value
  // **without parsing**, so a config typed as `string[]` would silently get a
  // string — a mistake neither TypeScript nor the schema check sees.
  WEB_ORIGIN: originsSchema.prefault('http://localhost:5173'),
  DATABASE_URL: databaseUrlSchema,
  DEVNET_RPC_URL: secret('DEVNET_RPC_URL').pipe(httpUrlSchema),
  OPERATIONAL_SECRET_KEY: operationalKeySchema,
  PRIVY_APP_ID: secret('PRIVY_APP_ID'),
  PRIVY_APP_SECRET: secret('PRIVY_APP_SECRET'),
  PRIVY_VERIFICATION_KEY: verificationKeySchema,
  /** The base URL of the Privy REST API. The variable exists so that a host change is not a code change. */
  PRIVY_API_URL: httpUrlSchema.default('https://auth.privy.io'),
  /**
   * Whether the indexer runs inside this process. On the free Render
   * instance there is no second process to run it in (`render.yaml`);
   * locally it is a choice — `pnpm dev` runs the worker on its own.
   */
  RUN_WORKER: flagSchema,
})

export interface Config {
  port: number
  logLevel: LogLevel
  webOrigins: string[]
  databaseUrl: string
  rpcUrl: string
  /** base58; `operational.ts` builds the `Keypair` from it, and nobody else does. */
  operationalSecretKey: string
  privy: {
    appId: string
    appSecret: string
    verificationKey: string
    apiUrl: string
  }
  runWorker: boolean
}

export class ConfigError extends Error {
  // The field is declared explicitly rather than as a constructor parameter:
  // `node src/index.ts` strips types without transforming them, and a
  // parameter property is a syntax error there. The api process did not come
  // up at all because of this (found in T024).
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`invalid environment:\n${issues.map((i) => `  - ${i}`).join('\n')}`)
    this.name = 'ConfigError'
    this.issues = issues
  }
}

/**
 * The environment is read exactly here and exactly once. From here on the
 * code passes a `Config` around, so `process.env` is not a hidden input of
 * any function — and a test does not have to swap global state to check
 * behaviour.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env)
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    )
  }

  const e = parsed.data
  return {
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    webOrigins: e.WEB_ORIGIN,
    databaseUrl: e.DATABASE_URL,
    rpcUrl: e.DEVNET_RPC_URL,
    operationalSecretKey: e.OPERATIONAL_SECRET_KEY,
    privy: {
      appId: e.PRIVY_APP_ID,
      appSecret: e.PRIVY_APP_SECRET,
      verificationKey: e.PRIVY_VERIFICATION_KEY,
      apiUrl: e.PRIVY_API_URL.replace(/\/+$/, ''),
    },
    runWorker: e.RUN_WORKER,
  }
}

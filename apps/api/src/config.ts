// Конфіг процесу, валідований Zod на старті.
//
// Правило складу: тут лежить рівно те, що api читає **сьогодні**. Змінні,
// потрібні майбутнім задачам (`PLATFORM_TREASURY`, `OFFRAMP_BASE_URL`),
// приходять зі своїми задачами. Інакше процес падав би на старті через
// відсутнє значення, якого ніхто не читає, — і команда навчилась би ставити
// туди що завгодно, аби запуститись. `OPERATIONAL_SECRET_KEY` прийшов зі своєю
// (T022): з нього підписується перша делегована операція.
//
// `PROGRAM_ID` тут немає навмисно: адреса програми береться **тільки** з
// вендорованого IDL (`packages/chain`, рішення T007). Друге джерело адреси
// створює стан «IDL з одного деплою, адреса з іншого», який нічим не ловиться.
import { base58ByteLength } from '@forge/chain'
import { LOG_LEVELS, type LogLevel } from '@forge/shared/log'
import { z } from 'zod'

/**
 * `.env.example` роздає всім секретам це значення. Пропустити його — значить
 * дати процесу піднятись і впасти на першому ж запиті до Privy з помилкою про
 * підпис; краще не піднятись узагалі й сказати, якої змінної бракує.
 */
const PLACEHOLDER = 'REPLACE_ME'

// Шукаємо входження, а не рівність: у `.env.example` плейсхолдер стоїть і
// всередині значень (`?api-key=REPLACE_ME`, тіло PEM-ключа), і саме такі
// напівзаповнені рядки доживають до розгортання.
const secret = (label: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .refine((v) => !v.includes(PLACEHOLDER), `${label} is still the .env.example placeholder`)

/**
 * Ключ перевірки токенів Privy — публічний ключ ES256 у форматі PEM SPKI.
 *
 * У змінній оточення багаторядковий PEM зазвичай їде з екранованими `\n`
 * (Railway, Vercel, docker `--env`), тож перенос відновлюється тут. Це єдине
 * місце, де формат ключа взагалі обговорюється: далі йде готовий PEM.
 */
const verificationKeySchema = secret('PRIVY_VERIFICATION_KEY')
  .transform((v) => v.replaceAll('\\n', '\n').trim())
  .refine(
    (v) => v.startsWith('-----BEGIN PUBLIC KEY-----') && v.endsWith('-----END PUBLIC KEY-----'),
    'expected a PEM public key (-----BEGIN PUBLIC KEY----- … -----END PUBLIC KEY-----)',
  )

/**
 * Адреса, якою можна ходити мережею.
 *
 * `z.url()` сама по собі приймає будь-яку схему — `ftp:`, `file:` і навіть
 * `javascript:` проходять як «дійсний URL». Для походження консолі це означало б
 * заголовок CORS, який браузер не звірить ні з чим, а для RPC — адресу, за якою
 * ніхто не відповість; і те, й те падає далеко від причини.
 */
const httpUrlSchema = z.url({ protocol: /^https?$/ })

/**
 * Походження, яким дозволено читати api. Кілька — через кому.
 *
 * Порожній рядок і зайві пробіли відкидаються тут, а не в CORS: `origin: ['']`
 * дав би заголовок, який браузер не звірить ні з чим, і помилку без причини.
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

/** Довжина секретного ключа ed25519 у байтах: 32 насіння + 32 публічних. */
const SECRET_KEY_BYTES = 64

/**
 * Операційний ключ платформи — приватний ключ ed25519, base58 (FR-035).
 *
 * Розбирається **на старті**, а не при першому розморожуванні: інакше процес
 * піднявся б із рядком, який ніхто не перевіряв, і перша делегована операція
 * впала б виключенням із надр кодека — у момент, коли емітент уже чекає на
 * підтвердження, і без жодної підказки, що виправляти в панелі хостингу.
 *
 * Довжина перевіряється окремо від розбору: 32-байтовий рядок теж є дійсним
 * base58, і саме так виглядає **публічна** адреса, вставлена сюди помилково.
 */
const operationalKeySchema = secret('OPERATIONAL_SECRET_KEY').refine((value) => {
  const length = base58ByteLength(value)
  return length === SECRET_KEY_BYTES
}, `expected a base58 ed25519 secret key of ${SECRET_KEY_BYTES} bytes`)

const databaseUrlSchema = secret('DATABASE_URL').refine(
  (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
  'expected a postgres:// connection string',
)

export const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  // `.prefault`, а не `.default`: у Zod 4 `.default` віддає значення **без
  // розбору**, тож типізований як `string[]` конфіг мовчки отримав би рядок —
  // помилка, якої не бачить ні TypeScript, ні перевірка схеми.
  WEB_ORIGIN: originsSchema.prefault('http://localhost:5173'),
  DATABASE_URL: databaseUrlSchema,
  DEVNET_RPC_URL: secret('DEVNET_RPC_URL').pipe(httpUrlSchema),
  OPERATIONAL_SECRET_KEY: operationalKeySchema,
  PRIVY_APP_ID: secret('PRIVY_APP_ID'),
  PRIVY_APP_SECRET: secret('PRIVY_APP_SECRET'),
  PRIVY_VERIFICATION_KEY: verificationKeySchema,
  /** Базовий URL REST-API Privy. Змінна існує, щоб зміна хоста не була правкою коду. */
  PRIVY_API_URL: httpUrlSchema.default('https://auth.privy.io'),
})

export interface Config {
  port: number
  logLevel: LogLevel
  webOrigins: string[]
  databaseUrl: string
  rpcUrl: string
  /** base58; `Keypair` із нього збирає `operational.ts`, і більше ніхто. */
  operationalSecretKey: string
  privy: {
    appId: string
    appSecret: string
    verificationKey: string
    apiUrl: string
  }
}

export class ConfigError extends Error {
  // Поле оголошене явно, а не параметром конструктора: `node src/index.ts`
  // зрізає типи, не перетворюючи їх, і параметр-властивість там — синтаксична
  // помилка. Процес api через це не піднімався взагалі (знайдено в T024).
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`invalid environment:\n${issues.map((i) => `  - ${i}`).join('\n')}`)
    this.name = 'ConfigError'
    this.issues = issues
  }
}

/**
 * Оточення читається рівно тут і рівно раз. Далі по коду ходить `Config`, тож
 * `process.env` не є прихованим входом жодної функції — і тест не мусить
 * підмінювати глобальний стан, щоб перевірити поведінку.
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
  }
}

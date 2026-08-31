#!/usr/bin/env node
// Переносить IDL зі збірки Anchor у git.
//
// `target/` ігнорується, а `apps/web` і `apps/api` збираються там, де ані WSL,
// ані `anchor build` не існує. Без вендорованої копії клієнт існує тільки на
// машині, де щойно зібрали програму.
//
// **Тип і значення беруться з одного тексту.** `target/types/issuer_forge.ts` —
// це `export type IssuerForge = { … }`, і його тіло вже є валідним JSON, тож
// той самий блок стає і типом, і значенням. Копія в camelCase, зроблена окремо,
// розходиться з цим типом: Anchor 0.32.1 у генераторі типів лишає
// `"path": "args.issuer_id"`, а `convertIdlToCamelCase` у рантаймі перетворює
// його на `args.issuerId`. На рантайм це не впливає — `Program` конвертує все,
// що йому дали, — але два джерела одного файлу дали б розбіжність на рівному
// місці.
//
//   node scripts/sync-idl.mjs          — перезаписати вендоровану копію
//   node scripts/sync-idl.mjs --check  — впасти, якщо копія розійшлася зі збіркою
//
// `--check` мовчки пропускає перевірку, коли `target/` немає: гейт має бути
// зеленим і на машині без WSL, і в деплої, де ончейн-збірки не буває взагалі.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const IDL_JSON = join(root, 'target', 'idl', 'issuer_forge.json')
const IDL_TYPES = join(root, 'target', 'types', 'issuer_forge.ts')
const OUT = join(root, 'packages', 'chain', 'src', 'idl', 'issuer-forge.ts')

const HEADER = `// ЗГЕНЕРОВАНО \`pnpm idl:sync\` з target/types. Руками не редагувати.
//
// Тип — те, що згенерував \`anchor build\`; значення — той самий текст під
// анотацією цього типу. Анотація не декоративна: вона і є перевіркою, що
// вендорована копія не розійшлася з програмою — зайве поле чи інше ім'я не
// скомпілюється.
//
// Імена всередині лишаються такими, як їх пише Anchor: \`Program\` проганяє
// переданий IDL через власну конверсію в camelCase, тож форма запису тут на
// рантайм не впливає.
`

const checkOnly = process.argv.includes('--check')

function fail(message) {
  process.stderr.write(`sync-idl: ${message}\n`)
  process.exit(1)
}

function generate() {
  const declaration = readFileSync(IDL_TYPES, 'utf8').replace(/\r\n/g, '\n')
  const opening = declaration.indexOf('export type IssuerForge = ')
  if (opening === -1) fail(`${relative(root, IDL_TYPES)} не оголошує тип IssuerForge`)

  const body = declaration.slice(opening + 'export type IssuerForge = '.length).trim().replace(/;$/, '')

  let parsed
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    fail(`тіло типу не є JSON — Anchor змінив формат генерації: ${error.message}`)
  }

  // Два файли з однієї збірки. Розбіжність означає, що `target/` зібраний
  // наполовину, і вендорувати з нього не можна нічого.
  const raw = JSON.parse(readFileSync(IDL_JSON, 'utf8'))
  if (parsed.address !== raw.address || parsed.instructions.length !== raw.instructions.length) {
    fail('target/idl і target/types розійшлися — перезібрати програму')
  }

  return `${HEADER}\nexport type IssuerForge = ${body}\n\nexport const IDL: IssuerForge = ${body}\n`
}

if (!existsSync(IDL_JSON) || !existsSync(IDL_TYPES)) {
  if (checkOnly) {
    process.stdout.write('sync-idl: target/ немає — звіряти нема з чим, пропускаю\n')
    process.exit(0)
  }
  fail(`немає ${relative(root, IDL_JSON)} — спершу зібрати програму (scripts/wsl-build.sh)`)
}

const generated = generate()

if (checkOnly) {
  if (!existsSync(OUT)) fail(`немає ${relative(root, OUT)} — запустити \`pnpm idl:sync\``)
  const current = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n')
  if (current !== generated) {
    fail(`${relative(root, OUT)} розійшовся зі збіркою — запустити \`pnpm idl:sync\``)
  }
  process.stdout.write('sync-idl: вендорований IDL збігається зі збіркою\n')
  process.exit(0)
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, generated, 'utf8')
process.stdout.write(`sync-idl: записано ${relative(root, OUT)}\n`)

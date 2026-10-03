// verify-journal — checks an exported IssuerForge journal against the chain.
//
//   node src/main.ts <journal.ndjson | -> --rpc <url> [--program <id>] [--json]
//
// It reads the file and asks a Solana RPC endpoint; it never talks to the
// IssuerForge api (SC-006). Exit code 0 when every line is confirmed and
// nothing in the window is missing, 1 when not, 2 when it could not run.
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { PROGRAM_ID } from '@forge/chain'
import { Connection, type FetchFn } from '@solana/web3.js'
import { patientFetch, rpcChain } from './chain.ts'
import { formatReport } from './report.ts'
import { verifyJournal } from './verify.ts'

const USAGE =
  'usage: verify-journal <journal.ndjson | -> --rpc <url> [--program <id>] [--json]\n' +
  '  --rpc defaults to $DEVNET_RPC_URL; --program to the address in the vendored IDL'

async function readInput(path: string): Promise<string> {
  if (path !== '-') return readFile(path, 'utf8')
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Host only: an RPC URL carries its API key in the query or the path. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '(unparseable url)'
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      rpc: { type: 'string' },
      program: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  const path = positionals[0]
  const rpc = values.rpc ?? process.env.DEVNET_RPC_URL
  if (values.help || path === undefined || rpc === undefined) {
    process.stderr.write(`${USAGE}\n`)
    return values.help ? 0 : 2
  }

  const programId = values.program ?? PROGRAM_ID.toBase58()
  const connection = new Connection(rpc, {
    commitment: 'finalized',
    // Our own retry instead: see `patientFetch`.
    disableRetryOnRateLimit: true,
    // `FetchFn` is typed after node-fetch; at run time it is the global fetch.
    fetch: patientFetch() as unknown as FetchFn,
  })
  const chain = rpcChain(connection, programId)
  const report = await verifyJournal({
    text: await readInput(path),
    chain,
    programId,
    concurrency: 2,
  })

  process.stdout.write(
    values.json
      ? `${JSON.stringify({ ...report, rpc: hostOf(rpc) }, null, 2)}\n`
      : formatReport(report, hostOf(rpc)),
  )
  return report.passed ? 0 : 1
}

// `process.exit` after RPC traffic trips a libuv assertion on Windows under
// Node 26; setting the code lets the loop drain instead.
process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`verify-journal: ${error instanceof Error ? error.message : error}\n`)
  return 2
})

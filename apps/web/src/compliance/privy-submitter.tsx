// The real submitter: the officer's Privy wallet signs, the browser sends.
//
// The same path as the issuance wizard (`wizard/useIssue.ts`): the api holds
// no issuer key and has no relay route, so the signed bytes go straight to
// the public node named in the console's own environment.
import { bytesFromBase64 } from '@forge/chain/plan'
import { useSignTransaction, useWallets } from '@privy-io/react-auth/solana'
import { Connection } from '@solana/web3.js'
import { type ReactNode, useMemo } from 'react'
import { useWebEnv } from '@/auth/providers'
import { waitForConfirmation } from '@/wizard/issuance'
import { ProvideSubmitter, type Submitter } from './submit'

export function PrivySubmitter({ children }: { children: ReactNode }) {
  const env = useWebEnv()
  const { wallets } = useWallets()
  const { signTransaction } = useSignTransaction()

  const submitter = useMemo<Submitter>(
    () => ({
      async submit(tx, onPhase) {
        // Every officer and quorum transaction has exactly one signer — the
        // wallet the api chose from this session. A second would mean the
        // route assembled something this screen does not know how to sign.
        const [address, ...others] = tx.signers
        if (address === undefined || others.length > 0) {
          throw new Error(`expected one signer, the api named ${tx.signers.length}`)
        }
        const wallet = wallets.find((candidate) => candidate.address === address)
        if (wallet === undefined) throw new Error(`this session has no wallet for ${address}`)

        onPhase('signing')
        const { signedTransaction } = await signTransaction({
          transaction: bytesFromBase64(tx.base64),
          wallet,
        })

        onPhase('sending')
        const connection = new Connection(env.VITE_DEVNET_RPC_URL, 'confirmed')
        const signature = await connection.sendRawTransaction(signedTransaction, {
          preflightCommitment: 'confirmed',
        })

        onPhase('confirming')
        await waitForConfirmation(connection, signature)
        return signature
      },
    }),
    [env.VITE_DEVNET_RPC_URL, signTransaction, wallets],
  )

  return <ProvideSubmitter value={submitter}>{children}</ProvideSubmitter>
}

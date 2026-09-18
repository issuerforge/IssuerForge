// Sign-in. One screen, one action.
//
// The text names the rule directly: the key to the console is the wallet
// address, not the login method (FR-034a). A person who logged in by email
// yesterday and with a wallet today must understand why the powers are the
// same — and why a different address does not grant them.
import { usePrivy } from '@privy-io/react-auth'

export default function SignIn() {
  const { login } = usePrivy()

  return (
    <div className="mx-auto max-w-[560px] px-5 py-24">
      <p className="smallcaps muted">IssuerForge</p>
      <h1 className="mt-3 text-[18px] font-medium">The issuer console</h1>

      <p className="mt-6 text-[13px] leading-relaxed">
        Sign in with your email or connect the wallet you already use. Either way you end up with a
        Solana address, and it is that address — not the account you signed in with — that an
        issuer’s roster names.
      </p>

      <p className="mt-8">
        <button type="button" className="btn-primary" onClick={() => login()}>
          Sign in
        </button>
      </p>

      <p className="muted mt-10 text-[12px] leading-relaxed">
        Signing in opens screens. It authorises nothing on chain: issuance, seizure, pause and any
        change to a policy need a quorum of issuer wallets, and the program checks that itself.
      </p>
    </div>
  )
}

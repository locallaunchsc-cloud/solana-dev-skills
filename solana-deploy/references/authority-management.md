# Upgrade Authority Management

A Solana program's upgrade authority is the only key that can replace its bytecode. Mismanaging it is the most common cause of catastrophic, unrecoverable failure on mainnet. This guide covers the three states a program can be in, when to move between them, and what to do if something goes wrong.

## The three authority states

| State | Who can upgrade | When to use |
|---|---|---|
| **Single-key authority** | One keypair (often the deployer) | Day 0–7 of a fresh deploy. You will be pushing fixes constantly. A hot single key is fine *only* while value-at-risk is low. |
| **Multisig authority** (Squads, etc.) | M-of-N signers via on-chain program | Default state for any program holding user funds, or any program with a token, oracle, or governance role. |
| **Immutable / final** | Nobody. Ever. | Programs whose behavior must be guaranteed in perpetuity — e.g. a token-launcher whose logic must never change for users to trust freshly-launched tokens. |

## When to transfer to a multisig

Move to a Squads (or equivalent) multisig **before any of these is true**:

- The program holds, or will hold, >$10K equivalent of user funds.
- More than one person has access to the deployer key (shared 1Password, etc.).
- The program is referenced by other on-chain integrations you don't control.
- You're about to step away from the keyboard for >24 hours (vacation, sleep cycle in a different timezone from your cofounder, etc.).
- Audit is in progress or completed — auditors will flag single-key authority as a critical finding.

Reasonable defaults:
- **2-of-3 Squads** for solo founders + two trusted advisors.
- **3-of-5 Squads** for funded teams.
- **4-of-7 Squads** for protocols at scale.

Avoid 1-of-N (defeats the point) and N-of-N (one lost key = bricked program).

### How to transfer

```bash
# 1. Create a Squads vault at https://app.squads.so (or use the CLI)
#    and copy the vault PDA address.

# 2. Transfer authority. The flag below is required because the vault PDA
#    has no private key and therefore can't sign the transfer.
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <SQUADS_VAULT_PDA> \
  --skip-new-upgrade-authority-signer-check

# 3. Verify.
solana program show <PROGRAM_ID>
# → "Authority: <SQUADS_VAULT_PDA>"
```

Future upgrades now go through a Squads proposal:
1. Run `solana program write-buffer ...` from any team member, setting the buffer authority to the Squads vault PDA (`--buffer-authority <VAULT_PDA>`).
2. In the Squads UI, create a "Program Upgrade" transaction pointing at the buffer.
3. Collect signatures, execute.

## When to make immutable (`--final`)

Setting `--final` revokes the authority forever. There is no undo, no recovery, no governance vote that can bring it back. Treat the decision the way you'd treat burning private keys to a wallet.

Good reasons to set `--final`:

- **Bytecode-as-trust products.** A token launcher, a fixed-rule AMM curve, a vesting contract — anything where users only deposit because they know the code won't change.
- **Post-deprecation cleanup.** You're sunsetting a program and want to guarantee no one can rug existing users.
- **End-state of a multi-year audit + governance roadmap.** Often years after launch, not at it.

Bad reasons to set `--final` (real examples from mainnet):

- "I want to look serious for our launch."
- "Audit recommended immutability." (Audits rarely recommend *immediate* immutability; they recommend a path to it.)
- "I lost the upgrade authority anyway, might as well make it official." (You don't have to — see the next section.)

```bash
# When you're absolutely sure:
solana program set-upgrade-authority <PROGRAM_ID> --final
```

## Why lost authority is unrecoverable

The BPF Upgradeable Loader enforces a hard invariant: the only key that can replace a program's bytecode is the one stored in its `ProgramData` account's `upgrade_authority_address` field. There is no recovery oracle, no time-locked override, no Solana-foundation backdoor. If the key is gone, the bytecode is frozen at its current version permanently — exactly as if `--final` had been set.

Concrete failure modes seen in the wild:

1. **Deleted keypair file with no backup.** Laptop reformatted, `target/deploy/*-keypair.json` gone. Without the seed phrase or a copy, the program is effectively immutable.
2. **`--final` set on the wrong cluster.** Devnet `--final` is harmless (testing). Mainnet `--final` set "to test the command" cannot be undone.
3. **Transferred to a typo'd address.** `set-upgrade-authority` to a pubkey no one controls (often a vanity address with an off-by-one character). Recoverable only if someone happens to control that pubkey.
4. **Transferred to a Squads vault that was later deleted from the UI.** The on-chain multisig PDA still exists, but if no one remembers the threshold/members config you can't form a quorum. (Squads stores config on-chain, so this is recoverable in principle — but only if you can identify the multisig.)
5. **Hardware wallet lost without seed backup.** Same as case 1, with extra steps.

## Recovery checklist when something goes wrong

Before declaring authority lost, verify in this order:

```bash
# 1. What does the chain actually say?
solana program show <PROGRAM_ID>
# Read the "Authority" line carefully. Compare character-by-character to keys you have.

# 2. Do you control the current authority?
solana address -k <suspected-authority-keypair.json>
# Compare to the Authority line above.

# 3. If it's a multisig PDA, can you reach it?
#    Look up the PDA in the Squads explorer or via their SDK.
#    If you find the multisig but lack signers, contact the listed members.

# 4. Check ALL machines + 1Password vaults + paper backups for the keypair.
#    File extensions: .json, .key, no extension. Look for 64-byte base58 strings.

# 5. As a last resort: announce. Some lost authorities have been found by
#    contributors who'd archived test keys. Worth asking before declaring frozen.
```

If after all of that the authority is genuinely gone, the only forward path is:

1. Deploy a **new** program at a new address.
2. Coordinate users + integrators to migrate.
3. Treat the old program as immutable and document its state.

This is expensive in trust and time. Spend ten minutes setting up Squads correctly the first time.

## Quick reference

```bash
# Show current authority
solana program show <PROGRAM_ID>

# Transfer to another single keypair
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority ./new-authority.json

# Transfer to a multisig PDA (no signature from PDA possible)
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <PDA> \
  --skip-new-upgrade-authority-signer-check

# Make permanently immutable — irreversible
solana program set-upgrade-authority <PROGRAM_ID> --final

# Inspect what authority a buffer is under (useful pre-deploy)
solana program show --buffers --buffer-authority $(solana address)
```

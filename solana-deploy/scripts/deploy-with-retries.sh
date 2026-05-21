#!/usr/bin/env bash
# deploy-with-retries.sh — Robust Solana program deploy via buffer, with retries
#                          and orphan-recovery instructions on failure.
#
# Pipeline:
#   1. Pre-flight: confirm cluster, balance, signer, file paths, mainnet gate.
#   2. Generate (or reuse) a NAMED buffer keypair so write-buffer is resumable.
#   3. Loop `solana program write-buffer` until it lands, bumping priority fee
#      on each outer-loop retry. write-buffer also retries chunks internally
#      via --max-sign-attempts.
#   4. `solana program deploy --buffer` to consume the buffer (one small tx).
#   5. On success: delete the local buffer keypair (rent already returned).
#   6. On failure at any step: print the buffer pubkey and recovery commands.
#      Do NOT close the buffer automatically — the user may want to resume.
#
# Usage (initial deploy):
#   ./scripts/deploy-with-retries.sh \
#       --so target/deploy/my_program.so \
#       --program-keypair target/deploy/my_program-keypair.json \
#       --upgrade-authority ~/.config/solana/deploy.json \
#       --cluster mainnet-beta \
#       --priority-fee 100000
#
# Usage (upgrade):
#   ./scripts/deploy-with-retries.sh \
#       --so target/deploy/my_program.so \
#       --program-id 7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2 \
#       --upgrade-authority ~/.config/solana/upgrade-authority.json \
#       --cluster mainnet-beta \
#       --priority-fee 100000
#
# Tested with: Solana CLI 3.0.10 (Agave). Also works on 2.1.x.

set -euo pipefail

# --- Defaults -----------------------------------------------------------------
SO_PATH=""
PROGRAM_KEYPAIR=""        # initial deploy: keypair file for the new program
PROGRAM_ID=""             # upgrade: pubkey of existing program
UPGRADE_AUTHORITY=""
CLUSTER="mainnet-beta"
PRIORITY_FEE="100000"     # micro-lamports per CU
MAX_OUTER_ATTEMPTS="3"    # whole-script retries; write-buffer also retries chunks internally
MAX_SIGN_ATTEMPTS="1000"  # per-chunk blockhash retries inside solana CLI
BUFFER_KEYPAIR="buffer.json"

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 1
}

# --- Arg parse ----------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --so)                 SO_PATH="$2"; shift 2 ;;
    --program-keypair)    PROGRAM_KEYPAIR="$2"; shift 2 ;;
    --program-id)         PROGRAM_ID="$2"; shift 2 ;;
    --upgrade-authority)  UPGRADE_AUTHORITY="$2"; shift 2 ;;
    --cluster)            CLUSTER="$2"; shift 2 ;;
    --priority-fee)       PRIORITY_FEE="$2"; shift 2 ;;
    --max-attempts)       MAX_OUTER_ATTEMPTS="$2"; shift 2 ;;
    --max-sign-attempts)  MAX_SIGN_ATTEMPTS="$2"; shift 2 ;;
    --buffer-keypair)     BUFFER_KEYPAIR="$2"; shift 2 ;;
    -h|--help)            usage ;;
    *) echo "Unknown arg: $1" >&2; usage ;;
  esac
done

# --- Validation ---------------------------------------------------------------
if [[ -z "$SO_PATH" || ! -f "$SO_PATH" ]]; then
  echo "ERROR: --so is required and the file must exist." >&2; exit 1
fi
if [[ -z "$PROGRAM_KEYPAIR" && -z "$PROGRAM_ID" ]]; then
  echo "ERROR: pass --program-keypair (initial deploy) OR --program-id (upgrade)." >&2; exit 1
fi
if [[ -n "$PROGRAM_KEYPAIR" && -n "$PROGRAM_ID" ]]; then
  echo "ERROR: pass --program-keypair OR --program-id, not both." >&2; exit 1
fi
if [[ -n "$PROGRAM_KEYPAIR" && ! -f "$PROGRAM_KEYPAIR" ]]; then
  echo "ERROR: --program-keypair file not found: $PROGRAM_KEYPAIR" >&2; exit 1
fi
if [[ -z "$UPGRADE_AUTHORITY" || ! -f "$UPGRADE_AUTHORITY" ]]; then
  echo "ERROR: --upgrade-authority is required and the keypair file must exist." >&2; exit 1
fi
if ! command -v solana >/dev/null 2>&1; then
  echo "ERROR: solana CLI not found. Install agave 2.x or 3.x." >&2; exit 1
fi

# --- Cluster + balance pre-flight --------------------------------------------
echo "==> Setting cluster to $CLUSTER"
solana config set --url "$CLUSTER" >/dev/null

ACTUAL_CLUSTER=$(solana config get | awk -F': ' '/RPC URL/ {print $2}')
SIGNER=$(solana address)
BALANCE_SOL=$(solana balance | awk '{print $1}')
SIZE=$(wc -c < "$SO_PATH" | tr -d ' ')

# Programs are stored at 2x size for upgrade headroom; ~6.96 lamports/byte/year * 2yr.
REQUIRED_LAMPORTS=$(( SIZE * 2 * 7 ))
REQUIRED_SOL=$(awk -v l="$REQUIRED_LAMPORTS" 'BEGIN{printf "%.4f", l/1000000000 + 0.5}')

echo "    RPC      : $ACTUAL_CLUSTER"
echo "    Signer   : $SIGNER"
echo "    Balance  : $BALANCE_SOL SOL"
echo "    Program  : $SO_PATH ($SIZE bytes)"
echo "    Required : ~$REQUIRED_SOL SOL (rent + 0.5 SOL fee slack)"

if awk -v b="$BALANCE_SOL" -v r="$REQUIRED_SOL" 'BEGIN{exit !(b < r)}'; then
  echo "ERROR: balance below required estimate. Top up before continuing." >&2
  exit 1
fi

# Refuse to silently deploy to the wrong cluster.
case "$ACTUAL_CLUSTER" in
  *mainnet*) ENV_NAME="mainnet" ;;
  *devnet*)  ENV_NAME="devnet" ;;
  *testnet*) ENV_NAME="testnet" ;;
  *localhost*|*127.0.0.1*) ENV_NAME="localhost" ;;
  *) ENV_NAME="unknown ($ACTUAL_CLUSTER)" ;;
esac

if [[ "$ENV_NAME" == "mainnet" && "${FORCE:-0}" != "1" ]]; then
  read -r -p "About to spend real SOL on MAINNET. Type 'deploy' to continue: " CONFIRM
  [[ "$CONFIRM" == "deploy" ]] || { echo "Aborted."; exit 1; }
else
  echo "==> Deploying to: $ENV_NAME"
fi

# --- Buffer keypair (named = resumable + recoverable) ------------------------
if [[ -f "$BUFFER_KEYPAIR" ]]; then
  echo "==> Reusing existing buffer keypair $BUFFER_KEYPAIR (resume mode)"
else
  echo "==> Generating new buffer keypair at $BUFFER_KEYPAIR"
  solana-keygen new --no-bip39-passphrase --silent -o "$BUFFER_KEYPAIR" --force
fi
BUFFER_PUBKEY=$(solana address -k "$BUFFER_KEYPAIR")
echo "    Buffer pubkey: $BUFFER_PUBKEY"
echo "    (Write this down. If this script dies, recover SOL with:"
echo "       solana program close $BUFFER_PUBKEY --bypass-warning )"

# --- write-buffer with outer retry loop --------------------------------------
attempt=1
write_ok=0
current_fee="$PRIORITY_FEE"
while [[ $attempt -le $MAX_OUTER_ATTEMPTS ]]; do
  echo ""
  echo "==> write-buffer attempt $attempt / $MAX_OUTER_ATTEMPTS  (priority fee: $current_fee)"
  if solana program write-buffer "$SO_PATH" \
        --buffer "$BUFFER_KEYPAIR" \
        --buffer-authority "$UPGRADE_AUTHORITY" \
        --with-compute-unit-price "$current_fee" \
        --max-sign-attempts "$MAX_SIGN_ATTEMPTS" \
        --use-rpc; then
    write_ok=1
    break
  fi

  echo "    write-buffer attempt $attempt failed."
  echo "    Doubling priority fee and retrying in 5s..."
  current_fee=$(( current_fee * 2 ))
  sleep 5
  attempt=$(( attempt + 1 ))
done

if [[ $write_ok -ne 1 ]]; then
  cat <<EOF >&2

ERROR: write-buffer failed after $MAX_OUTER_ATTEMPTS attempts.

Your buffer pubkey is $BUFFER_PUBKEY (keypair: $BUFFER_KEYPAIR).
It may hold a partial program write — SOL is locked in it until closed.

Options:
  1. Resume (cheapest): re-run this exact script. It picks up where it left off.
  2. Recover SOL:       solana program close $BUFFER_PUBKEY --bypass-warning
  3. List orphans:      solana program show --buffers --buffer-authority \\
                          \$(solana-keygen pubkey $UPGRADE_AUTHORITY)

EOF
  exit 1
fi

echo ""
echo "==> write-buffer succeeded. Buffer is ready: $BUFFER_PUBKEY"

# --- deploy from buffer ------------------------------------------------------
DEPLOY_ARGS=(
  --buffer "$BUFFER_PUBKEY"
  --upgrade-authority "$UPGRADE_AUTHORITY"
  --with-compute-unit-price "$current_fee"
  --max-sign-attempts "$MAX_SIGN_ATTEMPTS"
  --use-rpc
)

if [[ -n "$PROGRAM_KEYPAIR" ]]; then
  DEPLOY_ARGS+=(--program-id "$PROGRAM_KEYPAIR")
  echo "==> Initial deploy with program keypair $PROGRAM_KEYPAIR"
else
  DEPLOY_ARGS+=(--program-id "$PROGRAM_ID")
  echo "==> Upgrade deploy for program $PROGRAM_ID"
fi

if ! solana program deploy "${DEPLOY_ARGS[@]}"; then
  cat <<EOF >&2

ERROR: deploy --buffer failed.

The buffer $BUFFER_PUBKEY is still intact (you have NOT lost SOL yet).
Most likely causes + fixes:
  - Buffer authority != current signer. Fix:
      solana program set-buffer-authority $BUFFER_PUBKEY \\
        --new-buffer-authority $SIGNER
  - Wrong --upgrade-authority. Re-check the keypair path.
  - Program ID already in use by an incompatible program. Use the upgrade flow.

Once fixed, re-run the deploy step manually:
  solana program deploy ${DEPLOY_ARGS[*]}

Or recover the buffer SOL with:
  solana program close $BUFFER_PUBKEY --bypass-warning

EOF
  exit 1
fi

# --- Success cleanup ---------------------------------------------------------
echo ""
echo "==> Deploy succeeded. Buffer was consumed; no buffer cleanup needed."

# Buffer keypair no longer needed; remove so the next run starts fresh.
rm -f "$BUFFER_KEYPAIR"

# Resolve final program pubkey for the post-deploy summary.
if [[ -n "$PROGRAM_KEYPAIR" ]]; then
  FINAL_PROGRAM_ID=$(solana address -k "$PROGRAM_KEYPAIR")
else
  FINAL_PROGRAM_ID="$PROGRAM_ID"
fi

cat <<EOF

==============================================================
Deploy complete.
  Program ID : $FINAL_PROGRAM_ID
  Cluster    : $ACTUAL_CLUSTER
==============================================================

Verify on-chain hash matches your local verifiable build:
  solana-verify get-program-hash -u $CLUSTER $FINAL_PROGRAM_ID

Upload the IDL (Anchor programs):
  anchor idl init $FINAL_PROGRAM_ID --filepath target/idl/<lib>.json \\
    --provider.cluster $CLUSTER

Transfer upgrade authority to your Squads multisig (see SKILL.md Step 10):
  solana program set-upgrade-authority $FINAL_PROGRAM_ID \\
    --new-upgrade-authority <SQUADS_VAULT_PDA> \\
    --skip-new-upgrade-authority-signer-check

Submit for public verification (OtterSec):
  solana-verify verify-from-repo -u $CLUSTER \\
    --program-id $FINAL_PROGRAM_ID https://github.com/<owner>/<repo> \\
    --commit-hash \$(git rev-parse HEAD)
  solana-verify remote submit-job --program-id $FINAL_PROGRAM_ID \\
    --uploader $SIGNER
EOF

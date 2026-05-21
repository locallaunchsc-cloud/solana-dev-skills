#!/usr/bin/env bash
# verify-build.sh — Build a Solana program deterministically via solana-verify
#                   and print the executable hash for later on-chain comparison.
#
# Why this script exists:
#   `solana-verify build` runs the toolchain inside a pinned Docker container so
#   every byte of the resulting .so is reproducible across machines. The hash
#   printed at the end MUST match what `solana-verify get-program-hash` returns
#   after deploy and what OtterSec computes during remote verification.
#
# REQUIREMENTS:
#   - Docker installed AND running. solana-verify shells out to `docker run`
#     for a fully sandboxed Rust/SBF build. No Docker = no verifiable build.
#   - `cargo install solana-verify --locked --version 0.4.15`
#   - Run from the workspace root (where Anchor.toml or top-level Cargo.toml lives).
#   - `Cargo.lock` MUST be committed (it's required for deterministic dep resolution).
#
# Usage:
#   ./scripts/verify-build.sh                       # single-program workspace
#   ./scripts/verify-build.sh my_program            # multi-program: specify lib name
#   ./scripts/verify-build.sh my_program programs/x # also pass a non-default mount path
#
# Tested with: Solana CLI 3.0.10, solana-verify 0.4.15, Anchor 0.31.0.

set -euo pipefail

LIBRARY_NAME="${1:-}"
MOUNT_PATH="${2:-}"

# --- Pre-flight ---------------------------------------------------------------

if ! command -v solana-verify >/dev/null 2>&1; then
  echo "ERROR: solana-verify not found. Install with:" >&2
  echo "  cargo install solana-verify --locked --version 0.4.15" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found. solana-verify build runs in a container." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not running. Start Docker Desktop / dockerd and retry." >&2
  exit 1
fi

if [[ ! -f Cargo.lock ]]; then
  echo "ERROR: Cargo.lock not found in $(pwd)." >&2
  echo "       solana-verify requires Cargo.lock to be committed for deterministic builds." >&2
  echo "       Run 'cargo generate-lockfile' and commit the result." >&2
  exit 1
fi

# --- Build --------------------------------------------------------------------

echo "==> solana-verify build (first run pulls a Docker image; ~5-15 min)"

BUILD_ARGS=()
if [[ -n "$LIBRARY_NAME" ]]; then
  BUILD_ARGS+=(--library-name "$LIBRARY_NAME")
fi
if [[ -n "$MOUNT_PATH" ]]; then
  BUILD_ARGS+=(--mount-path "$MOUNT_PATH")
fi

solana-verify build "${BUILD_ARGS[@]}"

# --- Locate the produced .so --------------------------------------------------

if [[ -n "$LIBRARY_NAME" ]]; then
  SO_PATH="target/deploy/${LIBRARY_NAME}.so"
else
  SO_COUNT=$(find target/deploy -maxdepth 1 -name '*.so' 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$SO_COUNT" -ne 1 ]]; then
    echo "ERROR: Found $SO_COUNT .so files in target/deploy/." >&2
    echo "       Pass the library name explicitly: ./scripts/verify-build.sh <lib_name>" >&2
    exit 1
  fi
  SO_PATH=$(find target/deploy -maxdepth 1 -name '*.so' | head -n 1)
fi

if [[ ! -f "$SO_PATH" ]]; then
  echo "ERROR: Expected build output at $SO_PATH but it does not exist." >&2
  exit 1
fi

# --- Hash + report ------------------------------------------------------------

SIZE=$(wc -c < "$SO_PATH" | tr -d ' ')

# solana-verify exposes the canonical hash used for on-chain comparison.
# Fall back to sha256sum/shasum only if solana-verify is missing (it isn't here).
HASH=$(solana-verify get-executable-hash "$SO_PATH")

cat <<EOF

==============================================================
Verifiable build complete.
  Path : $SO_PATH
  Size : $SIZE bytes
  Hash : $HASH
==============================================================

Record this hash. After deploy, confirm the on-chain program matches:
  solana-verify get-program-hash -u mainnet-beta <PROGRAM_ID>

Then submit for public verification (also triggers the OtterSec checkmark):
  solana-verify verify-from-repo -u mainnet-beta \\
    --program-id <PROGRAM_ID> https://github.com/<owner>/<repo> \\
    --commit-hash \$(git rev-parse HEAD)
  solana-verify remote submit-job --program-id <PROGRAM_ID> \\
    --uploader \$(solana address)

WARNING: Do NOT run 'anchor build' or 'cargo build-sbf' after this point.
         The host toolchain will produce a different hash and break verification.
EOF

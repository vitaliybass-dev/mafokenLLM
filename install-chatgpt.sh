#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
umask 077
mkdir -p .siwc
commit=0a36fefeb913055c8c7a1a29b63d82b96b2e841a
if [[ ! -d .siwc/sdk/.git ]]; then
  git clone https://github.com/openai/sign-in-with-chatgpt-devkit.git .siwc/sdk
fi
(
  cd .siwc/sdk
  git checkout --detach "$commit"
  npm ci --workspace @siwc/local --include-workspace-root --ignore-scripts --no-audit --no-fund
  npm run build --workspace @siwc/local
)
if [[ ! -x .siwc/keychain-helper ]]; then
  swiftc keychain.swift -o .siwc/keychain-helper
fi

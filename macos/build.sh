#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
root="$(pwd)"
dest="${1:-$HOME/Applications/mafokenLLM.app}"
if [[ "$dest" != /* || "$dest" != *.app ]]; then
  echo 'Укажите абсолютный путь к файлу .app.'
  exit 2
fi
mkdir -p "$(dirname -- "$dest")"
stage="$(mktemp -d "$(dirname -- "$dest")/.localchat-build.XXXXXX")"
trap 'rm -rf -- "$stage"' EXIT
app="$stage/mafokenLLM.app"
runtime="$app/Contents/Resources/Runtime"
mkdir -p "$app/Contents/MacOS" "$runtime"
cp macos/Info.plist "$app/Contents/Info.plist"
cp server.py capabilities.py account_bridge.py provider_status.py chatgpt_bridge.mjs \
  index.html style.css app.js workspace.js accounts.js connections.js "$runtime/"
if [[ -f .siwc/sdk/packages/local/dist/index.js && -x .siwc/keychain-helper ]]; then
  mkdir -p "$runtime/.siwc/sdk/packages/local" "$runtime/.siwc/sdk/node_modules"
  cp -p .siwc/keychain-helper "$runtime/.siwc/"
  cp -R .siwc/sdk/packages/local/dist "$runtime/.siwc/sdk/packages/local/"
  cp .siwc/sdk/packages/local/package.json "$runtime/.siwc/sdk/packages/local/"
  for dep in openai jose proper-lockfile graceful-fs retry signal-exit undici; do
    cp -R ".siwc/sdk/node_modules/$dep" "$runtime/.siwc/sdk/node_modules/"
  done
fi
sdk="$(xcrun --sdk macosx --show-sdk-path)"
arch="$(uname -m)"
swiftc -O -sdk "$sdk" -target "$arch-apple-macosx14.0" \
  macos/Main.swift macos/Desktop.swift macos/DesktopTools.swift -o "$app/Contents/MacOS/LocalChat"
swiftc macos/Icon.swift -o "$stage/icon-generator"
"$stage/icon-generator" "$stage/LocalChat.iconset"
iconutil -c icns "$stage/LocalChat.iconset" -o "$app/Contents/Resources/LocalChat.icns"
codesign --force --sign - --identifier app.localchat.mac "$app"
codesign --verify --deep --strict "$app"
if [[ -e "$dest" ]]; then
  if [[ "$(defaults read "$dest/Contents/Info" CFBundleIdentifier 2>/dev/null)" != app.localchat.mac ]]; then
    echo "По этому пути уже установлено другое приложение."
    exit 1
  fi
  mv "$dest" "$stage/previous.app"
fi
if ! mv "$app" "$dest"; then
  if [[ -d "$stage/previous.app" ]]; then mv "$stage/previous.app" "$dest"; fi
  exit 1
fi
printf '%s\n' "$dest"

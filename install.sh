#!/usr/bin/env sh
# Installs the latest Claude Usage Bar release into VS Code.
set -eu

api="https://api.github.com/repos/IvanLazic2/claude-usage-bar/releases/latest"
url=$(curl -fsSL "$api" | grep -o '"browser_download_url": *"[^"]*\.vsix"' | head -n 1 | sed 's/.*"\(https[^"]*\)"$/\1/')

if [ -z "$url" ]; then
  echo "No .vsix found in the latest release." >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/claude-usage-bar.vsix" "$url"
code --install-extension "$tmp/claude-usage-bar.vsix" --force

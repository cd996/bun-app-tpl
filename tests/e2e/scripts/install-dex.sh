#!/usr/bin/env bash
# Install dex into tests/e2e/.cache/dex.
#
# Resolution order:
#   1. Reuse cached binary if present.
#   2. Extract the binary from the official OCI image at ghcr.io (no docker
#      daemon — anonymous pulls only need curl + python3 + tar). This is the
#      preferred path because dex stopped publishing standalone binary
#      releases after v2.0.1; ghcr.io is the canonical distribution.
#   3. Fall back to building from source if Go is available.
#
# Override the version with DEX_VERSION=vX.Y.Z.
set -euo pipefail

DEX_VERSION="${DEX_VERSION:-v2.41.1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$SCRIPT_DIR/../.cache"
BIN="$CACHE/dex"

if [ -x "$BIN" ]; then
  echo "[install-dex] $BIN already exists; skipping"
  exit 0
fi

mkdir -p "$CACHE"

extract_from_ghcr() {
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "[install-dex] unsupported arch $(uname -m) for ghcr extraction" >&2; return 1 ;;
  esac

  local registry="ghcr.io"
  local image="dexidp/dex"
  local tmp
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN

  echo "[install-dex] fetching ghcr token"
  local token
  token=$(curl -fsSL "https://${registry}/token?service=${registry}&scope=repository:${image}:pull" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

  local accept_hdrs=(
    -H "Accept: application/vnd.oci.image.index.v1+json"
    -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json"
    -H "Accept: application/vnd.docker.distribution.manifest.v2+json"
    -H "Accept: application/vnd.oci.image.manifest.v1+json"
  )

  echo "[install-dex] fetching index manifest for ${image}:${DEX_VERSION}"
  curl -fsSL -H "Authorization: Bearer ${token}" "${accept_hdrs[@]}" \
    "https://${registry}/v2/${image}/manifests/${DEX_VERSION}" -o "$tmp/index.json"

  local platform_digest
  platform_digest=$(python3 -c "
import json
d = json.load(open('$tmp/index.json'))
mans = d.get('manifests') or [d]
for m in mans:
    p = m.get('platform', {})
    if p.get('os') == 'linux' and p.get('architecture') == '$arch':
        print(m['digest']); break
")
  if [ -z "$platform_digest" ]; then
    echo "[install-dex] no linux/$arch manifest in index" >&2
    return 1
  fi

  echo "[install-dex] platform manifest: $platform_digest"
  curl -fsSL -H "Authorization: Bearer ${token}" "${accept_hdrs[@]}" \
    "https://${registry}/v2/${image}/manifests/${platform_digest}" -o "$tmp/manifest.json"

  # Iterate layers from largest to smallest — the dex binary lives in one
  # of the bigger layers. Each layer is a gzipped tarball; we look for any
  # entry whose basename is `dex`, copy it out, and stop on first hit.
  local layers
  layers=$(python3 -c "
import json
d = json.load(open('$tmp/manifest.json'))
ls = sorted(d['layers'], key=lambda l: -l.get('size', 0))
for l in ls:
    print(l['digest'])
")

  for digest in $layers; do
    echo "[install-dex] scanning layer $digest"
    curl -fsSL -H "Authorization: Bearer ${token}" \
      "https://${registry}/v2/${image}/blobs/${digest}" -o "$tmp/layer.tgz"
    if tar -tzf "$tmp/layer.tgz" 2>/dev/null | grep -E '(^|/)dex$' >/dev/null; then
      local entry
      entry=$(tar -tzf "$tmp/layer.tgz" | grep -E '(^|/)dex$' | head -n1)
      echo "[install-dex] found $entry — extracting"
      tar -xzf "$tmp/layer.tgz" -C "$tmp" "$entry"
      mv "$tmp/$entry" "$BIN"
      chmod +x "$BIN"
      echo "[install-dex] wrote $BIN ($(stat -c %s "$BIN") bytes) from ghcr"
      return 0
    fi
  done

  echo "[install-dex] dex binary not found in any layer" >&2
  return 1
}

build_from_source() {
  if ! command -v go >/dev/null 2>&1; then
    echo "[install-dex] go is not installed; cannot fall back to source build" >&2
    return 1
  fi
  local src="$CACHE/dex-src"
  if [ ! -d "$src" ]; then
    echo "[install-dex] cloning dex@${DEX_VERSION}"
    git clone --depth 1 -b "$DEX_VERSION" https://github.com/dexidp/dex.git "$src"
  fi
  echo "[install-dex] building dex from source (CGO required for sqlite3)"
  (cd "$src" && CGO_ENABLED=1 go build -ldflags="-s -w" -o "$BIN" ./cmd/dex)
  echo "[install-dex] built $BIN ($(stat -c %s "$BIN") bytes) from source"
}

if extract_from_ghcr; then
  exit 0
fi

echo "[install-dex] ghcr extraction failed; trying source build"
if build_from_source; then
  exit 0
fi

echo "[install-dex] all install paths failed; install Go or check network access to ghcr.io" >&2
exit 1

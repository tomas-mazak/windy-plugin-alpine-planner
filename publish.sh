#!/usr/bin/env bash
set -euo pipefail

# Publishes the built plugin to the Windy plugin gallery.
# Docs: https://docs.windy-plugins.com/
#
# Usage: ./publish.sh [--dry-run] [--skip-build] [--yes] [--allow-dirty]
#   --dry-run      package the archive but don't upload; leaves it for inspection
#   --skip-build   reuse the existing dist/ instead of rebuilding
#   --yes          skip the confirmation prompt
#   --allow-dirty  proceed even with uncommitted changes (the published
#                  commitSha wouldn't otherwise match what's actually in dist/)
#
# Configuration: set these as environment variables (as the release workflow
# does), or copy .env.example to .env (git-ignored, never commit it) and fill
# them in there; a variable set in the environment wins over .env:
#   WINDY_API_KEY             your Windy plugin API key -- never printed or logged
#   WINDY_PLUGIN_OWNER        your Windy username
#   WINDY_PLUGIN_REPOSITORY   URL of this plugin's public source repository

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"
UPLOAD_URL="https://node.windy.com/plugins/v1.0/upload"

DRY_RUN=0
SKIP_BUILD=0
ASSUME_YES=0
ALLOW_DIRTY=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --skip-build) SKIP_BUILD=1 ;;
        --yes | -y) ASSUME_YES=1 ;;
        --allow-dirty) ALLOW_DIRTY=1 ;;
        *)
            echo "Unknown flag: $arg (expected --dry-run, --skip-build, --yes, --allow-dirty)" >&2
            exit 1
            ;;
    esac
done

# --- Requirements ---

for cmd in jq curl tar git npm; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "$cmd is required but not installed." >&2
        exit 1
    fi
done

# --- Config: real environment variables, or .env (git-ignored) for the ones not set ---

if [ -f "$SCRIPT_DIR/.env" ]; then
    for var in WINDY_API_KEY WINDY_PLUGIN_OWNER WINDY_PLUGIN_REPOSITORY; do
        if [ -z "${!var:-}" ]; then
            # Read one variable from .env without echoing anything
            value="$(set -a && . "$SCRIPT_DIR/.env" && printf '%s' "${!var:-}")"
            export "$var=$value"
        fi
    done
    unset value
fi

: "${WINDY_API_KEY:?Set WINDY_API_KEY in the environment or in .env (copy .env.example)}"
: "${WINDY_PLUGIN_OWNER:?Set WINDY_PLUGIN_OWNER in the environment or in .env}"
: "${WINDY_PLUGIN_REPOSITORY:?Set WINDY_PLUGIN_REPOSITORY in the environment or in .env}"

# --- Git state: the published commitSha should match what's actually built ---

if [ -n "$(git -C "$SCRIPT_DIR" status --porcelain)" ] && [ "$ALLOW_DIRTY" -ne 1 ]; then
    echo "Working tree has uncommitted changes." >&2
    echo "The published commitSha wouldn't match what's actually in dist/. Commit first," >&2
    echo "or re-run with --allow-dirty if you really want to proceed anyway." >&2
    exit 1
fi
SHA="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD)"

# --- Build ---

if [ "$SKIP_BUILD" -ne 1 ]; then
    echo "==> Building..."
    (cd "$SCRIPT_DIR" && npm run build)
fi

if [ ! -f "$DIST_DIR/plugin.json" ]; then
    echo "Missing $DIST_DIR/plugin.json -- run a build first (drop --skip-build)." >&2
    exit 1
fi

for notice in LICENSE LICENSES/windy-plugin-template.txt LICENSES/svelte.txt; do
    if [ ! -s "$DIST_DIR/$notice" ]; then
        echo "Missing release licence notice: $notice. Rebuild without --skip-build." >&2
        exit 1
    fi
done

# --- Package into a scratch copy, so dist/ itself stays untouched ---

WORKDIR="$(mktemp -d)"
cleanup() { [ "$DRY_RUN" -eq 1 ] || rm -rf "$WORKDIR"; }
trap cleanup EXIT

cp -r "$DIST_DIR"/. "$WORKDIR/"
(
    cd "$WORKDIR"
    jq -n \
        --arg repositoryName "$WINDY_PLUGIN_REPOSITORY" \
        --arg commitSha "$SHA" \
        --arg repositoryOwner "$WINDY_PLUGIN_OWNER" \
        '{repositoryName: $repositoryName, commitSha: $commitSha, repositoryOwner: $repositoryOwner}' \
        >plugin-info.json
    jq -s '.[0] * .[1]' plugin.json plugin-info.json >plugin2.json
    mv plugin2.json plugin.json
    rm plugin-info.json
    # macOS: omit resource forks and provenance metadata; Linux tar ignores this environment variable.
    COPYFILE_DISABLE=1 tar --no-xattrs -cf plugin.tar --exclude='./plugin.tar' .
)

ARCHIVE="$WORKDIR/plugin.tar"
echo
echo "==> Ready to publish:"
echo "    owner:      $WINDY_PLUGIN_OWNER"
echo "    repository: $WINDY_PLUGIN_REPOSITORY"
echo "    commit:     $SHA"
echo "    archive:    $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
echo

if [ "$DRY_RUN" -eq 1 ]; then
    echo "--dry-run: not uploading. Archive left at $ARCHIVE for inspection."
    exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
    read -r -p "Publish this plugin to the Windy gallery now? [y/N] " reply
    case "$reply" in
        y | Y | yes | YES) ;;
        *)
            echo "Aborted."
            exit 1
            ;;
    esac
fi

echo "==> Uploading..."
RESPONSE_FILE="$WORKDIR/response.json"
set +e
HTTP_STATUS="$(curl -s -o "$RESPONSE_FILE" -w '%{http_code}' \
    -XPOST "$UPLOAD_URL" \
    -H "x-windy-api-key: ${WINDY_API_KEY}" \
    -F "plugin_archive=@${ARCHIVE}")"
CURL_EXIT=$?
set -e

if [ "$CURL_EXIT" -ne 0 ] || [ "$HTTP_STATUS" -ge 400 ]; then
    echo "Upload failed (curl exit $CURL_EXIT, HTTP $HTTP_STATUS):" >&2
    cat "$RESPONSE_FILE" >&2
    exit 1
fi

echo "Upload succeeded (HTTP $HTTP_STATUS):"
cat "$RESPONSE_FILE"
echo

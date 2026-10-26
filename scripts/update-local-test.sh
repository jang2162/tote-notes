#!/usr/bin/env bash
# The in-app update, end to end, against a server on this machine (docs/guides/development.md
# 「업데이트 흐름은 로컬 서버로 시험한다」):
#   bash scripts/update-local-test.sh <empty scratch folder>
# Builds two `perf` bundles of a test app of its own (com.develma.totenotes.updatetest) — version
# 0.0.1 named as 0.1.0 was (`tote-updatetest.app`) and the version in package.json named as the
# app is now (`Tote Notes Updatetest.app`) — signs the newer one's update bundle with a throwaway
# key, serves it with latest.json on http://127.0.0.1:$PORT under a name without spaces, as a
# release does, and prints how to launch the old one. Both are signed ad hoc with the hardened runtime, so the install and
# the restart run under the runtime a release has (its Developer ID signature aside). Nothing here
# touches the person's tote or the debug app: another identifier, another single-instance socket,
# and every launch printed here gets TOTE_DATA_DIR.
#
# Environment: PORT (default 18765).
set -euo pipefail

W=${1:?usage: bash scripts/update-local-test.sh <empty scratch folder>}
case "$W" in
  /*) ;;
  *) echo "the folder must be absolute: $W" >&2; exit 2 ;;
esac
if [ -d "$W" ] && [ -n "$(ls -A "$W")" ]; then
  echo "not an empty folder: $W" >&2
  exit 2
fi
PORT=${PORT:-18765}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")
BUNDLE="$ROOT/src-tauri/target/perf/bundle/macos"
# The bundle name of 0.1.0 and the one of now: an update keeps the installed bundle's name.
OLD_NAME=tote-updatetest
NAME="Tote Notes Updatetest"
# As the release workflow names the update bundle: GitHub would turn the spaces into dots.
SERVED="Tote-Notes-Updatetest_${VERSION}.app.tar.gz"

# A test app already running would take the launch below as a request and open nothing new. Never
# connect to the socket to check: a running app takes any connection as a `tote` request.
owners=$(lsof -U 2>/dev/null | awk '$NF ~ /^\/tmp\/com_develma_totenotes_updatetest.*_si\.sock$/ {print $2}' | sort -u)
if [ -n "$owners" ]; then
  echo "an update test app is running (pid $owners); quit it first" >&2
  exit 1
fi

mkdir -p "$W/serve" "$W/Applications" "$W/bin" "$W/data"
say() { printf '[update-test] %s\n' "$*" >&2; }

say "1. a throwaway update key"
pnpm --dir "$ROOT" -s tauri signer generate --ci -p update-test -w "$W/key" > /dev/null

say "2. the test config"
cat > "$W/update-test.conf.json" <<EOF
{
  "identifier": "com.develma.totenotes.updatetest",
  "bundle": { "macOS": { "signingIdentity": "-" } },
  "plugins": {
    "updater": {
      "pubkey": "$(cat "$W/key.pub")",
      "endpoints": ["http://127.0.0.1:$PORT/latest.json"],
      "dangerousInsecureTransportProtocol": true,
      "requireSignedVersion": true
    }
  }
}
EOF

build() {
  (cd "$ROOT" && pnpm -s tauri build --bundles app \
    --config src-tauri/tauri.dev.conf.json --config "$W/update-test.conf.json" "$@" \
    -- --profile perf)
}

say "3. the old version, 0.0.1, as $OLD_NAME.app"
build --config "{\"version\":\"0.0.1\",\"productName\":\"$OLD_NAME\"}"
ditto "$BUNDLE/$OLD_NAME.app" "$W/Applications/$OLD_NAME.app"

say "4. the new version, $VERSION, with its update bundle"
# The key reaches this one command only.
TAURI_SIGNING_PRIVATE_KEY="$(cat "$W/key")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=update-test \
  build --config "{\"productName\":\"$NAME\",\"bundle\":{\"createUpdaterArtifacts\":true}}"
cp "$BUNDLE/$NAME.app.tar.gz" "$W/serve/$SERVED"
cp "$BUNDLE/$NAME.app.tar.gz.sig" "$W/serve/$SERVED.sig"
node "$ROOT/scripts/verify-updater-sig.ts" "$W/serve/$SERVED" \
  "$W/serve/$SERVED.sig" --pubkey "$(cat "$W/key.pub")" --version "$VERSION"

say "5. latest.json"
node "$ROOT/scripts/updater-json.ts" --version "$VERSION" \
  --url "http://127.0.0.1:$PORT/$SERVED" --sig "$W/serve/$SERVED.sig" \
  --allow-local-http --out "$W/serve/latest.json"

say "6. the server"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$W/serve" 2> "$W/server.log" &
echo $! > "$W/server.pid"

say "7. the tote command of the old version"
ln -s "$W/Applications/$OLD_NAME.app/Contents/Resources/bin/tote" "$W/bin/tote"

cat <<EOF

Ready. The old version ($OLD_NAME 0.0.1) checks for updates 5 s after it opens:
  open --env TOTE_DATA_DIR="$W/data" --env TOTE_UPDATE_CHECK=1 "$W/Applications/$OLD_NAME.app"
The update installs into that bundle: it stays $OLD_NAME.app, with the new name in its menus.
Requests reach $W/server.log. The tote command of the installed app, while that app runs:
  $W/bin/tote <file>
With the app not running, the command starts it through "open -n", which drops TOTE_DATA_DIR:
it would use the debug data folders (~/.tote-dev). Start it as above first.
When done:
  kill \$(cat "$W/server.pid") && rm -rf "$W"
EOF

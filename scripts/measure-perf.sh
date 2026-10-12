#!/usr/bin/env bash
: "${TOTE_DATA_DIR:?TOTE_DATA_DIR must name an empty scratch folder: the measured app keeps all its data there}"
# The performance measurement of tests/measure/perf.md, by its pre-registered rules:
#   TOTE_DATA_DIR=$(mktemp -d) pnpm perf:measure <fixtures dir from pnpm perf:fixtures>
# Builds the `perf` bundle (release optimisation, tote's own debug assertions on so
# TOTE_BACKGROUND applies), runs every scenario five times with TOTE_PERF=1 and collects each
# run's perf.jsonl as tests/measure/results/perf-<scenario>-<run>.jsonl, then prints the table.
#
# Environment: PERF_SKIP_BUILD=1 reuses the bundle; PERF_ONLY="cold-start open-ts-10mb …" runs
# those scenarios only; PERF_SMOKE=1 opens code-1mb.ts once (not a scenario) and prints its marks,
# to check the pipeline before measuring; PERF_FOREGROUND=1 leaves TOTE_BACKGROUND out, so the
# windows come on screen — only with the person's consent. A background window never gets an
# animation frame, so the scenarios timed to one (opening a file: open-first-paint; the session
# restore: restore-done) can only be measured that way. A window does get frames for a moment
# after it opens, so PERF_BACKGROUND_RESTORE=1 runs the session restore in the background too —
# figures to be confirmed on screen.
set -euo pipefail

case "$TOTE_DATA_DIR" in
  /*) ;;
  *) echo "TOTE_DATA_DIR must be absolute" >&2; exit 2 ;;
esac
FIXTURES=${1:?usage: TOTE_DATA_DIR=<scratch> pnpm perf:measure <fixtures dir>}
FIXTURES=$(cd "$FIXTURES" && pwd)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="$ROOT/src-tauri/target/perf/bundle/macos/tote-dev.app"
BIN="$APP/Contents/MacOS/tote"
RESULTS="$ROOT/tests/measure/results"
RUNS=5
LOAD_LIMIT=3
LOAD_WAIT_MAX_SECS=${PERF_LOAD_WAIT_MAX_SECS:-1800}

say() { printf '[perf %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

# Another tote-dev would take the requests (single-instance goes by identifier) and the quit.
if pgrep -f 'tote-dev.app/Contents/MacOS/' >/dev/null; then
  echo "a tote-dev is running; quit it first:" >&2
  pgrep -fl 'tote-dev.app/Contents/MacOS/' >&2
  exit 1
fi

DEV_DIRS=("$HOME/Tote-dev" "$HOME/Library/Application Support/tote-dev")
dev_dirs_before=""
for dir in "${DEV_DIRS[@]}"; do [ -e "$dir" ] && dev_dirs_before+="$dir;"; done

if [ -z "${PERF_SKIP_BUILD:-}" ]; then
  say "building the perf bundle"
  (cd "$ROOT" && pnpm tauri build --bundles app --config src-tauri/tauri.dev.conf.json -- --profile perf)
fi
[ -x "$BIN" ] || { echo "no perf bundle at $APP" >&2; exit 1; }

mkdir -p "$RESULTS"

load1() { sysctl -n vm.loadavg | awk '{print $2}'; }

# Rule: the 1-minute load average is under 3 before measuring; wait otherwise.
wait_for_quiet() {
  local waited=0
  while awk -v l="$(load1)" -v m="$LOAD_LIMIT" 'BEGIN{exit !(l>=m)}'; do
    if [ "$waited" -ge "$LOAD_WAIT_MAX_SECS" ]; then
      echo "load average stayed at or above $LOAD_LIMIT for ${waited}s" >&2
      exit 1
    fi
    say "load $(load1) >= $LOAD_LIMIT, waiting"
    sleep 30
    waited=$((waited + 30))
  done
}

APP_PID=""
BACKGROUND=(TOTE_BACKGROUND=1)
FRAMELESS=(--frameless)
if [ -n "${PERF_FOREGROUND:-}" ]; then
  BACKGROUND=()
  FRAMELESS=()
fi

# Starts the measured app on the data folder $1; further arguments are extra environment.
launch() {
  local data=$1
  shift
  env TOTE_DATA_DIR="$data" TOTE_PERF=1 ${BACKGROUND[@]+"${BACKGROUND[@]}"} "$@" "$BIN" \
    >>"$data/app.log" 2>&1 &
  APP_PID=$!
}

# Waits until perf.jsonl in $1 has a mark starting with $2; $3 seconds at most.
wait_mark() {
  local data=$1 name=$2 limit=$3 waited=0
  until grep -q "\"name\":\"$name" "$data/perf.jsonl" 2>/dev/null; do
    if [ "$waited" -ge $((limit * 10)) ]; then
      say "no $name after ${limit}s"
      return 1
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
}

# `tote <file>`: the request the tote command hands the app, given to the bundle's binary
# directly (tests/measure/perf.md, M10). Without TOTE_PERF: this second process only forwards the
# request to the running app and exits, and must not add marks of its own.
open_file() {
  local data=$1 file=$2
  env TOTE_DATA_DIR="$data" ${BACKGROUND[@]+"${BACKGROUND[@]}"} "$BIN" \
    "--tote-request={\"files\":[\"$file\"]}" >>"$data/app.log" 2>&1
}

quit_app() {
  osascript -e 'quit app "tote-dev"' >/dev/null 2>&1 || true
  local waited=0
  while kill -0 "$APP_PID" 2>/dev/null; do
    if [ "$waited" -ge 300 ]; then
      say "tote-dev did not quit in 30s; killing it"
      kill "$APP_PID" 2>/dev/null || true
      sleep 1
      break
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  wait "$APP_PID" 2>/dev/null || true
}

# The run's marks, moved out of the data folder so the next run starts a new file.
collect() {
  local data=$1 file=$2 run=$3
  if [ -f "$data/perf.jsonl" ]; then
    mv "$data/perf.jsonl" "$RESULTS/perf-$file-$run.jsonl"
  else
    rm -f "$RESULTS/perf-$file-$run.jsonl"
  fi
}

# A fresh data folder $1 with the fixtures' machine.json and the workspace $2.
fresh() {
  local data=$1 workspace=$2
  rm -rf "$data"
  mkdir -p "$data/workspaces"
  cp "$FIXTURES/machine.json" "$data/machine.json"
  # APFS clones: ten thousand memos are copied in a moment.
  cp -cR "$FIXTURES/$workspace" "$data/workspaces/$workspace"
}

# One launch that is not measured: the window, the launch state and the disk cache are then as
# they are when the app is started again (the rules' 「cold」 is per process).
prepare() {
  local data=$1
  shift
  launch "$data" "$@"
  wait_mark "$data" app-ready 60 || true
  sleep 2
  quit_app
  rm -f "$data/perf.jsonl"
}

no_session() { rm -rf "$1/workspaces/$2/.tote/sessions"; }

# Runs scenario $1 ($2 is the function doing one run, given the run number) five times; when the
# runs of $1 hold two or more invalid ones, keeps them as attempt 1 and runs all five again.
measure() {
  local file=$1 one_run=$2 attempt
  for attempt in 1 2; do
    wait_for_quiet
    say "$file (attempt $attempt, load $(load1))"
    echo "$file attempt $attempt: load $(load1) at $(date +%H:%M:%S)" >>"$RESULTS/load.txt"
    local run
    for run in $(seq 1 "$RUNS"); do
      "$one_run" "$run"
    done
    if node "$ROOT/scripts/perf-summary.ts" --check "$file" "$RESULTS" ${FRAMELESS[@]+"${FRAMELESS[@]}"}; then
      return
    fi
    if [ "$attempt" = 1 ]; then
      say "$file: two or more invalid runs, running it again"
      for run in $(seq 1 "$RUNS"); do
        [ -f "$RESULTS/perf-$file-$run.jsonl" ] &&
          mv "$RESULTS/perf-$file-$run.jsonl" "$RESULTS/perf-$file-$run.attempt1.jsonl"
      done
    fi
  done
}

wanted() { [ -z "${PERF_ONLY:-}" ] || [[ " $PERF_ONLY " == *" $1 "* ]]; }

{
  echo "date: $(date)"
  echo "machine: $(sysctl -n hw.model) / $(sysctl -n machdep.cpu.brand_string) / $(($(sysctl -n hw.memsize) / 1073741824))GB"
  echo "macOS: $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
  echo "power: $(pmset -g batt | head -1)"
  echo "displays:"
  system_profiler SPDisplaysDataType 2>/dev/null | grep -E 'Display Type|Resolution|Main Display|Connection Type|^ {8}[^ ].*:$' || true
  echo "bundle: $APP ($(stat -f '%Sm' "$BIN"))"
} >"$RESULTS/env.txt"

D="$TOTE_DATA_DIR"

if [ -n "${PERF_SMOKE:-}" ]; then
  data="$D/smoke"
  fresh "$data" empty
  launch "$data"
  wait_mark "$data" app-ready 60 || true
  sleep 3
  open_file "$data" "$FIXTURES/code-1mb.ts"
  wait_mark "$data" open-first-paint 60 || true
  wait_mark "$data" open-first-tokens 60 || true
  quit_app
  cat "$data/perf.jsonl" 2>/dev/null || echo "no perf.jsonl" >&2
  exit 0
fi

# 콜드 스타트: an empty workspace, no session; started again ten seconds after quitting.
COLD="$D/cold-start"
cold_run() {
  sleep 10
  no_session "$COLD" empty
  launch "$COLD"
  wait_mark "$COLD" app-ready 60 || true
  sleep 1
  quit_app
  collect "$COLD" cold-start "$1"
}
if wanted cold-start; then
  fresh "$COLD" empty
  prepare "$COLD"
  measure cold-start cold_run
fi

# 파일 열기: the window is up, then `tote <file>` opens it in an external tab.
OPEN="$D/open"
OPEN_FILE=""
OPEN_NAME=""
open_run() {
  local run=$1
  no_session "$OPEN" empty
  launch "$OPEN"
  wait_mark "$OPEN" app-ready 60 || true
  # The window as the person finds it: up and idle, not still starting.
  sleep 3
  open_file "$OPEN" "$FIXTURES/$OPEN_FILE"
  if [ -n "${PERF_FOREGROUND:-}" ]; then
    wait_mark "$OPEN" open-first-paint 60 || true
  else
    wait_mark "$OPEN" open-start 60 || true
  fi
  case "$OPEN_NAME" in
    open-ts-10mb | open-md-10mb) wait_mark "$OPEN" open-first-tokens 60 || true ;;
    open-ts-100mb)
      # 메모리: the viewer has been open for ten seconds (in the background, ten seconds after
      # open-start: there is no frame to wait for).
      sleep 10
      local rss
      rss=$(ps -o rss= -p "$APP_PID" | tr -d ' ')
      if [ -n "$rss" ]; then
        printf '{"t":0,"name":"rss-kb","value":%s,"pid":%s}\n' "$rss" "$APP_PID" \
          >"$RESULTS/perf-memory-$run.jsonl"
      else
        rm -f "$RESULTS/perf-memory-$run.jsonl"
      fi
      ;;
  esac
  sleep 1
  quit_app
  collect "$OPEN" "$OPEN_NAME" "$run"
}
OPENS=(
  "open-ts-10mb code-10mb.ts"
  "open-md-10mb code-10mb.md"
  "open-ts-100mb code-100mb.ts"
  "open-json-10mb json-10mb-one-line.json"
  "open-log-100k log-100k.log"
)
prepared_open=""
for entry in "${OPENS[@]}"; do
  read -r OPEN_NAME OPEN_FILE <<<"$entry"
  wanted "$OPEN_NAME" || continue
  # In the background only the runs other scenarios read are worth making (first tokens, memory).
  if [ -z "${PERF_FOREGROUND:-}" ]; then
    case "$OPEN_NAME" in open-json-10mb | open-log-100k) continue ;; esac
  fi
  if [ -z "$prepared_open" ]; then
    fresh "$OPEN" empty
    prepare "$OPEN"
    prepared_open=1
  fi
  measure "$OPEN_NAME" open_run
  if [ "$OPEN_NAME" = open-ts-100mb ] && ! node "$ROOT/scripts/perf-summary.ts" --check memory "$RESULTS" ${FRAMELESS[@]+"${FRAMELESS[@]}"}; then
    say "memory: two or more runs without an RSS value"
  fi
done

# 세션 복원: fifty memo tabs, the last active; only it is read.
RESTORE="$D/restore-50"
DEVICE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).deviceId)' "$FIXTURES/machine.json")
restore_run() {
  sleep 10
  # The quit before wrote the session again; each run starts from the fixture's.
  cp "$FIXTURES/restore-50/.tote/sessions/$DEVICE.json" "$RESTORE/workspaces/restore-50/.tote/sessions/$DEVICE.json"
  launch "$RESTORE"
  wait_mark "$RESTORE" restore-done 60 || true
  sleep 1
  quit_app
  collect "$RESTORE" restore-50 "$1"
}
if wanted restore-50 && [ -n "${PERF_FOREGROUND:-}${PERF_BACKGROUND_RESTORE:-}" ]; then
  fresh "$RESTORE" restore-50
  prepare "$RESTORE"
  frameless=(${FRAMELESS[@]+"${FRAMELESS[@]}"})
  FRAMELESS=()
  measure restore-50 restore_run
  FRAMELESS=(${frameless[@]+"${frameless[@]}"})
fi

# 검색: the memos-10k workspace; the window runs TOTE_PERF_SEARCH once it is ready.
SEARCH="$D/search"
SEARCH_NAME=""
SEARCH_ENV=()
search_run() {
  no_session "$SEARCH" memos-10k
  launch "$SEARCH" "${SEARCH_ENV[@]}"
  wait_mark "$SEARCH" search-done 120 || true
  sleep 1
  quit_app
  collect "$SEARCH" "$SEARCH_NAME" "$1"
}
prepared_search=""
for entry in "search-literal needle-50 0" 'search-regex needle-\d+5$ 1'; do
  read -r SEARCH_NAME query regex <<<"$entry"
  wanted "$SEARCH_NAME" || continue
  SEARCH_ENV=("TOTE_PERF_SEARCH=$query" "TOTE_PERF_SEARCH_REGEX=$regex")
  if [ -z "$prepared_search" ]; then
    fresh "$SEARCH" memos-10k
    prepare "$SEARCH"
    prepared_search=1
  fi
  measure "$SEARCH_NAME" search_run
done

# 감시 배치: a memo saved the way tote saves (a temporary file in the folder, then a rename) while
# the window is up; the batches of the next two seconds are kept, nothing from the start or quit.
WATCH="$D/watch"
WATCH_NAME=""
WATCH_WS=""
watch_run() {
  local run=$1 ws="$WATCH/workspaces/$WATCH_WS" before
  no_session "$WATCH" "$WATCH_WS"
  launch "$WATCH"
  wait_mark "$WATCH" app-ready 60 || true
  sleep 3
  before=$(wc -l <"$WATCH/perf.jsonl" 2>/dev/null || echo 0)
  printf '# perf %s\n\nsaved by measure-perf.sh, run %s\n' "$WATCH_NAME" "$run" >"$ws/.tote-tmp-perf"
  mv "$ws/.tote-tmp-perf" "$ws/memo-00010.md"
  sleep 2
  if [ -f "$WATCH/perf.jsonl" ]; then
    tail -n +$((before + 1)) "$WATCH/perf.jsonl" >"$RESULTS/perf-$WATCH_NAME-$run.jsonl"
  else
    rm -f "$RESULTS/perf-$WATCH_NAME-$run.jsonl"
  fi
  quit_app
  rm -f "$WATCH/perf.jsonl"
}
for entry in "watch-10k memos-10k" "watch-50 restore-50"; do
  read -r WATCH_NAME WATCH_WS <<<"$entry"
  wanted "$WATCH_NAME" || continue
  fresh "$WATCH" "$WATCH_WS"
  prepare "$WATCH"
  measure "$WATCH_NAME" watch_run
done

for dir in "${DEV_DIRS[@]}"; do
  if [ -e "$dir" ] && [[ "$dev_dirs_before" != *"$dir;"* ]]; then
    echo "WARNING: the measurement made $dir" >&2
  fi
done

node "$ROOT/scripts/perf-summary.ts" "$RESULTS" ${FRAMELESS[@]+"${FRAMELESS[@]}"} | tee "$RESULTS/summary.md"

#!/usr/bin/env bash
#
# Integration test for Playtiss Phase 1 workflow.
# Exercises: graphql-server, pipeline-runner, typescript-worker, cli
#
# Usage: bash scripts/integration-test.sh [--verbose]
#
set -euo pipefail

VERBOSE=false
[[ "${1:-}" == "--verbose" ]] && VERBOSE=true

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTION_ID="019d048e-d525-89ca-8fed-1f12e6000001"
UPSTREAM_NODE_ID="baguqeeraxy6baoxenupejeatrvblqb4wzjl4nqst6y36h7azkafny6ragw3q" # Node 1 (A+B), feeds into Node 2
TEST_DB_SOURCE="$PROJECT_ROOT/graphql-server/playtiss-test-add3.db"
TEMP_DB=""
PIDS=()
STEP=0
PASS=0
FAIL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[TEST]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
err()  { echo -e "${RED}[FAIL]${NC} $*"; }
vlog() { $VERBOSE && echo -e "[DEBUG] $*" >&2 || true; }

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then
    log "  ✓ $label"
    PASS=$((PASS + 1))
  else
    err "  ✗ $label — expected '$needle'"
    vlog "Output was: $haystack"
    FAIL=$((FAIL + 1))
  fi
}

cleanup() {
  local exit_code=$?
  log "Cleaning up..."
  # On failure, dump service logs for debugging
  if [[ $exit_code -ne 0 || $FAIL -gt 0 ]] && [[ -n "${TEMP_DIR:-}" ]]; then
    for logfile in "${TEMP_DIR}"/*.log; do
      [[ -f "$logfile" ]] || continue
      warn "=== $(basename "$logfile") (last 20 lines) ==="
      tail -20 "$logfile" 2>/dev/null || true
    done
  fi
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  [[ -n "$TEMP_DB" && -f "$TEMP_DB" ]] && rm -f "$TEMP_DB" "${TEMP_DB}-wal" "${TEMP_DB}-shm"
  [[ -n "${TEMP_DIR:-}" && -d "${TEMP_DIR:-}" ]] && rm -rf "$TEMP_DIR"
  log "Cleanup done."
}
trap cleanup EXIT

wait_for_port() {
  local port=$1 timeout=${2:-30} elapsed=0
  while ! lsof -iTCP:"$port" -sTCP:LISTEN -P -n >/dev/null 2>&1; do
    sleep 1
    elapsed=$((elapsed + 1))
    if ((elapsed >= timeout)); then
      err "Timed out waiting for port $port"
      return 1
    fi
  done
  vlog "Port $port ready after ${elapsed}s"
}

poll_status() {
  # Usage: poll_status <handle> <expected_status> [timeout] [required_pattern]
  # If required_pattern is set, both Status: and the pattern must match
  local handle="$1" expected_status="$2" timeout="${3:-30}" required_pattern="${4:-}" elapsed=0
  local output="" clean=""
  while ((elapsed < timeout)); do
    output=$(cd "$PROJECT_ROOT/cli" && pnpm dev status "$handle" 2>&1) || true
    # Strip ANSI codes for reliable matching
    clean=$(echo "$output" | sed 's/\x1b\[[0-9;]*m//g')
    vlog "Status poll ($elapsed s): $(echo "$clean" | grep -E 'Status:|FRESH|STALE' || true)"
    if echo "$clean" | grep -q "Status: $expected_status"; then
      if [[ -z "$required_pattern" ]] || echo "$clean" | grep -q "$required_pattern"; then
        echo "$clean"
        return 0
      fi
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  warn "Timed out waiting for Status: $expected_status${required_pattern:+ with pattern '$required_pattern'} (last output below)"
  echo "$clean"
  return 0
}

# Load nvm
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 24.13 >/dev/null 2>&1 || { err "nvm use 24.13 failed"; exit 1; }

# Ensure playtiss package is built (required for pipeline-runner compilation)
log "Building playtiss package..."
(cd "$PROJECT_ROOT/src" && pnpm build) >/dev/null 2>&1 || { err "Failed to build playtiss package"; exit 1; }
log "  playtiss package built."

# Kill any existing processes on port 4000
if lsof -ti:4000 >/dev/null 2>&1; then
  warn "Port 4000 is in use, killing existing processes..."
  lsof -ti:4000 | xargs kill 2>/dev/null || true
  sleep 2
fi

########################################################################
# Step 0: Setup
########################################################################
log "Step 0: Setup"

if [[ ! -f "$TEST_DB_SOURCE" ]]; then
  err "Test database not found: $TEST_DB_SOURCE"
  exit 1
fi

TEMP_DIR=$(mktemp -d /tmp/playtiss-integration-XXXXXX)
TEMP_DB="$TEMP_DIR/playtiss.db"
cp "$TEST_DB_SOURCE" "$TEMP_DB"
log "  Copied test DB → $TEMP_DB"

export PLAYTISS_DB_PATH="$TEMP_DB"
# Note: DO NOT set PLAYTISS_STORAGE_TYPE=local — the test DB was created with S3 storage,
# so all workflow definition assets are in S3. Each service's .env has PLAYTISS_STORAGE_TYPE=s3.

# Start graphql-server
log "  Starting graphql-server..."
(cd "$PROJECT_ROOT/graphql-server" && npm start) >"${TEMP_DIR}/gql.log" 2>&1 &
PIDS+=($!)
wait_for_port 4000 60
log "  graphql-server ready on port 4000"

# Start pipeline-runner
log "  Starting pipeline-runner..."
(cd "$PROJECT_ROOT/pipeline-runner" && npm start) >"${TEMP_DIR}/runner.log" 2>&1 &
PIDS+=($!)
# Wait for pipeline-runner to be ready (it compiles TypeScript first)
RUNNER_READY=false
for i in $(seq 1 60); do
  if grep -q "Workflow Engine started\|Pipeline Runner started\|Polling for events\|Event loop\|Starting pipeline" "${TEMP_DIR}/runner.log" 2>/dev/null; then
    RUNNER_READY=true
    break
  fi
  sleep 1
done
if $RUNNER_READY; then
  log "  pipeline-runner ready"
else
  warn "  pipeline-runner may not be ready yet (waited 60s). Continuing..."
  vlog "Runner log: $(tail -5 "${TEMP_DIR}/runner.log" 2>/dev/null)"
fi

# Start typescript-worker
start_worker() {
  log "  Starting typescript-worker..."
  (cd "$PROJECT_ROOT/typescript-worker" && pnpm dev:add-two) >"${TEMP_DIR}/worker.log" 2>&1 &
  WORKER_PID=$!
  PIDS+=($WORKER_PID)
  sleep 2
  log "  typescript-worker started (PID $WORKER_PID)"
}
WORKER_PID=""
start_worker

# Wait for all services to fully initialize (pipeline-runner's event bus + discovery loop
# need time to complete first cycle, worker needs to register its polling)
log "  Waiting for services to stabilize..."
sleep 5
log "  All services running."

########################################################################
# Step 1: Run workflow
########################################################################
STEP=$((STEP + 1))
log "Step $STEP: Run workflow"

RUN_OUTPUT=$(cd "$PROJECT_ROOT/cli" && pnpm dev run "$ACTION_ID" -i test-inputs.json 2>&1)
vlog "Run output: $RUN_OUTPUT"

HANDLE_ID=$(echo "$RUN_OUTPUT" | grep "Execution requested:" | grep -oE '019[0-9a-f-]{31,35}' | head -1)
if [[ -z "$HANDLE_ID" ]]; then
  err "Failed to extract HANDLE_ID from run output"
  echo "$RUN_OUTPUT"
  exit 1
fi
log "  HANDLE_ID=$HANDLE_ID"

STATUS_OUT=$(poll_status "$HANDLE_ID" "COMPLETED" 90 "FRESH/IDLE")
assert_contains "Workflow completed" "$STATUS_OUT" "Status: COMPLETED"
assert_contains "Node 1 FRESH/IDLE" "$STATUS_OUT" "FRESH/IDLE"

# Extract the first node ID (used for fail-task and rerun-task)
# Node lines look like: "  <node_id>: FRESH/IDLE" — extract the ID before the colon
NODE_ID=$(echo "$STATUS_OUT" | grep -E 'FRESH|STALE' | head -1 | sed 's/^[[:space:]]*//' | sed 's/:.*//' || true)
if [[ -z "$NODE_ID" ]]; then
  err "Failed to extract NODE_ID from status output"
  vlog "Status output: $STATUS_OUT"
  exit 1
fi
log "  NODE_ID=$NODE_ID"

########################################################################
# Step 2: Fail a task
########################################################################
STEP=$((STEP + 1))
log "Step $STEP: Fail a task"

FAIL_OUT=$(cd "$PROJECT_ROOT/cli" && pnpm dev fail-task "$HANDLE_ID" "$NODE_ID" -r "integration test" 2>&1)
vlog "Fail output: $FAIL_OUT"

STATUS_OUT=$(poll_status "$HANDLE_ID" "FAILED" 30)
assert_contains "Workflow failed" "$STATUS_OUT" "Status: FAILED"
assert_contains "Node shows FRESH/FAILED" "$STATUS_OUT" "FRESH/FAILED"

########################################################################
# Step 3: Rerun task (with worker stopped)
########################################################################
STEP=$((STEP + 1))
log "Step $STEP: Rerun task (worker stopped)"

# Kill the worker
if kill -0 "$WORKER_PID" 2>/dev/null; then
  kill "$WORKER_PID" 2>/dev/null || true
  wait "$WORKER_PID" 2>/dev/null || true
  log "  Worker stopped"
fi

RERUN_OUT=$(cd "$PROJECT_ROOT/cli" && pnpm dev rerun-task "$HANDLE_ID" "$NODE_ID" 2>&1)
vlog "Rerun output: $RERUN_OUT"

STATUS_OUT=$(poll_status "$HANDLE_ID" "RUNNING" 30 "FRESH/RUNNING")
assert_contains "Workflow running" "$STATUS_OUT" "Status: RUNNING"
assert_contains "Node shows FRESH/RUNNING" "$STATUS_OUT" "FRESH/RUNNING"

########################################################################
# Step 4: Restart worker → completion
########################################################################
STEP=$((STEP + 1))
log "Step $STEP: Restart worker → completion"

start_worker

STATUS_OUT=$(poll_status "$HANDLE_ID" "COMPLETED" 60 "FRESH/IDLE")
assert_contains "Workflow completed after rerun" "$STATUS_OUT" "Status: COMPLETED"

########################################################################
# Step 5: Submit overwrite result → stale detection
########################################################################
STEP=$((STEP + 1))
log "Step $STEP: Submit overwrite result → stale detection"

# Submit to the upstream node (A+B) whose output feeds into the downstream node
SUBMIT_OUT=$(cd "$PROJECT_ROOT/cli" && pnpm dev submit-result "$HANDLE_ID" "$UPSTREAM_NODE_ID" test-overwrite-output.json 2>&1)
vlog "Submit output: $SUBMIT_OUT"

# After submit-result, the downstream node should become STALE/IDLE
STATUS_OUT=$(poll_status "$HANDLE_ID" "COMPLETED" 30 "STALE/IDLE")
assert_contains "Has STALE/IDLE node" "$STATUS_OUT" "STALE/IDLE"
assert_contains "Has FRESH/IDLE node" "$STATUS_OUT" "FRESH/IDLE"

########################################################################
# Step 6: Update stale nodes
########################################################################
STEP=$((STEP + 1))
log "Step $STEP: Update stale nodes"

UPDATE_OUT=$(cd "$PROJECT_ROOT/cli" && pnpm dev update "$HANDLE_ID" 2>&1)
vlog "Update output: $UPDATE_OUT"

# Wait until COMPLETED with FRESH/IDLE AND no STALE nodes remaining
STALE_CLEARED=false
for poll_i in $(seq 1 45); do
  STATUS_OUT=$(cd "$PROJECT_ROOT/cli" && pnpm dev status "$HANDLE_ID" 2>&1 | sed 's/\x1b\[[0-9;]*m//g') || true
  vlog "Update poll ($poll_i): $(echo "$STATUS_OUT" | grep -E 'Status:|FRESH|STALE' || true)"
  STALE_COUNT=$(echo "$STATUS_OUT" | grep -c "STALE" || true)
  if echo "$STATUS_OUT" | grep -q "Status: COMPLETED" && echo "$STATUS_OUT" | grep -q "FRESH/IDLE" && [[ "$STALE_COUNT" -eq 0 ]]; then
    STALE_CLEARED=true
    break
  fi
  sleep 2
done

assert_contains "Workflow completed after update" "$STATUS_OUT" "Status: COMPLETED"

if $STALE_CLEARED; then
  log "  ✓ No stale nodes remaining"
  PASS=$((PASS + 1))
else
  err "  ✗ Still have $STALE_COUNT stale node(s)"
  FAIL=$((FAIL + 1))
fi

########################################################################
# Report
########################################################################
echo ""
echo "========================================"
if [[ "$FAIL" -eq 0 ]]; then
  echo -e "${GREEN}ALL $PASS ASSERTIONS PASSED${NC}"
  echo "========================================"
  exit 0
else
  echo -e "${RED}$FAIL ASSERTION(S) FAILED${NC} ($PASS passed)"
  echo "========================================"
  exit 1
fi

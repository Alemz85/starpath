#!/usr/bin/env bash
set -euo pipefail

# career-ops batch runner — standalone orchestrator for claude -p workers
# Reads batch-input.tsv, delegates each offer to a claude -p worker,
# tracks state in batch-state.tsv for resumability.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BATCH_DIR="$SCRIPT_DIR"
INPUT_FILE="$BATCH_DIR/batch-input.tsv"
STATE_FILE="$BATCH_DIR/batch-state.tsv"
PROMPT_FILE="$(node "$PROJECT_DIR/scripts/overrides.mjs" resolve batch/batch-prompt.md 2>/dev/null || echo "$PROJECT_DIR/batch/batch-prompt.md")"
LOGS_DIR="$BATCH_DIR/logs"
TRACKER_DIR="$BATCH_DIR/tracker-additions"
REPORTS_DIR="$PROJECT_DIR/reports"
APPLICATIONS_FILE="$PROJECT_DIR/data/applications.md"
LOCK_FILE="$BATCH_DIR/batch-runner.pid"
STATE_LOCK_DIR="$BATCH_DIR/.batch-state.lock"
STATE_LOCK_PID_FILE="$STATE_LOCK_DIR/pid"
STATE_LOCK_TIMEOUT_SECONDS=30
MAIN_PID="${BASHPID:-$$}"

# Defaults
CACHE_FLAG=""   # set by check_prerequisites when the CLI supports it (lever 4)
WORKER_ARGS=()  # least-privilege flags, set by check_prerequisites (worker-capabilities.mjs)
PARALLEL=1
DRY_RUN=false
RETRY_FAILED=false
START_FROM=0
MAX_RETRIES=2
MIN_SCORE=0
# Worker model — the bare tier alias, which the Claude CLI resolves to the
# newest Opus it knows (auto-latest; keep the CLI updated). Same rule as
# modelArg()/MODEL_PINS in frontend/src/lib/spawnFormat.ts. Pin a version per
# run with --model <full-model-id>.
MODEL="opus"

usage() {
  cat <<'USAGE'
career-ops batch runner — process job offers in batch via claude -p workers
Workers run the latest Opus (default alias: opus; pin a version with --model).

Usage: batch-runner.sh [OPTIONS]

Options:
  --parallel N         Number of parallel workers (default: 1)
  --dry-run            Show what would be processed, don't execute
  --retry-failed       Only retry offers marked as "failed" in state
  --start-from N       Start from offer ID N (skip earlier IDs)
  --max-retries N      Max retry attempts per offer (default: 2)
  --min-score N        Mark offers whose Priority (sqrt(match*ease)) is below N as skipped in
                       state; Blocked listings (no Priority) always fail the gate (default: 0 = off)
  --model ID           Claude model for workers (default: opus = latest Opus)
  -h, --help           Show this help

Files:
  batch-input.tsv      Input offers (id, url, source, notes)
  batch-state.tsv      Processing state (auto-managed)
  batch-prompt.md      Prompt template for workers
  logs/                Per-offer logs
  tracker-additions/   Tracker lines for post-batch merge

Examples:
  # Dry run to see pending offers
  ./batch-runner.sh --dry-run

  # Process all pending
  ./batch-runner.sh

  # Retry only failed offers
  ./batch-runner.sh --retry-failed

  # Process 2 at a time starting from ID 10
  ./batch-runner.sh --parallel 2 --start-from 10
USAGE
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --parallel) PARALLEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --retry-failed) RETRY_FAILED=true; shift ;;
    --start-from) START_FROM="$2"; shift 2 ;;
    --max-retries) MAX_RETRIES="$2"; shift 2 ;;
    --min-score) MIN_SCORE="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# Lock file to prevent double execution
acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$LOCK_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
      echo "ERROR: Another batch-runner is already running (PID $old_pid)"
      echo "If this is stale, remove $LOCK_FILE"
      exit 1
    else
      echo "WARN: Stale lock file found (PID $old_pid not running). Removing."
      rm -f "$LOCK_FILE"
    fi
  fi
  echo "$MAIN_PID" > "$LOCK_FILE"
}

release_lock() {
  if [[ "${BASHPID:-$$}" != "$MAIN_PID" ]]; then
    return
  fi
  rm -f "$LOCK_FILE"
}

trap release_lock EXIT

# Check if batch-prompt.md is in sync with _shared.md
check_version_drift() {
  local shared_md="$PROJECT_DIR/modes/_shared.md"
  if [[ ! -f "$shared_md" ]]; then
    return 0
  fi

  local shared_version
  shared_version=$(grep -m 1 "<!-- scoring-version:" "$shared_md" | sed 's/.*<!-- scoring-version: \([0-9-]*\) -->.*/\1/' || true)
  
  local batch_version
  batch_version=$(grep -m 1 "<!-- scoring-version:" "$PROMPT_FILE" | sed 's/.*<!-- scoring-version: \([0-9-]*\) -->.*/\1/' || true)

  if [[ -n "$shared_version" ]] && [[ "$shared_version" != "$batch_version" ]]; then
    echo "ERROR: Version drift detected!"
    echo "  modes/_shared.md: $shared_version"
    echo "  batch/batch-prompt.md: ${batch_version:-none}"
    echo "Please sync batch-prompt.md with the latest scoring logic before running workers."
    exit 1
  fi
}

# Validate prerequisites
check_prerequisites() {
  if [[ ! -f "$INPUT_FILE" ]]; then
    echo "ERROR: $INPUT_FILE not found. Add offers first."
    exit 1
  fi

  if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "ERROR: $PROMPT_FILE not found."
    exit 1
  fi

  check_version_drift

  if ! command -v claude &>/dev/null; then
    echo "ERROR: 'claude' CLI not found in PATH."
    exit 1
  fi

  mkdir -p "$LOGS_DIR" "$TRACKER_DIR" "$REPORTS_DIR"

  # Refresh the compact CV summary the workers read instead of the full CV
  # (mtime-gated, zero-token). Best-effort: batch-prompt.md documents the
  # fallback to user/cv.md when the artifact is missing.
  node "$PROJECT_DIR/scripts/cv-summary.mjs" --if-stale \
    || echo "WARN: cv-summary refresh failed — workers fall back to user/cv.md"

  # Token-cost lever 4 (prompt caching): keep the default system prompt
  # byte-stable across workers. Workers write files as they run, so the
  # git-status section of the default system prompt would otherwise change
  # between spawns and break prompt-cache prefix reuse mid-batch. The flag
  # moves those per-machine sections (cwd, env, git status) into the first
  # user message. Feature-detected so older CLIs simply run without it.
  CACHE_FLAG=""
  local claude_help
  claude_help=$(claude --help 2>&1 || true)
  if [[ "$claude_help" == *"--exclude-dynamic-system-prompt-sections"* ]]; then
    CACHE_FLAG="--exclude-dynamic-system-prompt-sections"
  fi

  # Least-privilege workers: the flags come from the capability table
  # (scripts/lib/worker-capabilities.mjs, kind `eval`), never from here. A
  # CLI that can't express them gets no workers at all — there is no
  # skip-permissions fallback.
  local flag
  for flag in '"dontAsk"' --strict-mcp-config --setting-sources --disallowedTools '--tools <tools'; do
    if [[ "$claude_help" != *"$flag"* ]]; then
      echo "ERROR: this claude CLI lacks $flag, needed to run workers least-privilege. Update the CLI (claude update)."
      exit 1
    fi
  done
  WORKER_ARGS=()
  local line
  while IFS= read -r line; do
    [[ -n "$line" ]] && WORKER_ARGS+=("$line")
  done < <(node "$PROJECT_DIR/scripts/lib/worker-capabilities.mjs" args eval)
  if (( ${#WORKER_ARGS[@]} == 0 )); then
    echo "ERROR: could not derive the worker permission flags (scripts/lib/worker-capabilities.mjs)."
    exit 1
  fi
}

# Initialize state file if it doesn't exist
init_state() {
  if [[ ! -f "$STATE_FILE" ]]; then
    printf 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' > "$STATE_FILE"
  fi
}

acquire_state_lock() {
  local waited=0
  local max_waits=$((STATE_LOCK_TIMEOUT_SECONDS * 10))

  while true; do
    if mkdir "$STATE_LOCK_DIR" 2>/dev/null; then
      if printf '%s\n' "${BASHPID:-$$}" > "$STATE_LOCK_PID_FILE"; then
        return 0
      fi
      rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
      rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
      echo "ERROR: Failed to initialize state lock metadata at $STATE_LOCK_DIR"
      return 1
    fi

    if [[ ! -d "$STATE_LOCK_DIR" ]]; then
      echo "ERROR: Failed to create state lock directory $STATE_LOCK_DIR"
      return 1
    fi

    if [[ -f "$STATE_LOCK_PID_FILE" ]]; then
      local lock_pid
      lock_pid=$(cat "$STATE_LOCK_PID_FILE" 2>/dev/null || true)
      if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
        rm -f "$STATE_LOCK_PID_FILE"
        if rmdir "$STATE_LOCK_DIR" 2>/dev/null; then
          echo "WARN: Recovered stale state lock (PID $lock_pid not running)."
          continue
        fi
      fi
    fi

    if (( waited >= max_waits )); then
      echo "ERROR: Timed out waiting for state lock at $STATE_LOCK_DIR"
      echo "If no batch-runner worker is active, remove the stale lock directory."
      return 1
    fi

    sleep 0.1
    ((waited += 1))
  done
}

release_state_lock() {
  rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
  rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
}

run_with_state_lock() {
  acquire_state_lock || return $?

  local status=0
  if "$@"; then
    status=0
  else
    status=$?
  fi

  release_state_lock
  return "$status"
}

# Error/reason cell of an offer in the state file ("-" when none)
get_reason() {
  local id="$1"
  [[ -f "$STATE_FILE" ]] || { echo "-"; return; }
  local reason
  reason=$(awk -F'\t' -v id="$id" '$1 == id { print $8 }' "$STATE_FILE")
  echo "${reason:--}"
}

# Get status of an offer from state file
get_status() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "none"
    return
  fi
  local status
  status=$(awk -F'\t' -v id="$id" '$1 == id { print $3 }' "$STATE_FILE")
  echo "${status:-none}"
}

# Get retry count for an offer
get_retries() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "0"
    return
  fi
  local retries
  retries=$(awk -F'\t' -v id="$id" '$1 == id { print $9 }' "$STATE_FILE")
  echo "${retries:-0}"
}

# Highest report number already recorded in the state file (0 if none).
# Caller must hold STATE_LOCK_DIR while this runs.
max_state_report_num_unlocked() {
  local max_num=0
  if [[ -f "$STATE_FILE" ]]; then
    while IFS=$'\t' read -r _ _ _ _ _ rnum _ _ _; do
      [[ "$rnum" =~ ^[0-9]+$ ]] || continue
      local n=$((10#$rnum))
      if (( n > max_num )); then
        max_num=$n
      fi
    done < "$STATE_FILE"
  fi
  printf '%s' "$max_num"
}

# The report number for an offer: the one it already holds from an earlier
# attempt, else a fresh claim from scripts/reserve-report-num.mjs. The claim
# is an O_EXCL sentinel beside data/scouting.md, so this runner, the app's
# eval spawns and any other runner can never hand out the same number; its
# floor covers the scouting rows, numbered files anywhere under reports/
# (through the private/ link) and this state file. The worker writes it as
# the scouting TSV's {num}; merge-scouting.mjs keeps it and releases the claim.
# Caller must hold STATE_LOCK_DIR while this runs.
next_report_num_unlocked() {
  local id="$1"
  local held
  held=$(awk -F'\t' -v id="$id" '$1 == id { print $6 }' "$STATE_FILE" 2>/dev/null || true)
  if [[ "$held" =~ ^[0-9]+$ ]]; then
    printf '%s' "$held"
    return 0
  fi
  node "$PROJECT_DIR/scripts/reserve-report-num.mjs" --by "batch:$id" --min "$(max_state_report_num_unlocked)"
}

# Where state-file writes land. batch-state.tsv is a link into private/, and
# mv onto the link would replace it with a real file, so temp files are made
# beside the link's target and renamed onto that.
state_file_target() {
  node -e '
    const fs = require("fs"), path = require("path")
    const p = path.resolve(process.argv[1])
    try { console.log(fs.realpathSync(p)) } catch {
      let t = p
      try { const l = fs.readlinkSync(p); t = path.resolve(path.dirname(p), l) } catch {}
      try { t = path.join(fs.realpathSync(path.dirname(t)), path.basename(t)) } catch {}
      console.log(t)
    }' "$STATE_FILE"
}

# Update or insert state for an offer.
# Caller must hold STATE_LOCK_DIR while this runs.
update_state_unlocked() {
  local id="$1" url="$2" status="$3" started="$4" completed="$5" report_num="$6" score="$7" error="$8" retries="$9"

  if [[ ! -f "$STATE_FILE" ]]; then
    init_state
  fi

  local target
  target=$(state_file_target)
  local tmp="$target.tmp"
  local found=false

  # Write header
  head -1 "$STATE_FILE" > "$tmp"

  # Process existing lines
  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries; do
    [[ "$sid" == "id" ]] && continue  # skip header
    if [[ "$sid" == "$id" ]]; then
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
      found=true
    else
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$sid" "$surl" "$sstatus" "$sstarted" "$scompleted" "$sreport" "$sscore" "$serror" "$sretries" >> "$tmp"
    fi
  done < "$STATE_FILE"

  if [[ "$found" == "false" ]]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
  fi

  mv "$tmp" "$target"
}

update_state() {
  run_with_state_lock update_state_unlocked "$@"
}

reserve_report_num_unlocked() {
  local id="$1" url="$2" started="$3" retries="$4"

  local report_num=""
  if report_num=$(next_report_num_unlocked "$id"); then
    update_state_unlocked "$id" "$url" "processing" "$started" "-" "$report_num" "-" "-" "$retries"
  fi

  printf '%s\n' "$report_num"
}

reserve_report_num() {
  run_with_state_lock reserve_report_num_unlocked "$@"
}

# Process a single offer
process_offer() {
  local id="$1" url="$2" source="$3" notes="$4"

  local started_at
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local retries
  retries=$(get_retries "$id")
  local report_num
  report_num=$(reserve_report_num "$id" "$url" "$started_at" "$retries")
  local date
  date=$(date +%Y-%m-%d)
  # The posting check runs here, before the worker, so its verdict doesn't
  # depend on the worker choosing to run it (scripts/posting-guard.mjs; never
  # fails the run — an unreachable page is "unchecked"). It also returns the
  # page's own posting date, and saves the readable posting (JSON-LD job text
  # + visible text, hidden content removed) as the worker's JD file under
  # batch/work/: client-rendered ATS pages give WebFetch little more than a title,
  # and the worker never sees the page's hidden text. No file → the worker
  # fetches the URL itself (batch-prompt.md § Unresolved placeholders).
  local jd_rel="batch/work/${id}-posting.txt"
  rm -f "$PROJECT_DIR/$jd_rel"
  local posting_check posted_from_page jd_saved guard_out
  guard_out=$(cd "$PROJECT_DIR" && node scripts/posting-guard.mjs --url "$url" --save-text "$jd_rel" 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write([j.line,j.posted?j.posted.date:"none",j.saved||"none"].join("\t"))}catch{process.stdout.write("unchecked — guard error\tnone\tnone")}})' \
    || printf 'unchecked — guard error\tnone\tnone')
  IFS=$'\t' read -r posting_check posted_from_page jd_saved <<< "$guard_out"
  local jd_line="none (fetch the JD from the URL)"
  [[ "$jd_saved" == "$jd_rel" && -s "$PROJECT_DIR/$jd_rel" ]] && jd_line="$jd_rel"

  echo "--- Processing offer #$id: $url (report $report_num, attempt $((retries + 1)))"

  # Build the prompt with placeholders replaced
  local prompt
  prompt="Process this job listing end-to-end per the system prompt: scouting evaluation (dimensional scoring via scripts/score-listing.mjs) + report .md + scouting TSV + score-history row + final JSON summary."
  prompt="$prompt URL: $url"
  prompt="$prompt JD file: $jd_line"
  prompt="$prompt Posting check: $posting_check"
  prompt="$prompt Posted (from page): ${posted_from_page:-none}"
  prompt="$prompt Report number: $report_num (reserved for this listing: use it as {num} in the scouting TSV and its report link)"
  prompt="$prompt Date: $date"
  prompt="$prompt Batch ID: $id"
  # The input row's notes column (e.g. "Re-evaluation requested…", which
  # batch-prompt.md Step 2 needs to see to score past the dedup check).
  [[ -n "$notes" ]] && prompt="$prompt Notes: $notes"

  local log_file="$LOGS_DIR/${report_num}-${id}.log"

  # Launch claude -p worker on $MODEL (see the MODEL default above).
  # --output-format json makes the CLI emit a final result event with token
  # usage + cost, which feeds the per-spawn accounting in logs/usage.tsv
  # (TODO.md token-cost project: measure before optimizing).
  #
  # The bundle is passed VERBATIM — no per-worker placeholder substitution.
  # A byte-identical appended system prompt across spawns is what lets the
  # API prompt cache serve every worker after the first (token-cost lever 4);
  # the per-listing values (URL, JD file, report number, date, batch id) all
  # travel in the user message above, per batch-prompt.md § "Unresolved
  # placeholders". $CACHE_FLAG is intentionally unquoted: empty on old CLIs.
  local exit_code=0
  claude -p \
    "${WORKER_ARGS[@]}" \
    --output-format json \
    --model "$MODEL" \
    $CACHE_FLAG \
    --append-system-prompt-file "$PROMPT_FILE" \
    "$prompt" \
    > "$log_file" 2>&1 || exit_code=$?

  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # Parse the worker log once: status heuristic, score, token usage, verdict.
  # Fields: status score input cache_creation cache_read output cost duration turns verdict denied outcome reported_error
  # `score` is the worker's Priority (sqrt(match*ease)); a Blocked listing has no
  # Priority (score "-", verdict "blocked").
  local parsed
  parsed=$(node "$PROJECT_DIR/scripts/parse-batch-result.mjs" "$log_file" 2>/dev/null || printf 'unknown\t-\t-\t-\t-\t-\t-\t-\t-\t-\t-\tcompleted\t-\n')
  local p_status p_score p_in p_cc p_cr p_out p_cost p_dur p_turns p_verdict p_denied p_outcome p_rerror
  IFS=$'\t' read -r p_status p_score p_in p_cc p_cr p_out p_cost p_dur p_turns p_verdict p_denied p_outcome p_rerror <<< "$parsed"

  # The worker's scratch: score-listing inputs and the saved posting (batch/work/<id>-…).
  rm -f "$PROJECT_DIR/batch/work/${id}-"*

  # A worker that hit its permissions failed, whatever it exited with: the
  # CLI refused a call and the run may have skipped work to carry on.
  if [[ $exit_code -eq 0 && -n "$p_denied" && "$p_denied" != "-" ]]; then
    exit_code=126
    echo "    ⛔ Blocked by worker permissions: $p_denied"
  fi

  # Append the accounting row (best-effort — never fails the batch).
  append_usage_row "$id" "$report_num" "$completed_at" \
    "$p_status" "$p_score" "$p_verdict" "$p_in" "$p_cc" "$p_cr" "$p_out" "$p_cost" "$p_dur" "$p_turns" || true

  # A worker can exit 0 and still say `"status": "failed"` in its final JSON
  # (JD unreachable, a denied call it reported, posting closed). Believe it:
  # a failed run is retryable, not "completed". A posting that is closed is not
  # a failure to retry, so it is skipped with the reason; a listing the worker
  # skipped as already evaluated is skipped too, not counted completed.
  local worker_error=""
  if [[ $exit_code -eq 0 ]]; then
    case "$p_outcome" in
      failed)
        exit_code=125
        worker_error="worker reported failure: ${p_rerror:--}"
        ;;
      closed)
        update_state "$id" "$url" "skipped" "$started_at" "$completed_at" "$report_num" "-" "posting-closed" "$retries"
        echo "    ⏭️  Skipped (posting closed: ${p_rerror:--})"
        return 0
        ;;
      duplicate)
        update_state "$id" "$url" "skipped" "$started_at" "$completed_at" "$report_num" "-" "duplicate" "$retries"
        echo "    ⏭️  Skipped (already evaluated: duplicate of an earlier listing)"
        return 0
        ;;
    esac
  fi

  if [[ $exit_code -eq 0 ]]; then
    local score="${p_score:--}"
    local blocked=false
    [[ "$p_verdict" == "blocked" ]] && blocked=true
    # State-file score cell: Priority, or the literal "blocked" for a listing
    # gated out by eligibility (print_summary counts these separately).
    [[ "$blocked" == "true" ]] && score="blocked"

    # Check min-score gate. Blocked listings never pass it; a missing score
    # ("-", unparseable log) is left alone as before.
    if (( $(echo "$MIN_SCORE > 0" | bc -l) )); then
      if [[ "$blocked" == "true" ]]; then
        update_state "$id" "$url" "skipped" "$started_at" "$completed_at" "$report_num" "$score" "blocked" "$retries"
        echo "    ⏭️  Skipped (blocked by eligibility; min-score: $MIN_SCORE)"
        return 0
      fi
      if [[ "$score" != "-" && -n "$score" ]] && (( $(echo "$score < $MIN_SCORE" | bc -l) )); then
        update_state "$id" "$url" "skipped" "$started_at" "$completed_at" "$report_num" "$score" "below-min-score" "$retries"
        echo "    ⏭️  Skipped (priority: $score < min-score: $MIN_SCORE)"
        return 0
      fi
    fi

    update_state "$id" "$url" "completed" "$started_at" "$completed_at" "$report_num" "$score" "-" "$retries"
    if [[ "$blocked" == "true" ]]; then
      echo "    ✅ Completed (blocked by eligibility, report: $report_num)"
    else
      echo "    ✅ Completed (priority: $score, report: $report_num)"
    fi
  else
    retries=$((retries + 1))
    local error_msg
    if [[ $exit_code -eq 126 ]]; then
      error_msg=$(printf 'permission denied: %s' "$p_denied" | tr '\t\n' '  ' | cut -c1-200)
    elif [[ $exit_code -eq 125 ]]; then
      error_msg=$(printf '%s' "$worker_error" | tr '\t\n' '  ' | cut -c1-200)
    else
      error_msg=$(tail -5 "$log_file" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo "Unknown error (exit code $exit_code)")
    fi
    update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" "$error_msg" "$retries"
    if [[ $exit_code -eq 125 ]]; then
      echo "    ❌ Failed (attempt $retries, $error_msg)"
    else
      echo "    ❌ Failed (attempt $retries, exit code $exit_code)"
    fi
  fi
}

# Append one per-spawn token/cost accounting row to logs/usage.tsv.
# Column order is defined by USAGE_TSV_HEADER in scripts/lib/batch-usage.mjs.
USAGE_FILE="$LOGS_DIR/usage.tsv"
append_usage_row() {
  local id="$1" report_num="$2" ts="$3" status="$4" score="$5" verdict="$6"
  local in_tok="$7" cc_tok="$8" cr_tok="$9" out_tok="${10}" cost="${11}" dur="${12}" turns="${13}"
  if [[ ! -f "$USAGE_FILE" ]]; then
    printf 'timestamp\tbatch_id\treport_num\tstatus\tscore\tverdict\tinput_tokens\tcache_creation_tokens\tcache_read_tokens\toutput_tokens\tcost_usd\tduration_ms\tnum_turns\n' > "$USAGE_FILE"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$ts" "$id" "$report_num" "$status" "$score" "$verdict" \
    "$in_tok" "$cc_tok" "$cr_tok" "$out_tok" "$cost" "$dur" "$turns" >> "$USAGE_FILE"
}

# Merge worker TSV output into the canonical trackers.
# Batch evaluations land in data/scouting.md (scouting-additions); the
# tracker-additions merge stays for any application-flow TSVs (no-op when empty).
merge_tracker() {
  echo ""
  echo "=== Merging scouting additions ==="
  node "$PROJECT_DIR/scripts/merge-scouting.mjs"
  echo ""
  echo "=== Merging tracker additions ==="
  node "$PROJECT_DIR/scripts/merge-tracker.mjs"
  echo ""
  echo "=== Verifying pipeline integrity ==="
  node "$PROJECT_DIR/scripts/verify-pipeline.mjs" || echo "⚠️  Verification found issues (see above)"
}

# Print summary
print_summary() {
  echo ""
  echo "=== Batch Summary ==="

  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found."
    return
  fi

  local total=0 completed=0 failed=0 pending=0 skipped=0
  local score_sum=0 score_count=0 blocked_count=0

  while IFS=$'\t' read -r sid _ sstatus _ _ _ sscore _ _; do
    [[ "$sid" == "id" ]] && continue
    total=$((total + 1))
    case "$sstatus" in
      completed) completed=$((completed + 1))
        if [[ "$sscore" == "blocked" ]]; then
          blocked_count=$((blocked_count + 1))
        elif [[ "$sscore" != "-" && -n "$sscore" ]]; then
          score_sum=$(echo "$score_sum + $sscore" | bc 2>/dev/null || echo "$score_sum")
          score_count=$((score_count + 1))
        fi
        ;;
      failed) failed=$((failed + 1)) ;;
      skipped) skipped=$((skipped + 1)) ;;
      *) pending=$((pending + 1)) ;;
    esac
  done < "$STATE_FILE"

  echo "Total: $total | Completed: $completed | Failed: $failed | Skipped: $skipped | Pending: $pending"

  # Priority = sqrt(match*ease). Blocked listings have none, so they are
  # excluded from the average and reported separately.
  if (( score_count > 0 )); then
    local avg
    avg=$(echo "scale=2; $score_sum / $score_count" | bc 2>/dev/null || echo "N/A")
    echo "Average priority: $avg/10 ($score_count scored, $blocked_count blocked)"
  elif (( blocked_count > 0 )); then
    echo "Average priority: n/a (0 scored, $blocked_count blocked)"
  fi
}

# Main
main() {
  check_prerequisites

  if [[ "$DRY_RUN" == "false" ]]; then
    acquire_lock
  fi

  init_state

  # Count input offers (skip header, ignore blank lines)
  local total_input
  total_input=$(tail -n +2 "$INPUT_FILE" | grep -c '[^[:space:]]' 2>/dev/null || true)
  total_input="${total_input:-0}"

  if (( total_input == 0 )); then
    echo "No offers in $INPUT_FILE. Add offers first."
    exit 0
  fi

  echo "=== career-ops batch runner ==="
  echo "Parallel: $PARALLEL | Max retries: $MAX_RETRIES"
  echo "Input: $total_input offers"
  echo ""

  # Build list of offers to process
  local -a pending_ids=()
  local -a pending_urls=()
  local -a pending_sources=()
  local -a pending_notes=()

  while IFS=$'\t' read -r id url source notes; do
    [[ "$id" == "id" ]] && continue  # skip header
    [[ -z "$id" || -z "$url" ]] && continue

    # Guard against non-numeric id values
    [[ "$id" =~ ^[0-9]+$ ]] || continue

    # Skip if before start-from
    if (( id < START_FROM )); then
      continue
    fi

    local status
    status=$(get_status "$id")

    if [[ "$RETRY_FAILED" == "true" ]]; then
      # Only process failed offers
      if [[ "$status" != "failed" ]]; then
        continue
      fi
      # Check retry limit
      local retries
      retries=$(get_retries "$id")
      if (( retries >= MAX_RETRIES )); then
        echo "SKIP #$id: max retries ($MAX_RETRIES) reached"
        continue
      fi
    else
      # Skip completed offers
      if [[ "$status" == "completed" ]]; then
        continue
      fi
      # A closed posting or an already-evaluated duplicate has nothing to
      # retry; skipping on a score gate (below-min-score) is re-evaluated.
      if [[ "$status" == "skipped" ]]; then
        case "$(get_reason "$id")" in
          posting-closed|duplicate) continue ;;
        esac
      fi
      # Skip failed offers that hit retry limit (unless --retry-failed)
      if [[ "$status" == "failed" ]]; then
        local retries
        retries=$(get_retries "$id")
        if (( retries >= MAX_RETRIES )); then
          echo "SKIP #$id: failed and max retries reached (use --retry-failed to force)"
          continue
        fi
      fi
    fi

    pending_ids+=("$id")
    pending_urls+=("$url")
    pending_sources+=("$source")
    pending_notes+=("$notes")
  done < "$INPUT_FILE"

  local pending_count=${#pending_ids[@]}

  if (( pending_count == 0 )); then
    echo "No offers to process."
    print_summary
    exit 0
  fi

  echo "Pending: $pending_count offers"
  echo ""

  # Dry run: just list
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "=== DRY RUN (no processing) ==="
    for i in "${!pending_ids[@]}"; do
      local status
      status=$(get_status "${pending_ids[$i]}")
      echo "  #${pending_ids[$i]}: ${pending_urls[$i]} [${pending_sources[$i]}] (status: $status)"
    done
    echo ""
    echo "Would process $pending_count offers"
    exit 0
  fi

  # Process offers
  if (( PARALLEL <= 1 )); then
    # Sequential processing
    for i in "${!pending_ids[@]}"; do
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}"
    done
  else
    # Parallel processing with job control
    local running=0
    local -a pids=()
    local -a pid_ids=()

    for i in "${!pending_ids[@]}"; do
      # Wait if we're at parallel limit
      while (( running >= PARALLEL )); do
        # Wait for any child to finish
        for j in "${!pids[@]}"; do
          if ! kill -0 "${pids[$j]}" 2>/dev/null; then
            wait "${pids[$j]}" 2>/dev/null || true
            unset 'pids[j]'
            unset 'pid_ids[j]'
            running=$((running - 1))
          fi
        done
        # Compact arrays
        # ${arr[@]+...}: an empty array is "unbound" under set -u on macOS bash 3.2.
        pids=(${pids[@]+"${pids[@]}"})
        pid_ids=(${pid_ids[@]+"${pid_ids[@]}"})
        sleep 1
      done

      # Launch worker in background
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}" &
      pids+=($!)
      pid_ids+=("${pending_ids[$i]}")
      running=$((running + 1))
    done

    # Wait for remaining workers
    for pid in ${pids[@]+"${pids[@]}"}; do
      wait "$pid" 2>/dev/null || true
    done
  fi

  # Merge tracker additions
  merge_tracker

  # Print summary
  print_summary
}

main "$@"

# Batch Processing

Process multiple job listings in parallel via `claude -p` workers. Each worker runs a **scouting evaluation** (the same Dimensional Scoring Framework as interactive mode — see `batch-prompt.md`): dimensional scores via `scripts/score-listing.mjs`, a tiered report, a scouting TSV, and a `data/score-history.tsv` row. Evaluation never generates PDFs — CV tailoring is the separate `pdf` skill.

Workers read `batch/cv-summary.md` — a compact, deterministically-generated summary of the user's CV — instead of the full `user/cv.md`. The runner refreshes it before spawning (`node scripts/cv-summary.mjs --if-stale`); it's gitignored derived data, safe to delete, and `batch-prompt.md` documents the fallback to `user/cv.md` when it's missing. The same prompt bundle also powers the desktop app's per-listing eval spawns (see `frontend/src/lib/evalSpawn.ts`), which pass it verbatim via `--append-system-prompt-file` — hence the "Unresolved placeholders" note in `batch-prompt.md`.

## Quick Start

1. **Add offers** to `batch-input.tsv` (tab-separated: `id`, `url`, `source`, `notes`):

   ```tsv
   id	url	source	notes
   1	https://jobs.example.com/role-a	LinkedIn	
   2	https://greenhouse.io/company/role-b	Greenhouse	priority
   ```

   Tip: `node scripts/triage-pipeline.mjs --emit-batch` generates this file from the top-ranked pending URLs in `data/pipeline.md` (zero-token triage).

2. **Dry run** to preview what will be processed:

   ```bash
   ./batch/batch-runner.sh --dry-run
   ```

3. **Run the batch**:

   ```bash
   ./batch/batch-runner.sh
   ```

4. **Results** are merged into `data/scouting.md` (via `scripts/merge-scouting.mjs`) and verified with `scripts/verify-pipeline.mjs` at the end of the run.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--parallel N` | `1` | Number of concurrent `claude -p` workers |
| `--dry-run` | off | Preview pending offers without processing |
| `--retry-failed` | off | Only retry offers marked as `failed` in state |
| `--start-from N` | `0` | Skip offers with ID below N |
| `--max-retries N` | `2` | Max retry attempts per offer before giving up |
| `--min-score N` | `0` (off) | Mark offers scoring below N as `skipped` in state |

## Directory Layout

```
batch/
  batch-runner.sh          # Orchestrator script
  batch-prompt.md          # Compact worker prompt (parity-tested against modes/_shared.md)
  batch-input.tsv          # Input offers (you create this, or triage-pipeline.mjs does)
  batch-state.tsv          # Processing state (auto-managed, resumable)
  logs/                    # Per-offer worker logs ({report_num}-{id}.log)
  logs/usage.tsv           # Per-spawn token/cost accounting (auto-appended)
  scouting-additions/      # Scouting TSV lines produced by workers
  tracker-additions/       # Application-flow TSVs (legacy/manual; usually empty)
```

## How It Works

1. **batch-runner.sh** reads `batch-input.tsv` and `batch-state.tsv` to determine which offers need processing.
2. For each pending offer, it assigns a report number and launches a `claude -p --output-format json` worker with `batch-prompt.md` as the system prompt (placeholders like `{{URL}}`, `{{ID}}` resolved).
3. Each worker scores the listing (judgment dims → `scripts/score-listing.mjs` for the math), writes a report to `reports/tier-{N}/{Company} - {Role}.md`, appends a `data/score-history.tsv` row, and drops a scouting TSV in `scouting-additions/`.
4. The runner parses each worker's final result event (`scripts/parse-batch-result.mjs`) for the score and token usage, appending one accounting row per spawn to `logs/usage.tsv`.
5. After all workers finish, the runner calls `scripts/merge-scouting.mjs` (and `merge-tracker.mjs` for any application-flow TSVs), then `scripts/verify-pipeline.mjs`.

## Token accounting

`logs/usage.tsv` records per-spawn `input_tokens`, `cache_creation_tokens`, `cache_read_tokens`, `output_tokens`, `cost_usd`, `duration_ms`, and `num_turns` — the measurement baseline for the token-cost reduction project in `TODO.md`. Column order is defined in `scripts/lib/batch-usage.mjs`.

## Prompt drift protection

`batch-prompt.md` is a compact copy of the evaluation pipeline. Structural agreement with `modes/_shared.md` (score-history header, dimension names, calibration constants, banned legacy content) is pinned by `scripts/batch-prompt-parity.test.mjs` — `npm test` fails if either file changes incompatibly. The runner additionally refuses to start on a `scoring-version` stamp mismatch.

## Resumability

`batch-state.tsv` tracks the status of every offer (`pending`, `processing`, `completed`, `skipped`, `failed`). If the batch is interrupted, re-running `batch-runner.sh` picks up where it left off — completed offers are skipped automatically.

A PID-based lock file (`batch-runner.pid`) prevents concurrent batch runs. If a previous run crashed, the stale lock is detected and removed automatically.

## Prerequisites

- `claude` CLI in PATH (Claude Max subscription for default model)
- Node.js >= 18
- `batch-input.tsv` with at least one offer

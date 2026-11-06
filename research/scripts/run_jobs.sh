#!/bin/bash
# Runs benchmark jobs in parallel at low priority, one JSON result line per job.
# Usage: run_jobs.sh <jobsFile> <parallel> <outFile>
# Each line of the jobs file is the argument list for expert_check.js after bpDir and dataDir.
set -u
ROOT=/home/ubuntu/test/poker-ai
JOBS=$1; PAR=${2:-3}; OUT=$3
cd "$ROOT/repo/research/bench"
DATA=${DATA:-$ROOT/data}
export OUT ROOT DATA
xargs -P "$PAR" -I{} bash -c 'r=$(nice -n 5 "$ROOT/.tools/node/bin/node" expert_check.js "$ROOT/exports" "${DATA:-$ROOT/data}" {} 2>>"$OUT.err"); [ -n "$r" ] && echo "$r" >> "$OUT"' < "$JOBS"
echo "DONE $(date -u +%FT%TZ)" >> "$OUT.done"

#!/bin/bash
# Slumbot rematch with the longer-trained 200bb blueprint. Waits for deep_long.sh to export it, then plays
# several sessions in parallel, each one request at a time. A session that drops (an expired token, a
# network error) restarts and resumes from its own log, because slumbot.js skips hands already recorded.
#
# Usage: slumbot_rematch.sh <sessions> <handsPerSession> <turnIters> <riverIters> <tag>
set -u
SESS=${1:-3}; HANDS=${2:-2000}; T=${3:-300}; RV=${4:-600}; TAG=${5:-new}
R=/home/ubuntu/test/poker-ai
cd "$R"
until grep -q "done depth=200bb" logs/deep_long.log; do sleep 60; done
BP=$R/bp_slumbot_$TAG
OUT=$R/results/slumbot2
mkdir -p "$BP" "$OUT"
cp exports/long/bp_200.bin "$BP/"
source ~/.nvm/nvm.sh > /dev/null
cd repo/research/bench
for s in $(seq 1 "$SESS"); do
  (
    for try in $(seq 1 30); do
      nice -n 15 node slumbot.js "$BP" "$R/data_deep" "$HANDS" "$T" "$RV" "$OUT/${TAG}_s$s.jsonl" $((s + 10)) >> "$OUT/${TAG}_s$s.log" 2>&1 && break
      echo "$(date -u +%FT%TZ) session $s exited, restarting ($try)" >> "$OUT/${TAG}_s$s.log"
      sleep 60
    done
  ) &
done
wait
echo "$(date -u +%FT%TZ) rematch $TAG finished" >> "$R/logs/deep_long.log"

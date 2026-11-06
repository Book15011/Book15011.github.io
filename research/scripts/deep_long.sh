#!/bin/bash
# Second training stage for the deep stacks: continues each blueprint from its first-run checkpoint
# for several more hours, then exports it, re-measures convergence, and plays it against the old one.
# The first-run checkpoints in ckpt/final are left untouched, so old and new can be compared.
#
# Usage: DATA=<abstractionDir> deep_long.sh <threads> "<depth>:<minutes> ..."
set -u
cd /home/ubuntu/test/poker-ai
THREADS=${1:-12}
PLAN=${2:-"200:360 100:300 50:150"}
DATA=${DATA:-data_deep}
IN=ckpt/final
OUT=ckpt/long
EXP=exports/long
mkdir -p "$OUT" "$EXP" logs
for item in $PLAN; do
  d=${item%%:*}; m=${item##*:}
  echo "$(date -u +%FT%TZ) resume depth=${d}bb minutes=${m} data=${DATA}" >> logs/deep_long.log
  if ! nice -n 10 ./trainer/train resume "$d" "$DATA" "$IN/d${d}.final" "$OUT" "$THREADS" "$m" 7 > "logs/long_d${d}.log" 2>&1; then
    echo "$(date -u +%FT%TZ) FAILED depth=${d}bb" >> logs/deep_long.log
    continue
  fi
  nice -n 10 ./trainer/train export "$d" "$DATA" "$OUT/d${d}.final" "$EXP/bp_${d}.bin" >> "logs/long_d${d}.log" 2>&1
  nice -n 10 ./trainer/train export "$d" "$DATA" "$OUT/d${d}.final" "$EXP/bp_${d}_full.bin" full >> "logs/long_d${d}.log" 2>&1
  gzip -9 -k -f "$EXP/bp_${d}.bin"
  nice -n 10 ./trainer/train br "$d" "$DATA" "$OUT/d${d}.final" "$THREADS" 40000000 > "logs/long_br_d${d}.log" 2>&1
  # Duplicate head-to-head inside the abstract game: new blueprint (A) against the first-run one (B).
  nice -n 10 ./trainer/train h2h "$d" "$DATA" "$OUT/d${d}.final" "$IN/d${d}.final" "$THREADS" 40000000 > "logs/long_h2h_d${d}.log" 2>&1
  rm -f "$OUT/d${d}.ckpt"
  echo "$(date -u +%FT%TZ) done depth=${d}bb $(tail -1 logs/long_br_d${d}.log) | $(tail -1 logs/long_h2h_d${d}.log)" >> logs/deep_long.log
done
echo "$(date -u +%FT%TZ) ALL DONE $PLAN" >> logs/deep_long.log

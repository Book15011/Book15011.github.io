#!/bin/bash
# Trains one blueprint per stack depth, one after another, on a shared machine.
# Uses 12 of the 16 cores at low priority and never touches the GPU.
#
# Usage: DATA=<abstractionDir> train_all.sh <threads> "<depth>:<minutes> ..."
set -u
cd /home/ubuntu/test/poker-ai
THREADS=${1:-12}
PLAN=${2:-"20:30 12:15 8:8 5:5 30:30"}
DATA=${DATA:-data}
OUT=ckpt/final
mkdir -p "$OUT" exports logs
for item in $PLAN; do
  d=${item%%:*}; m=${item##*:}
  echo "$(date -u +%FT%TZ) start depth=${d}bb minutes=${m} data=${DATA}" >> logs/train_all.log
  nice -n 10 ./trainer/train run "$d" "$DATA" "$OUT" "$THREADS" "$m" 1 > "logs/train_d${d}.log" 2>&1
  nice -n 10 ./trainer/train export "$d" "$DATA" "$OUT/d${d}.final" "exports/bp_${d}.bin" >> "logs/train_d${d}.log" 2>&1
  nice -n 10 ./trainer/train export "$d" "$DATA" "$OUT/d${d}.final" "exports/bp_${d}_full.bin" full >> "logs/train_d${d}.log" 2>&1
  nice -n 10 ./trainer/train br "$d" "$DATA" "$OUT/d${d}.final" "$THREADS" 40000000 >> "logs/br_d${d}.log" 2>&1
  rm -f "$OUT/d${d}.ckpt"
  gzip -9 -k -f "exports/bp_${d}.bin"
  echo "$(date -u +%FT%TZ) done depth=${d}bb $(tail -1 logs/br_d${d}.log)" >> logs/train_all.log
done
echo "$(date -u +%FT%TZ) ALL DONE $PLAN" >> logs/train_all.log

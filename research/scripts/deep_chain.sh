#!/bin/bash
# After the short-stack queue finishes, train the deep stacks on a coarser abstraction (same flop table).
# Deep trees are about 10x larger, so finer turn and river buckets would stay under-sampled in the time available.
R=/home/ubuntu/test/poker-ai
cd "$R"
mkdir -p data_deep
nice -n 10 ./trainer/abstract gen 2000 1000 1000 8 data_deep > logs/abstract_deep.log 2>&1
cmp data/buckets_flop.u16 data_deep/buckets_flop.u16 && echo "flop tables identical" >> logs/train_all.log
until grep -q "done depth=30bb" logs/train_all.log; do sleep 20; done
pkill -f "[t]rain_all.sh" || true
pkill -f "[c]hain200.sh" || true
sleep 2
DATA=data_deep bash repo/research/scripts/train_all.sh 12 "50:45 100:60 200:60"

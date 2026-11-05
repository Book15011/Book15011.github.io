#!/bin/bash
# Compiles the solver core to WebAssembly with SIMD. Needs: pip install ziglang
set -e
PY=${PYTHON:-python3}
cd "$(dirname "$0")"
$PY -m ziglang cc -target wasm32-freestanding -O3 -msimd128 -mbulk-memory -ffast-math -nostdlib \
  -Wl,--no-entry -Wl,--export-dynamic -Wl,--initial-memory=33554432 -Wl,--max-memory=1073741824 \
  -o solver.wasm solver.c
ls -la solver.wasm

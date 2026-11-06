// Node-side model loading for offline benchmarks. The browser uses poker/js/ai/models.js instead.
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Blueprint } from '../../poker/js/ai/blueprint.js';
import { BucketTable } from '../../poker/js/ai/hands.js';

const toArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

export function loadBlueprint(path) {
  let raw = readFileSync(path);
  if (path.endsWith('.gz')) raw = gunzipSync(raw);
  return new Blueprint(toArrayBuffer(raw));
}

export function loadBucketTable(path, boardCards) {
  let raw = readFileSync(path);
  if (path.endsWith('.gz')) raw = gunzipSync(raw);
  return new BucketTable(boardCards, new Uint16Array(toArrayBuffer(raw)));
}

/** Bucket provider for the given streets. @param {string} dir @param {number} maxStreet 1 = flop only, 3 = all streets */
export function loadBuckets(dir, maxStreet) {
  const names = { 1: ['flop', 3], 2: ['turn', 4], 3: ['river', 5] };
  const tables = {};
  for (let s = 1; s <= maxStreet; s++) {
    const [n, cards] = names[s];
    const p = `${dir}/buckets_${n}.u16`;
    if (!existsSync(p)) throw new Error(`missing ${p}`);
    tables[s] = loadBucketTable(p, cards);
  }
  return (street, board, out) => {
    const t = tables[street];
    if (!t) return false;
    t.fill(board, out);
    return true;
  };
}

// Confirms the browser's bucket lookup agrees with the trainer's, on samples printed by dump_buckets.
// node check_buckets.js <samples.txt> <flop_buckets.bin.gz>
import { readFileSync } from 'node:fs';
import { loadBucketTable } from './node_models.js';
import { pairIdx } from '../../poker/js/ai/hands.js';

const [samples, table] = process.argv.slice(2);
const t = loadBucketTable(table, 3);
const out = new Int16Array(1326);
let n = 0, wrong = 0;
for (const line of readFileSync(samples, 'utf8').trim().split('\n')) {
  const [a, b, f1, f2, f3, bucket] = line.split(' ').map(Number);
  t.fill([f1, f2, f3], out);
  n++;
  if (out[pairIdx(a, b)] !== bucket) wrong++;
}
console.log(`${n} samples, ${wrong} mismatches`);
process.exit(wrong ? 1 : 0);

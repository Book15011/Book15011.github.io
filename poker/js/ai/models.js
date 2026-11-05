// @ts-check
/** Browser-side model loading. Everything is lazy: nothing downloads until a game that needs it starts. */
import { Blueprint } from './blueprint.js';
import { BucketTable } from './hands.js';
import { loadSolverCore } from './solver.js';
import { nearestDepth } from './expert.js';

const MODELS_URL = new URL('../../models/', import.meta.url);

/** @param {string} name */
async function fetchGz(name) {
  const res = await fetch(new URL(name, MODELS_URL));
  if (!res.ok) throw new Error(`Could not load ${name}: HTTP ${res.status}`);
  const stream = /** @type {ReadableStream<Uint8Array>} */ (res.body).pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

export class ModelStore {
  constructor() {
    /** @type {Map<number, Blueprint>} */
    this.blueprints = new Map();
    /** @type {BucketTable|null} */
    this.flop = null;
    this.core = null;
    this.depths = /** @type {number[]} */ ([]); // stack depths with a trained blueprint, from the manifest
  }

  /** The flop bucket table and solver core. */
  async loadShared() {
    const [manifest, tableBuf, wasm] = await Promise.all([
      fetch(new URL('manifest.json', MODELS_URL)).then((r) => { if (!r.ok) throw new Error('Could not load the model manifest'); return r.json(); }),
      fetchGz('flop_buckets.bin.gz'),
      fetch(new URL('../ai/solver.wasm', import.meta.url)).then((r) => { if (!r.ok) throw new Error('Could not load solver.wasm'); return r.arrayBuffer(); }),
    ]);
    this.depths = manifest.depths;
    this.flop = new BucketTable(3, new Uint16Array(tableBuf));
    this.core = await loadSolverCore(wasm);
  }

  /** @param {number} depth */
  async loadDepth(depth) {
    if (this.blueprints.has(depth)) return this.blueprints.get(depth);
    const bp = new Blueprint(await fetchGz(`bp_${depth}.bin.gz`));
    this.blueprints.set(depth, bp);
    return bp;
  }

  /** Ensure the table for this effective stack is loaded. @param {number} effectiveBB */
  ensure(effectiveBB) { return this.loadDepth(nearestDepth(this.depths, effectiveBB)); }

  /** @param {number} effectiveBB Returns the nearest table already in memory. */
  blueprintFor(effectiveBB) {
    const have = [...this.blueprints.keys()];
    if (!have.length) throw new Error('No blueprint loaded');
    return /** @type {Blueprint} */ (this.blueprints.get(nearestDepth(have, effectiveBB)));
  }

  /** @param {number} street @param {number[]} board @param {Int16Array} out */
  bucketsFor(street, board, out) {
    if (street !== 1 || !this.flop) return false;
    this.flop.fill(board, out);
    return true;
  }
}

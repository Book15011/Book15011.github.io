// Prints random (hole cards, flop, bucket) samples, using the trainer's own lookup. The JavaScript lookup
// is compared against these in research/bench/check_buckets.js. A mismatch would silently degrade the AI.
#include <string>

#include "poker.h"
using namespace poker;

int main(int argc, char** argv) {
  initAll();
  std::string dir = argv[1];
  int n = atoi(argv[2]);
  BoardMap flop;
  flop.build(3);
  std::vector<uint16_t> t((size_t)flop.numCanon * NUM_HANDS);
  FILE* f = fopen((dir + "/buckets_flop.u16").c_str(), "rb");
  if (!f || fread(t.data(), 2, t.size(), f) != t.size()) return 1;
  fclose(f);
  Xorshift rng(4242);
  for (int i = 0; i < n; i++) {
    int c[5], used = 0;
    uint64_t seen = 0;
    while (used < 5) {
      int x = rng.below(52);
      if ((seen >> x) & 1) continue;
      seen |= 1ULL << x;
      c[used++] = x;
    }
    int b[3] = {c[2], c[3], c[4]};
    std::sort(b, b + 3);
    int rank = colexRank(b, 3), p = flop.perm[rank];
    int bucket = t[(size_t)flop.id[rank] * NUM_HANDS + pairIdx(PERM_CARD[p][c[0]], PERM_CARD[p][c[1]])];
    printf("%d %d %d %d %d %d\n", c[0], c[1], c[2], c[3], c[4], bucket);
  }
  return 0;
}

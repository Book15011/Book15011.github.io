// Shared poker primitives for the offline trainer.
// Card encoding and the hand-score formula are identical to poker/js/engine/evaluator.js.
#pragma once
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace poker {

inline int8_t STRAIGHT_HIGH[8192], HIGHBIT[8192], POP[8192];
inline int32_t TOP5[8192];

inline void initEval() {
  for (int m = 1; m < 8192; m++) {
    int hb = 12;
    while (!((m >> hb) & 1)) hb--;
    HIGHBIT[m] = hb;
    POP[m] = POP[m >> 1] + (m & 1);
    STRAIGHT_HIGH[m] = 0;
    for (int h = 12; h >= 4; h--)
      if (((m >> (h - 4)) & 31) == 31) { STRAIGHT_HIGH[m] = h + 1; break; }
    if (!STRAIGHT_HIGH[m] && (m & 0x100F) == 0x100F) STRAIGHT_HIGH[m] = 4;
    int packed = 0, left = m;
    for (int i = 0; i < 5; i++)
      if (left) { int b = HIGHBIT[left]; packed |= b << (16 - 4 * i); left &= ~(1 << b); }
    TOP5[m] = packed;
  }
}

inline int scoreMasks(int c, int d, int h, int s) {
  int fl = 0;
  if (POP[c] >= 5) fl = c; else if (POP[d] >= 5) fl = d; else if (POP[h] >= 5) fl = h; else if (POP[s] >= 5) fl = s;
  if (fl) {
    int sh = STRAIGHT_HIGH[fl];
    if (sh) return (8 << 20) | ((sh - 1) << 16);
    return (5 << 20) | TOP5[fl];
  }
  int all = c | d | h | s;
  int two = (c & d) | (c & h) | (c & s) | (d & h) | (d & s) | (h & s);
  if (!two) {
    int sh = STRAIGHT_HIGH[all];
    if (sh) return (4 << 20) | ((sh - 1) << 16);
    return TOP5[all];
  }
  int three = ((c & d) & (h | s)) | ((h & s) & (c | d));
  if (three) {
    int quads = c & d & h & s;
    if (quads) {
      int q = HIGHBIT[quads];
      return (7 << 20) | (q << 16) | (HIGHBIT[all & ~(1 << q)] << 12);
    }
    int t = HIGHBIT[three];
    int rest = two & ~(1 << t);
    if (rest) return (6 << 20) | (t << 16) | (HIGHBIT[rest] << 12);
    int sh = STRAIGHT_HIGH[all];
    if (sh) return (4 << 20) | ((sh - 1) << 16);
    int k = all & ~(1 << t);
    int k1 = HIGHBIT[k];
    return (3 << 20) | (t << 16) | (k1 << 12) | (HIGHBIT[k & ~(1 << k1)] << 8);
  }
  int sh = STRAIGHT_HIGH[all];
  if (sh) return (4 << 20) | ((sh - 1) << 16);
  int p1 = HIGHBIT[two];
  int others = two & ~(1 << p1);
  if (others) {
    int p2 = HIGHBIT[others];
    return (2 << 20) | (p1 << 16) | (p2 << 12) | (HIGHBIT[all & ~(1 << p1) & ~(1 << p2)] << 8);
  }
  int k = all & ~(1 << p1);
  int k1 = HIGHBIT[k], m2 = k & ~(1 << k1);
  int k2 = HIGHBIT[m2], m3 = m2 & ~(1 << k2);
  return (1 << 20) | (p1 << 16) | (k1 << 12) | (k2 << 8) | (HIGHBIT[m3] << 4);
}

inline int evalCards(const int* cards, int n) {
  int m[4] = {0, 0, 0, 0};
  for (int i = 0; i < n; i++) m[cards[i] & 3] |= 1 << (cards[i] >> 2);
  return scoreMasks(m[0], m[1], m[2], m[3]);
}

// ----- Hand and board indexing -----
constexpr int NUM_HANDS = 1326;
inline int pairIdx(int a, int b) {
  if (a > b) std::swap(a, b);
  return b * (b - 1) / 2 + a;
}
inline int16_t HAND_A[NUM_HANDS], HAND_B[NUM_HANDS]; // hand index -> cards
inline int16_t PRE169[NUM_HANDS];                    // hand index -> canonical starting hand (0..168)
inline int64_t BINOM[53][8];

inline void initIndex() {
  for (int n = 0; n <= 52; n++) {
    BINOM[n][0] = 1;
    for (int k = 1; k < 8; k++) BINOM[n][k] = n == 0 ? 0 : BINOM[n - 1][k - 1] + BINOM[n - 1][k];
  }
  for (int b = 1; b < 52; b++)
    for (int a = 0; a < b; a++) {
      int i = pairIdx(a, b);
      HAND_A[i] = a; HAND_B[i] = b;
      int ra = a >> 2, rb = b >> 2;
      int hi = std::max(ra, rb), lo = std::min(ra, rb);
      // Row hi, column lo: suited above the diagonal, offsuit below, pairs on it.
      PRE169[i] = (a & 3) == (b & 3) ? hi * 13 + lo : (hi == lo ? hi * 13 + hi : lo * 13 + hi);
    }
  // Compress 13x13 ids to a dense 0..168 (they already are distinct in 0..168).
}

inline int colexRank(const int* sorted, int n) {
  int r = 0;
  for (int i = 0; i < n; i++) r += (int)BINOM[sorted[i]][i + 1];
  return r;
}

inline uint8_t SUIT_PERMS[24][4];
inline uint8_t PERM_CARD[24][52];

inline void initPerms() {
  int p[4] = {0, 1, 2, 3}, n = 0;
  do {
    for (int i = 0; i < 4; i++) SUIT_PERMS[n][i] = p[i];
    for (int c = 0; c < 52; c++) PERM_CARD[n][c] = (c & ~3) | p[c & 3];
    n++;
  } while (std::next_permutation(p, p + 4));
}

// Maps every n-card board to a canonical representative under suit relabelling.
struct BoardMap {
  int n = 0, numCanon = 0;
  std::vector<int32_t> id;           // colex rank -> canonical id
  std::vector<uint8_t> perm;         // colex rank -> suit permutation taking it to the canonical form
  std::vector<std::array<uint8_t, 5>> canon; // canonical id -> sorted cards

  void build(int n_) {
    n = n_;
    int64_t total = BINOM[52][n];
    id.assign(total, -1);
    perm.assign(total, 0);
    int c[5];
    std::vector<int32_t> canonId(total, -1);
    enumerate(c, 0, 0, canonId);
    fprintf(stderr, "boards(%d): %lld total, %d canonical\n", n, (long long)total, numCanon);
  }

 private:
  void enumerate(int* c, int depth, int start, std::vector<int32_t>& canonId) {
    if (depth == n) {
      int rank = colexRank(c, n);
      int best[5], bestP = -1, t[5];
      for (int p = 0; p < 24; p++) {
        for (int i = 0; i < n; i++) t[i] = PERM_CARD[p][c[i]];
        std::sort(t, t + n);
        bool less = bestP < 0;
        if (!less)
          for (int i = 0; i < n; i++) {
            if (t[i] != best[i]) { less = t[i] < best[i]; break; }
          }
        if (less) { bestP = p; std::copy(t, t + n, best); }
      }
      int cr = colexRank(best, n);
      if (canonId[cr] < 0) {
        canonId[cr] = numCanon++;
        std::array<uint8_t, 5> arr{};
        for (int i = 0; i < n; i++) arr[i] = best[i];
        canon.push_back(arr);
      }
      id[rank] = canonId[cr];
      perm[rank] = bestP;
      return;
    }
    for (int x = start; x < 52; x++) { c[depth] = x; enumerate(c, depth + 1, x + 1, canonId); }
  }
};

struct Xorshift {
  uint64_t s;
  explicit Xorshift(uint64_t seed) : s(seed * 0x9E3779B97F4A7C15ULL + 0x1234567ULL) { if (!s) s = 88172645463325252ULL; }
  inline uint64_t next() { s ^= s << 7; s ^= s >> 9; return s; }
  inline uint32_t below(uint32_t n) { return (uint32_t)(((next() >> 32) * (uint64_t)n) >> 32); }
  inline float unit() { return (float)(next() >> 40) * (1.0f / 16777216.0f); }
};

inline void initAll() { initEval(); initIndex(); initPerms(); }

}  // namespace poker

// Card abstraction generator (imperfect recall, k-means).
//
//   flop, turn : histogram of final-river equity against a uniform random hand, compared as a CDF
//                (L2 on the CDF stands in for earth mover's distance, Johanson et al. 2013).
//   river      : equity against 8 opponent-hand clusters plus overall equity (OCHS, same paper).
//
// Output: data/buckets_{flop,turn,river}.u16, indexed [canonicalBoardId][handIndex].
//
// Usage: abstract check | abstract gen <flopK> <turnK> <riverK> <threads> <outDir>
#include <atomic>
#include <cmath>
#include <random>
#include <string>
#include <thread>

#include "poker.h"
using namespace poker;

static constexpr int HIST_BINS = 20;
static constexpr int OCHS = 8;

struct RiverPass {
  int order[NUM_HANDS], n = 0;
  uint64_t keys[NUM_HANDS];
  float eq[NUM_HANDS];
  float ochs[NUM_HANDS][OCHS];
};

static int8_t OCHS_GROUP[NUM_HANDS];

// Equity of every hand against a uniform random opposing hand on a complete board.
// Sorting by score lets one sweep handle card removal in O(n).
template <bool WITH_OCHS>
static void riverPass(const int* board, RiverPass& R) {
  uint64_t bm = 0;
  int m[4] = {0, 0, 0, 0};
  for (int i = 0; i < 5; i++) { bm |= 1ULL << board[i]; m[board[i] & 3] |= 1 << (board[i] >> 2); }
  int n = 0;
  for (int h = 0; h < NUM_HANDS; h++) {
    int a = HAND_A[h], b = HAND_B[h];
    if ((bm >> a) & 1 || (bm >> b) & 1) continue;
    int s[4] = {m[0], m[1], m[2], m[3]};
    s[a & 3] |= 1 << (a >> 2);
    s[b & 3] |= 1 << (b >> 2);
    R.keys[n++] = ((uint64_t)scoreMasks(s[0], s[1], s[2], s[3]) << 16) | h;
  }
  std::sort(R.keys, R.keys + n);
  R.n = n;
  int lower = 0, cardLower[52] = {0};
  int lowerG[OCHS] = {0}, cardLowerG[OCHS][52];
  int totalG[OCHS] = {0}, cardTotalG[OCHS][52];
  if constexpr (WITH_OCHS) {
    memset(cardLowerG, 0, sizeof(cardLowerG));
    memset(cardTotalG, 0, sizeof(cardTotalG));
    for (int i = 0; i < n; i++) {
      int h = (int)(R.keys[i] & 0xFFFF), g = OCHS_GROUP[h];
      totalG[g]++; cardTotalG[g][HAND_A[h]]++; cardTotalG[g][HAND_B[h]]++;
    }
  }
  const float denom = 990.0f;
  for (int i = 0; i < n;) {
    int j = i;
    uint64_t sc = R.keys[i] >> 16;
    int tie = 0, cardTie[52];
    int tieG[OCHS], cardTieG[OCHS][52];
    memset(cardTie, 0, sizeof(cardTie));
    if constexpr (WITH_OCHS) { memset(tieG, 0, sizeof(tieG)); memset(cardTieG, 0, sizeof(cardTieG)); }
    while (j < n && (R.keys[j] >> 16) == sc) {
      int h = (int)(R.keys[j] & 0xFFFF), a = HAND_A[h], b = HAND_B[h];
      tie++; cardTie[a]++; cardTie[b]++;
      if constexpr (WITH_OCHS) { int g = OCHS_GROUP[h]; tieG[g]++; cardTieG[g][a]++; cardTieG[g][b]++; }
      j++;
    }
    for (int k = i; k < j; k++) {
      int h = (int)(R.keys[k] & 0xFFFF), a = HAND_A[h], b = HAND_B[h];
      int wins = lower - cardLower[a] - cardLower[b];
      int ties = tie - cardTie[a] - cardTie[b] + 1;
      R.eq[h] = (wins + 0.5f * ties) / denom;
      if constexpr (WITH_OCHS) {
        for (int g = 0; g < OCHS; g++) {
          int self = OCHS_GROUP[h] == g ? 1 : 0;
          int w = lowerG[g] - cardLowerG[g][a] - cardLowerG[g][b];
          int t = tieG[g] - cardTieG[g][a] - cardTieG[g][b] + self;
          int tot = totalG[g] - cardTotalG[g][a] - cardTotalG[g][b] + self;
          R.ochs[h][g] = tot > 0 ? (w + 0.5f * t) / tot : 0.5f;
        }
      }
    }
    for (int k = i; k < j; k++) {
      int h = (int)(R.keys[k] & 0xFFFF), a = HAND_A[h], b = HAND_B[h];
      lower++; cardLower[a]++; cardLower[b]++;
      if constexpr (WITH_OCHS) { int g = OCHS_GROUP[h]; lowerG[g]++; cardLowerG[g][a]++; cardLowerG[g][b]++; }
    }
    i = j;
  }
}

// Features for all hands on one canonical board. dims = HIST_BINS (flop, turn) or OCHS + 1 (river).
static void boardFeatures(const uint8_t* canon, int boardCards, float* out, int dims, std::vector<int>& validHands, RiverPass& R) {
  int board[5];
  uint64_t bm = 0;
  for (int i = 0; i < boardCards; i++) { board[i] = canon[i]; bm |= 1ULL << board[i]; }
  validHands.clear();
  for (int h = 0; h < NUM_HANDS; h++)
    if (!((bm >> HAND_A[h]) & 1) && !((bm >> HAND_B[h]) & 1)) validHands.push_back(h);

  if (boardCards == 5) {
    riverPass<true>(board, R);
    for (int v = 0; v < (int)validHands.size(); v++) {
      int h = validHands[v];
      float* f = out + v * dims;
      f[0] = R.eq[h] * 1.5f; // overall equity carries extra weight
      for (int g = 0; g < OCHS; g++) f[g + 1] = R.ochs[h][g];
    }
    return;
  }
  std::vector<std::array<int, HIST_BINS>> hist(NUM_HANDS);
  for (auto& x : hist) x.fill(0);
  auto addRun = [&]() {
    riverPass<false>(board, R);
    uint64_t rm = 0;
    for (int i = 0; i < 5; i++) rm |= 1ULL << board[i];
    for (int h : validHands) {
      if ((rm >> HAND_A[h]) & 1 || (rm >> HAND_B[h]) & 1) continue;
      int bin = std::min(HIST_BINS - 1, (int)(R.eq[h] * HIST_BINS));
      hist[h][bin]++;
    }
  };
  if (boardCards == 4) {
    for (int r = 0; r < 52; r++) {
      if ((bm >> r) & 1) continue;
      board[4] = r;
      addRun();
    }
  } else {
    for (int t = 0; t < 52; t++) {
      if ((bm >> t) & 1) continue;
      board[3] = t;
      for (int r = t + 1; r < 52; r++) {
        if ((bm >> r) & 1) continue;
        board[4] = r;
        addRun();
      }
    }
  }
  for (int v = 0; v < (int)validHands.size(); v++) {
    int h = validHands[v], tot = 0;
    float* f = out + v * dims;
    for (int b = 0; b < HIST_BINS; b++) tot += hist[h][b];
    float cum = 0;
    for (int b = 0; b < HIST_BINS; b++) { cum += (float)hist[h][b] / tot; f[b] = cum; }
  }
}

static inline float dist2(const float* a, const float* b, int d) {
  float s = 0;
  for (int i = 0; i < d; i++) { float x = a[i] - b[i]; s += x * x; }
  return s;
}

static inline int nearest(const float* p, const std::vector<float>& C, int k, int d) {
  int best = 0;
  float bd = 1e30f;
  for (int i = 0; i < k; i++) {
    float x = dist2(p, &C[i * d], d);
    if (x < bd) { bd = x; best = i; }
  }
  return best;
}

template <class F>
static void parallelFor(int n, int threads, F fn) {
  std::atomic<int> next{0};
  std::vector<std::thread> ts;
  for (int t = 0; t < threads; t++)
    ts.emplace_back([&, t]() {
      for (;;) {
        int i = next.fetch_add(1);
        if (i >= n) break;
        fn(i, t);
      }
    });
  for (auto& t : ts) t.join();
}

static std::vector<float> kmeans(const std::vector<float>& pts, int d, int k, int iters, int threads, uint64_t seed) {
  int n = (int)(pts.size() / d);
  std::mt19937_64 rng(seed);
  std::vector<float> C(k * d);
  // k-means++ seeding on a subsample.
  int sub = std::min(n, 60000);
  std::vector<int> subIdx(sub);
  for (int i = 0; i < sub; i++) subIdx[i] = (int)(rng() % n);
  std::vector<float> D(sub, 1e30f);
  int first = subIdx[rng() % sub];
  std::copy(&pts[first * d], &pts[first * d] + d, &C[0]);
  for (int c = 1; c < k; c++) {
    double total = 0;
    for (int i = 0; i < sub; i++) {
      float x = dist2(&pts[subIdx[i] * d], &C[(c - 1) * d], d);
      if (x < D[i]) D[i] = x;
      total += D[i];
    }
    double r = std::uniform_real_distribution<double>(0, total)(rng);
    int pick = sub - 1;
    for (int i = 0; i < sub; i++) { r -= D[i]; if (r <= 0) { pick = i; break; } }
    std::copy(&pts[subIdx[pick] * d], &pts[subIdx[pick] * d] + d, &C[c * d]);
  }
  std::vector<int> assign(n, 0);
  for (int it = 0; it < iters; it++) {
    std::atomic<double> sse{0};
    int chunk = 4096, chunks = (n + chunk - 1) / chunk;
    parallelFor(chunks, threads, [&](int ci, int) {
      double e = 0;
      for (int i = ci * chunk; i < std::min(n, (ci + 1) * chunk); i++) {
        assign[i] = nearest(&pts[i * d], C, k, d);
        e += dist2(&pts[i * d], &C[assign[i] * d], d);
      }
      double cur = sse.load();
      while (!sse.compare_exchange_weak(cur, cur + e)) {}
    });
    std::vector<double> sum(k * d, 0.0);
    std::vector<int> cnt(k, 0);
    for (int i = 0; i < n; i++) {
      cnt[assign[i]]++;
      for (int j = 0; j < d; j++) sum[assign[i] * d + j] += pts[i * d + j];
    }
    int empty = 0;
    for (int c = 0; c < k; c++) {
      if (!cnt[c]) { // reseed an empty cluster at a random point
        empty++;
        int p = (int)(rng() % n);
        std::copy(&pts[p * d], &pts[p * d] + d, &C[c * d]);
        continue;
      }
      for (int j = 0; j < d; j++) C[c * d + j] = (float)(sum[c * d + j] / cnt[c]);
    }
    if (it % 5 == 0 || it == iters - 1) fprintf(stderr, "  kmeans it=%d mse=%.6f empty=%d\n", it, sse.load() / n, empty);
  }
  return C;
}

static void genStreet(const char* name, BoardMap& map, int boardCards, int k, int dims, double sampleBoardsFrac, int threads, const std::string& outDir) {
  fprintf(stderr, "== %s: k=%d dims=%d canonical boards=%d\n", name, k, dims, map.numCanon);
  std::mt19937_64 rng(1000 + boardCards);
  // Sample boards to fit the centroids, then stream every board through nearest-centroid assignment.
  std::vector<int> sampleBoards;
  for (int i = 0; i < map.numCanon; i++)
    if (std::uniform_real_distribution<double>(0, 1)(rng) < sampleBoardsFrac) sampleBoards.push_back(i);
  std::vector<std::vector<float>> perBoard(sampleBoards.size());
  std::atomic<int> done{0};
  parallelFor((int)sampleBoards.size(), threads, [&](int i, int) {
    thread_local RiverPass R;
    thread_local std::vector<int> valid;
    thread_local std::vector<float> f(NUM_HANDS * dims);
    boardFeatures(map.canon[sampleBoards[i]].data(), boardCards, f.data(), dims, valid, R);
    perBoard[i].assign(f.begin(), f.begin() + valid.size() * dims);
    int dn = ++done;
    if (dn % 2000 == 0) fprintf(stderr, "  sampled %d/%zu\n", dn, sampleBoards.size());
  });
  std::vector<float> pts;
  size_t total = 0;
  for (auto& v : perBoard) total += v.size();
  // Cap the training set so Lloyd iterations stay fast.
  const size_t cap = (size_t)2500000 * dims;
  int stride = std::max<size_t>(1, total / cap);
  pts.reserve(total / stride + dims);
  for (auto& v : perBoard) {
    int cnt = (int)(v.size() / dims);
    for (int i = 0; i < cnt; i += stride) pts.insert(pts.end(), &v[i * dims], &v[i * dims] + dims);
    std::vector<float>().swap(v);
  }
  fprintf(stderr, "  training k-means on %zu points\n", pts.size() / dims);
  auto C = kmeans(pts, dims, k, 25, threads, 42 + boardCards);
  std::vector<float>().swap(pts);

  std::vector<uint16_t> table((size_t)map.numCanon * NUM_HANDS, 0);
  done = 0;
  parallelFor(map.numCanon, threads, [&](int b, int) {
    thread_local RiverPass R;
    thread_local std::vector<int> valid;
    thread_local std::vector<float> f(NUM_HANDS * dims);
    boardFeatures(map.canon[b].data(), boardCards, f.data(), dims, valid, R);
    uint16_t* row = &table[(size_t)b * NUM_HANDS];
    for (int v = 0; v < (int)valid.size(); v++) row[valid[v]] = (uint16_t)nearest(&f[v * dims], C, k, dims);
    int dn = ++done;
    if (dn % 20000 == 0) fprintf(stderr, "  assigned %d/%d\n", dn, map.numCanon);
  });
  std::string path = outDir + "/buckets_" + name + ".u16";
  FILE* fp = fopen(path.c_str(), "wb");
  fwrite(table.data(), sizeof(uint16_t), table.size(), fp);
  fclose(fp);
  std::string cpath = outDir + "/centroids_" + name + ".f32";
  fp = fopen(cpath.c_str(), "wb");
  fwrite(C.data(), sizeof(float), C.size(), fp);
  fclose(fp);
  fprintf(stderr, "  wrote %s\n", path.c_str());
}

static void buildOchsGroups() {
  // Rank the 169 starting hands by equity against a random hand (Monte Carlo), then split the
  // 1326 combos into equal-weight groups.
  Xorshift rng(777);
  std::vector<double> wins(169, 0), games(169, 0);
  for (int it = 0; it < 3000000; it++) {
    int c[9], used = 0;
    uint64_t seen = 0;
    while (used < 9) {
      int x = rng.below(52);
      if ((seen >> x) & 1) continue;
      seen |= 1ULL << x;
      c[used++] = x;
    }
    int a[7] = {c[0], c[1], c[4], c[5], c[6], c[7], c[8]}, b[7] = {c[2], c[3], c[4], c[5], c[6], c[7], c[8]};
    int sa = evalCards(a, 7), sb = evalCards(b, 7);
    int ia = PRE169[pairIdx(c[0], c[1])], ib = PRE169[pairIdx(c[2], c[3])];
    games[ia]++; games[ib]++;
    if (sa > sb) wins[ia]++; else if (sb > sa) wins[ib]++; else { wins[ia] += .5; wins[ib] += .5; }
  }
  std::vector<std::pair<double, int>> order;
  for (int h = 0; h < NUM_HANDS; h++) order.push_back({wins[PRE169[h]] / games[PRE169[h]], h});
  std::sort(order.begin(), order.end());
  for (int i = 0; i < NUM_HANDS; i++) OCHS_GROUP[order[i].second] = (int8_t)(i * OCHS / NUM_HANDS);
}

int main(int argc, char** argv) {
  initAll();
  std::string mode = argc > 1 ? argv[1] : "check";
  if (mode == "check") {
    int64_t counts[9] = {0};
    uint32_t hash = 0;
    int h[7];
    for (h[0] = 0; h[0] < 46; h[0]++) for (h[1] = h[0] + 1; h[1] < 47; h[1]++) for (h[2] = h[1] + 1; h[2] < 48; h[2]++)
      for (h[3] = h[2] + 1; h[3] < 49; h[3]++) for (h[4] = h[3] + 1; h[4] < 50; h[4]++) for (h[5] = h[4] + 1; h[5] < 51; h[5]++)
        for (h[6] = h[5] + 1; h[6] < 52; h[6]++) {
          int v = evalCards(h, 7);
          counts[v >> 20]++;
          hash = hash * 31u + (uint32_t)v;
        }
    const int64_t expected[9] = {23294460, 58627800, 31433400, 6461620, 6180020, 4047644, 3473184, 224848, 41584};
    bool ok = true;
    for (int i = 0; i < 9; i++) { printf("cat %d: %lld\n", i, (long long)counts[i]); ok &= counts[i] == expected[i]; }
    printf("7-card score hash: %u\nfrequencies %s\n", hash, ok ? "MATCH" : "MISMATCH");
    return ok ? 0 : 1;
  }
  int fk = atoi(argv[2]), tk = atoi(argv[3]), rk = atoi(argv[4]), threads = atoi(argv[5]);
  std::string outDir = argv[6];
  buildOchsGroups();
  {
    FILE* kf = fopen((outDir + "/k.txt").c_str(), "w");
    fprintf(kf, "%d %d %d\n", fk, tk, rk);
    fclose(kf);
  }
  BoardMap f, t, r;
  f.build(3); t.build(4); r.build(5);
  genStreet("flop", f, 3, fk, HIST_BINS, 1.0, threads, outDir);
  genStreet("turn", t, 4, tk, HIST_BINS, 0.15, threads, outDir);
  genStreet("river", r, 5, rk, OCHS + 1, 0.02, threads, outDir);
  return 0;
}

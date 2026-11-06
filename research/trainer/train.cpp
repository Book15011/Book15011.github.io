// Blueprint trainer: external-sampling Monte Carlo CFR with Linear CFR discounting and
// regret-based pruning, the same recipe Pluribus used for its blueprint (Brown & Sandholm 2019).
//
// Modes:
//   train tree   <depthBB>
//   train run    <depthBB> <dataDir> <outDir> <threads> <minutes> [seed]
//   train br     <depthBB> <dataDir> <checkpoint> <threads> <samples>   (Monte Carlo best response)
//   train export <depthBB> <dataDir> <checkpoint> <out.bin> [full]
//   train h2h    <depthBB> <dataDir> <ckptA> <ckptB> <threads> <hands>
#include <atomic>
#include <chrono>
#include <cmath>
#include <string>
#include <thread>

#include "poker.h"
#include "tree.h"
using namespace poker;

static int BUCKETS[4] = {169, 1000, 1000, 500};

// Bucket counts are written by the abstraction generator next to its tables.
static void loadBucketCounts(const std::string& dir) {
  FILE* f = fopen((dir + "/k.txt").c_str(), "r");
  if (!f) return;
  if (fscanf(f, "%d %d %d", &BUCKETS[1], &BUCKETS[2], &BUCKETS[3]) != 3) exit(1);
  fclose(f);
}
// An action is skipped once it has lost the equivalent of the full stack about 300 times over.
static float REGRET_FLOOR = -3.3e6f, PRUNE_THRESHOLD = -3.0e6f;

struct Abstraction {
  BoardMap flop, turn, river;
  std::vector<uint16_t> tf, tt, tr;

  static void load(const std::string& p, std::vector<uint16_t>& v) {
    FILE* f = fopen(p.c_str(), "rb");
    if (!f) { fprintf(stderr, "missing %s\n", p.c_str()); exit(1); }
    fseek(f, 0, SEEK_END);
    size_t sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    v.resize(sz / 2);
    if (fread(v.data(), 2, v.size(), f) != v.size()) exit(1);
    fclose(f);
  }
  void init(const std::string& dir) {
    flop.build(3); turn.build(4); river.build(5);
    load(dir + "/buckets_flop.u16", tf);
    load(dir + "/buckets_turn.u16", tt);
    load(dir + "/buckets_river.u16", tr);
  }
  static inline int lookup(const BoardMap& m, const std::vector<uint16_t>& t, int rank, int a, int b) {
    int p = m.perm[rank];
    return t[(size_t)m.id[rank] * NUM_HANDS + pairIdx(PERM_CARD[p][a], PERM_CARD[p][b])];
  }
};

struct Deal {
  uint16_t bucket[2][4];
  int8_t result; // +1 player 0 wins, -1 player 1 wins, 0 tie
};

static inline void sampleDeal(Xorshift& rng, const Abstraction& A, Deal& d) {
  int c[9], n = 0;
  uint64_t seen = 0;
  while (n < 9) {
    int x = rng.below(52);
    if ((seen >> x) & 1) continue;
    seen |= 1ULL << x;
    c[n++] = x;
  }
  int b[5] = {c[4], c[5], c[6], c[7], c[8]};
  // Sort boards by insertion for the colex index.
  int f3[3] = {b[0], b[1], b[2]};
  std::sort(f3, f3 + 3);
  int f4[4] = {f3[0], f3[1], f3[2], b[3]};
  std::sort(f4, f4 + 4);
  int f5[5] = {f4[0], f4[1], f4[2], f4[3], b[4]};
  std::sort(f5, f5 + 5);
  int rf = colexRank(f3, 3), rt = colexRank(f4, 4), rr = colexRank(f5, 5);
  for (int p = 0; p < 2; p++) {
    int x = c[p * 2], y = c[p * 2 + 1];
    d.bucket[p][0] = PRE169[pairIdx(x, y)];
    d.bucket[p][1] = Abstraction::lookup(A.flop, A.tf, rf, x, y);
    d.bucket[p][2] = Abstraction::lookup(A.turn, A.tt, rt, x, y);
    d.bucket[p][3] = Abstraction::lookup(A.river, A.tr, rr, x, y);
  }
  int a7[7] = {c[0], c[1], b[0], b[1], b[2], b[3], b[4]}, b7[7] = {c[2], c[3], b[0], b[1], b[2], b[3], b[4]};
  int s0 = evalCards(a7, 7), s1 = evalCards(b7, 7);
  d.result = s0 > s1 ? 1 : (s1 > s0 ? -1 : 0);
}

static inline void regretMatch(const float* r, int na, float* sigma) {
  float pos = 0;
  for (int a = 0; a < na; a++) if (r[a] > 0) pos += r[a];
  if (pos > 0) {
    float inv = 1.0f / pos;
    for (int a = 0; a < na; a++) sigma[a] = r[a] > 0 ? r[a] * inv : 0;
  } else {
    float u = 1.0f / na;
    for (int a = 0; a < na; a++) sigma[a] = u;
  }
}

static inline int sampleAction(const float* sigma, int na, Xorshift& rng) {
  float u = rng.unit(), cum = 0;
  for (int a = 0; a < na - 1; a++) {
    cum += sigma[a];
    if (u < cum) return a;
  }
  return na - 1;
}

static inline float terminalValue(const Node& nd, int trav, const Deal& d) {
  if (nd.type == TERM_FOLD) return trav == nd.winner ? (float)nd.inv[1 - trav] : -(float)nd.inv[trav];
  if (d.result == 0) return 0.0f;
  int w = d.result > 0 ? 0 : 1;
  return trav == w ? (float)nd.inv[1 - trav] : -(float)nd.inv[trav];
}

struct Trainer {
  Tree T;
  Abstraction A;
  std::vector<float> reg, avg;
  std::atomic<bool> useAvgUpdates{false};

  float cfr(int n, int trav, const Deal& d, Xorshift& rng, bool prune) {
    const Node& nd = T.nodes[n];
    if (nd.type != DECISION) return terminalValue(nd, trav, d);
    const int p = nd.player, na = nd.na;
    const int b = d.bucket[p][nd.street];
    float* r = &reg[nd.regOff + (int64_t)b * na];
    float sigma[MAX_ACTIONS];
    regretMatch(r, na, sigma);
    const int32_t* kids = &T.children[nd.child0];
    if (p == trav) {
      float v[MAX_ACTIONS], ev = 0;
      bool done[MAX_ACTIONS];
      for (int a = 0; a < na; a++) {
        bool skip = prune && r[a] < PRUNE_THRESHOLD && nd.street < 3 && T.nodes[kids[a]].type == DECISION;
        done[a] = !skip;
        if (skip) continue;
        v[a] = cfr(kids[a], trav, d, rng, prune);
        ev += sigma[a] * v[a];
      }
      for (int a = 0; a < na; a++) {
        if (!done[a]) continue;
        float x = r[a] + (v[a] - ev);
        r[a] = x < REGRET_FLOOR ? REGRET_FLOOR : x;
      }
      return ev;
    }
    if (nd.avgOff >= 0 && useAvgUpdates.load(std::memory_order_relaxed)) {
      float* s = &avg[nd.avgOff + (int64_t)b * na];
      for (int a = 0; a < na; a++) s[a] += sigma[a];
    }
    return cfr(kids[sampleAction(sigma, na, rng)], trav, d, rng, prune);
  }

  // Strategy used for play and evaluation: average on preflop/flop, current regret-matched later.
  inline void playStrategy(const Node& nd, int b, float* sigma) const {
    const int na = nd.na;
    if (nd.avgOff >= 0 && !avg.empty()) {
      const float* s = &avg[nd.avgOff + (int64_t)b * na];
      float tot = 0;
      for (int a = 0; a < na; a++) tot += s[a];
      if (tot > 0) { for (int a = 0; a < na; a++) sigma[a] = s[a] / tot; return; }
    }
    regretMatch(&reg[nd.regOff + (int64_t)b * na], na, sigma);
  }

  void init(int depth, const std::string& dataDir) {
    loadBucketCounts(dataDir);
    T.build(configForDepth(depth), BUCKETS);
    A.init(dataDir);
    fprintf(stderr, "tree nodes=%zu decisions pre=%lld flop=%lld turn=%lld river=%lld regrets=%.2fGB avg=%.2fGB\n", T.nodes.size(),
            (long long)T.counts[0], (long long)T.counts[1], (long long)T.counts[2], (long long)T.counts[3], T.regSize * 4 / 1e9, T.avgSize * 4 / 1e9);
  }

  void save(const std::string& path, int64_t iters) const {
    FILE* f = fopen((path + ".tmp").c_str(), "wb");
    fwrite(&iters, 8, 1, f);
    fwrite(reg.data(), 4, reg.size(), f);
    fwrite(avg.data(), 4, avg.size(), f);
    fclose(f);
    rename((path + ".tmp").c_str(), path.c_str());
  }

  int64_t load(const std::string& path) {
    reg.resize(T.regSize);
    avg.resize(T.avgSize);
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) { fprintf(stderr, "missing %s\n", path.c_str()); exit(1); }
    int64_t iters = 0;
    if (fread(&iters, 8, 1, f) != 1) exit(1);
    if (fread(reg.data(), 4, reg.size(), f) != reg.size()) exit(1);
    if (fread(avg.data(), 4, avg.size(), f) != avg.size()) exit(1);
    fclose(f);
    return iters;
  }
};

// Monte Carlo best response inside the abstraction: learn the best action per infoset on one set of
// samples, then measure that fixed policy on fresh samples, so the figure is not biased upward by overfitting.
struct BestResponse {
  Trainer& M;
  std::vector<double> sum; // accumulated value per infoset-action
  explicit BestResponse(Trainer& m) : M(m), sum(m.T.regSize, 0.0) {}

  float learn(int n, int br, const Deal& d, Xorshift& rng) {
    const Node& nd = M.T.nodes[n];
    if (nd.type != DECISION) return terminalValue(nd, br, d);
    const int na = nd.na, b = d.bucket[nd.player][nd.street];
    const int32_t* kids = &M.T.children[nd.child0];
    if (nd.player == br) {
      double* s = &sum[nd.regOff + (int64_t)b * na];
      float v[MAX_ACTIONS];
      for (int a = 0; a < na; a++) { v[a] = learn(kids[a], br, d, rng); s[a] += v[a]; }
      int arg = 0;
      for (int a = 1; a < na; a++) if (s[a] > s[arg]) arg = a;
      return v[arg]; // follow the action that looks best so far
    }
    float sigma[MAX_ACTIONS];
    M.playStrategy(nd, b, sigma);
    return learn(kids[sampleAction(sigma, na, rng)], br, d, rng);
  }

  float measure(int n, int br, const Deal& d, Xorshift& rng) {
    const Node& nd = M.T.nodes[n];
    if (nd.type != DECISION) return terminalValue(nd, br, d);
    const int na = nd.na, b = d.bucket[nd.player][nd.street];
    const int32_t* kids = &M.T.children[nd.child0];
    if (nd.player == br) {
      const double* s = &sum[nd.regOff + (int64_t)b * na];
      int arg = 0;
      for (int a = 1; a < na; a++) if (s[a] > s[arg]) arg = a;
      return measure(kids[arg], br, d, rng);
    }
    float sigma[MAX_ACTIONS];
    M.playStrategy(nd, b, sigma);
    return measure(kids[sampleAction(sigma, na, rng)], br, d, rng);
  }
};

static double bestResponse(Trainer& M, int threads, int64_t samples) {
  double total = 0;
  for (int br = 0; br < 2; br++) {
    BestResponse B(M);
    std::vector<std::thread> ts;
    for (int t = 0; t < threads; t++)
      ts.emplace_back([&, t]() {
        Xorshift rng(991 + t * 7 + br);
        Deal d;
        int64_t n = samples / threads;
        for (int64_t i = 0; i < n; i++) { sampleDeal(rng, M.A, d); B.learn(0, br, d, rng); }
      });
    for (auto& t : ts) t.join();
    std::vector<double> part(threads, 0.0);
    ts.clear();
    int64_t evalN = samples / 2;
    for (int t = 0; t < threads; t++)
      ts.emplace_back([&, t]() {
        Xorshift rng(5551 + t * 13 + br);
        Deal d;
        double s = 0;
        int64_t n = evalN / threads;
        for (int64_t i = 0; i < n; i++) { sampleDeal(rng, M.A, d); s += B.measure(0, br, d, rng); }
        part[t] = s / n;
      });
    for (auto& t : ts) t.join();
    double v = 0;
    for (double x : part) v += x;
    v /= threads;
    fprintf(stderr, "  best response as player %d: %.2f chips/hand\n", br, v);
    total += v;
  }
  return total / 2 / BB * 1000.0; // mbb/hand; a Nash profile would give 0
}

static double headToHead(Trainer& X, Trainer& Y, int threads, int64_t hands, double* stderrOut) {
  std::vector<double> sums(threads, 0), sq(threads, 0);
  std::vector<std::thread> ts;
  for (int t = 0; t < threads; t++)
    ts.emplace_back([&, t]() {
      Xorshift rng(31337 + t);
      Deal d;
      double s = 0, s2 = 0;
      int64_t n = hands / threads;
      for (int64_t i = 0; i < n; i++) {
        sampleDeal(rng, X.A, d);
        // Duplicate: the same cards with seats swapped.
        double pairTotal = 0;
        for (int xSeat = 0; xSeat < 2; xSeat++) {
          int node = 0;
          for (;;) {
            const Node& nd = X.T.nodes[node];
            if (nd.type != DECISION) { pairTotal += terminalValue(nd, xSeat, d); break; }
            float sigma[MAX_ACTIONS];
            int b = d.bucket[nd.player][nd.street];
            (nd.player == xSeat ? X : Y).playStrategy(nd, b, sigma);
            node = X.T.children[nd.child0 + sampleAction(sigma, nd.na, rng)];
          }
        }
        s += pairTotal / 2;
        s2 += pairTotal * pairTotal / 4;
      }
      sums[t] = s; sq[t] = s2;
    });
  for (auto& t : ts) t.join();
  double S = 0, S2 = 0;
  for (int t = 0; t < threads; t++) { S += sums[t]; S2 += sq[t]; }
  int64_t n = hands / threads * threads;
  double mean = S / n, var = S2 / n - mean * mean;
  *stderrOut = std::sqrt(var / n) / BB * 1000.0;
  return mean / BB * 1000.0;
}

static void writeExport(Trainer& M, const std::string& out, bool full, int depth) {
  // Layout (little-endian): magic "PKB1", u32 depthBB, u32 numNodes, u32 numChildren, 4 x u32 bucket counts,
  // then per-node records, child arrays, and u8 strategies for each exported decision node.
  const Tree& T = M.T;
  std::vector<int> remap(T.nodes.size(), -1);
  std::vector<int> keep;
  for (size_t i = 0; i < T.nodes.size(); i++)
    if (T.nodes[i].street <= (full ? 3 : 1)) { remap[i] = (int)keep.size(); keep.push_back((int)i); }
  // A light export stops after the flop: a child index of -1 means "the turn is dealt next".
  std::vector<int32_t> kids;
  std::vector<uint8_t> atype;
  std::vector<int32_t> ato;
  std::vector<int32_t> first(keep.size(), 0);
  for (size_t k = 0; k < keep.size(); k++) {
    const Node& nd = T.nodes[keep[k]];
    first[k] = (int32_t)kids.size();
    if (nd.type != DECISION) continue;
    for (int a = 0; a < nd.na; a++) {
      int c = T.children[nd.child0 + a];
      kids.push_back(remap[c]);
      atype.push_back(T.actionType[nd.child0 + a]);
      ato.push_back(T.actionTo[nd.child0 + a]);
    }
  }
  FILE* f = fopen(out.c_str(), "wb");
  uint32_t head[8] = {0x31424B50, (uint32_t)depth, (uint32_t)keep.size(), (uint32_t)kids.size(), (uint32_t)BUCKETS[0], (uint32_t)BUCKETS[1], (uint32_t)BUCKETS[2], (uint32_t)BUCKETS[3]};
  fwrite(head, 4, 8, f);
  for (size_t k = 0; k < keep.size(); k++) {
    const Node& nd = T.nodes[keep[k]];
    uint8_t meta[4] = {nd.type, nd.player, nd.street, nd.na};
    fwrite(meta, 1, 4, f);
    int32_t rec[6] = {nd.inv[0], nd.inv[1], first[k], (int32_t)nd.winner, nd.bets[0], nd.bets[1]};
    fwrite(rec, 4, 6, f);
  }
  fwrite(kids.data(), 4, kids.size(), f);
  fwrite(atype.data(), 1, atype.size(), f);
  fwrite(ato.data(), 4, ato.size(), f);
  std::vector<uint8_t> row;
  size_t bytes = 0;
  for (size_t k = 0; k < keep.size(); k++) {
    const Node& nd = T.nodes[keep[k]];
    if (nd.type != DECISION) continue;
    int K = BUCKETS[nd.street], na = nd.na;
    row.resize((size_t)K * na);
    for (int b = 0; b < K; b++) {
      float s[MAX_ACTIONS];
      M.playStrategy(nd, b, s);
      // Largest-remainder rounding, so each row sums to exactly 255.
      int q[MAX_ACTIONS], used = 0;
      float rem[MAX_ACTIONS];
      for (int a = 0; a < na; a++) { float x = s[a] * 255.0f; q[a] = (int)x; rem[a] = x - q[a]; used += q[a]; }
      while (used < 255) {
        int arg = 0;
        for (int a = 1; a < na; a++) if (rem[a] > rem[arg]) arg = a;
        q[arg]++; rem[arg] = -1; used++;
      }
      for (int a = 0; a < na; a++) row[(size_t)b * na + a] = (uint8_t)q[a];
    }
    fwrite(row.data(), 1, row.size(), f);
    bytes += row.size();
  }
  fclose(f);
  fprintf(stderr, "exported %zu nodes, %zu child edges, %.2f MB of strategy to %s\n", keep.size(), kids.size(), bytes / 1e6, out.c_str());
}

int main(int argc, char** argv) {
  initAll();
  std::string mode = argv[1];
  int depth = atoi(argv[2]);
  PRUNE_THRESHOLD = -300.0f * depth * BB;
  REGRET_FLOOR = -330.0f * depth * BB;

  if (mode == "tree") {
    if (argc > 3) loadBucketCounts(argv[3]);
    Tree T;
    T.build(configForDepth(depth), BUCKETS);
    printf("depth=%dbb nodes=%zu decisions pre=%lld flop=%lld turn=%lld river=%lld regrets=%.2fGB avg=%.3fGB export(pre+flop)=%.2fMB\n", depth, T.nodes.size(),
           (long long)T.counts[0], (long long)T.counts[1], (long long)T.counts[2], (long long)T.counts[3], T.regSize * 4 / 1e9, T.avgSize * 4 / 1e9, T.avgSize / 1e6);
    return 0;
  }

  std::string dataDir = argv[3];
  Trainer M;
  M.init(depth, dataDir);

  if (mode == "run") {
    std::string outDir = argv[4];
    int threads = atoi(argv[5]);
    double minutes = atof(argv[6]);
    uint64_t seed = argc > 7 ? strtoull(argv[7], nullptr, 10) : 1;
    M.reg.assign(M.T.regSize, 0.0f);
    M.avg.assign(M.T.avgSize, 0.0f);
    std::atomic<int64_t> iters{0};
    auto t0 = std::chrono::steady_clock::now();
    auto elapsed = [&]() { return std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count() / 60.0; };
    const double discountUntil = minutes * 0.15, discountEvery = discountUntil / 30.0;
    const double avgFrom = minutes * 0.05, pruneFrom = minutes * 0.10;
    double nextDiscount = discountEvery, nextReport = 1.0, nextCkpt = minutes / 8.0;
    int discountStep = 0, ckptNo = 0;
    std::atomic<bool> stop{false}, pause{false};
    std::atomic<int> paused{0};
    std::vector<std::thread> ts;
    std::atomic<bool> pruneOn{false};
    for (int t = 0; t < threads; t++)
      ts.emplace_back([&, t]() {
        Xorshift rng(seed * 1000003ULL + t);
        Deal d;
        int64_t local = 0;
        while (!stop.load(std::memory_order_relaxed)) {
          if (pause.load(std::memory_order_relaxed)) {
            paused++;
            while (pause.load()) std::this_thread::sleep_for(std::chrono::milliseconds(5));
            paused--;
          }
          sampleDeal(rng, M.A, d);
          bool prune = pruneOn.load(std::memory_order_relaxed) && rng.unit() < 0.95f;
          M.cfr(0, (int)(local & 1), d, rng, prune);
          if ((++local & 1023) == 0) iters.fetch_add(1024, std::memory_order_relaxed);
        }
      });
    auto quiesce = [&]() {
      pause = true;
      while (paused.load() < threads) std::this_thread::sleep_for(std::chrono::milliseconds(2));
    };
    for (;;) {
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      double m = elapsed();
      if (m >= avgFrom) M.useAvgUpdates = true;
      if (m >= pruneFrom) pruneOn = true;
      if (m < discountUntil && m >= nextDiscount) {
        // Linear CFR, applied periodically: weight d = t / (t + 1).
        quiesce();
        discountStep++;
        float dd = (float)discountStep / (discountStep + 1.0f);
        for (auto& x : M.reg) x *= dd;
        for (auto& x : M.avg) x *= dd;
        pause = false;
        nextDiscount += discountEvery;
      }
      if (m >= nextReport) {
        fprintf(stderr, "[%.1f min] iters=%.1fM rate=%.0fk/s\n", m, iters.load() / 1e6, iters.load() / (m * 60) / 1e3);
        nextReport += 1.0;
      }
      if (m >= nextCkpt && m < minutes) {
        quiesce();
        ckptNo++;
        M.save(outDir + "/d" + std::to_string(depth) + ".ckpt", iters.load());
        pause = false;
        fprintf(stderr, "[%.1f min] checkpoint %d saved at %.1fM iterations\n", m, ckptNo, iters.load() / 1e6);
        nextCkpt += minutes / 8.0;
      }
      if (m >= minutes) break;
    }
    stop = true;
    pause = false;
    for (auto& t : ts) t.join();
    M.save(outDir + "/d" + std::to_string(depth) + ".final", iters.load());
    fprintf(stderr, "finished: %.1fM iterations in %.1f minutes\n", iters.load() / 1e6, elapsed());
    return 0;
  }

  if (mode == "br") {
    int64_t it = M.load(argv[4]);
    int threads = atoi(argv[5]);
    int64_t samples = atoll(argv[6]);
    double mbb = bestResponse(M, threads, samples);
    printf("iterations=%.1fM abstract_exploitability_estimate=%.1f mbb/hand (samples=%lld)\n", it / 1e6, mbb, (long long)samples);
    return 0;
  }

  if (mode == "export") {
    M.load(argv[4]);
    writeExport(M, argv[5], argc > 6 && std::string(argv[6]) == "full", depth);
    return 0;
  }

  if (mode == "h2h") {
    M.load(argv[4]);
    Trainer Y;
    Y.T = M.T; // same abstraction and betting tree
    Y.load(argv[5]);
    double se;
    double r = headToHead(M, Y, atoi(argv[6]), atoll(argv[7]), &se);
    printf("A vs B: %.2f mbb/hand +- %.2f (1 s.e.), duplicate pairs\n", r, se);
    return 0;
  }
  return 1;
}

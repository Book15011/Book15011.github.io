/*
 * Real-time subgame solver: vector-form Discounted CFR (Brown & Sandholm 2019, alpha=1.5, beta=0, gamma=2)
 * over a turn or river subgame, compiled to WebAssembly with SIMD. It runs on the visitor's device.
 *
 * All strategy state is stored per hand and per node, so one pass of the tree updates every hand in the
 * range at once. Showdowns take O(hands) using sorted hand strengths with card-removal correction.
 *
 * No libc: every buffer comes from one bump allocator over WebAssembly linear memory.
 * The JavaScript wrapper (poker/js/ai/solver.js) builds the betting tree and writes it here.
 */
#include <stddef.h>
#include <stdint.h>

#define WASM_EXPORT(name) __attribute__((export_name(#name)))

enum { N_DECISION = 0, N_FOLD = 1, N_SHOWDOWN = 2, N_CHANCE = 3 };
#define MAX_DEPTH 40
#define MAX_RIVERS 48

typedef struct {
  uint8_t type, player, na, river; /* river: index of the showdown context, used by N_SHOWDOWN */
  int32_t first;                   /* first child index in `kids` */
  int32_t off;                     /* offset into `regret` and `avg` in floats (na * H for this node) */
  float win[2];                    /* N_FOLD: net payoff to each player. N_SHOWDOWN: win[0] = chips each stands to win */
  float lose[2];                   /* N_SHOWDOWN: chips each loses. */
  float tie[2];                    /* N_SHOWDOWN: net for a tie (uneven only if dead money is split unevenly) */
} Node;

/* -- memory -- */
extern unsigned char __heap_base;
static unsigned char* heap_ptr;

WASM_EXPORT(sv_reset) void sv_reset(void) { heap_ptr = (unsigned char*)(((uintptr_t)&__heap_base + 15) & ~(uintptr_t)15); }

WASM_EXPORT(sv_alloc) void* sv_alloc(int bytes) {
  unsigned char* p = heap_ptr;
  heap_ptr += (bytes + 15) & ~15;
  uintptr_t have = (uintptr_t)__builtin_wasm_memory_size(0) * 65536u;
  if ((uintptr_t)heap_ptr > have) {
    uintptr_t need = ((uintptr_t)heap_ptr - have + 65535u) / 65536u;
    if (__builtin_wasm_memory_grow(0, need) == (uintptr_t)-1) __builtin_trap();
  }
  return p;
}

WASM_EXPORT(sv_heap_used) int sv_heap_used(void) { return (int)(heap_ptr - &__heap_base); }

static inline void fill_zero(float* restrict x, int n) { for (int i = 0; i < n; i++) x[i] = 0; }

/* -- problem -- */
static int H;                  /* number of hands */
static Node* nodes;
static int32_t* kids;
static uint8_t* kid_card;      /* N_CHANCE: the dealt card of each child */
static float* regret;
static float* avg;
static int8_t* hand_a;
static int8_t* hand_b;
static float* reach_root[2];
static int num_rivers;
static float chance_cards;     /* effective number of cards at a chance node, for normalising */
/* Showdown contexts. Each holds the hand indices sorted by strength and the tie-group end per position. */
static int16_t* sd_order[MAX_RIVERS];
static int16_t* sd_group_end[MAX_RIVERS];
static int sd_count[MAX_RIVERS];
static int8_t* sd_card_a[MAX_RIVERS];
static int8_t* sd_card_b[MAX_RIVERS];
static float* sorted_reach;
static float* sorted_value;
static float* card_scratch;
static float* stack_mem;       /* per-depth scratch vectors */
static int32_t* locked_off;     /* per-node strategy override: byte offset from `nodes`, or -1 */
static float* sigma_scratch;
static float* root_out;

WASM_EXPORT(sv_setup)
void sv_setup(int hands, int num_nodes, int num_kids, int total_floats, int rivers, float chance_n) {
  H = hands;
  num_rivers = rivers;
  chance_cards = chance_n;
  nodes = sv_alloc(num_nodes * (int)sizeof(Node));
  kids = sv_alloc(num_kids * 4);
  kid_card = sv_alloc(num_kids);
  regret = sv_alloc(total_floats * 4);
  avg = sv_alloc(total_floats * 4);
  fill_zero(regret, total_floats);
  fill_zero(avg, total_floats);
  hand_a = sv_alloc(H);
  hand_b = sv_alloc(H);
  reach_root[0] = sv_alloc(H * 4);
  reach_root[1] = sv_alloc(H * 4);
  card_scratch = sv_alloc(52 * 4);
  stack_mem = sv_alloc(MAX_DEPTH * 10 * H * 4);
  sigma_scratch = sv_alloc(H * 4);
  sorted_reach = sv_alloc(H * 4);
  sorted_value = sv_alloc(H * 4);
  root_out = 0;
  locked_off = sv_alloc(num_nodes * 4);
  for (int i = 0; i < num_nodes; i++) locked_off[i] = -1;
  for (int r = 0; r < MAX_RIVERS; r++) sd_count[r] = 0;
}

WASM_EXPORT(sv_nodes) void* sv_nodes(void) { return nodes; }
WASM_EXPORT(sv_kids) void* sv_kids(void) { return kids; }
WASM_EXPORT(sv_kid_card) void* sv_kid_card(void) { return kid_card; }
WASM_EXPORT(sv_hand_a) void* sv_hand_a(void) { return hand_a; }
WASM_EXPORT(sv_hand_b) void* sv_hand_b(void) { return hand_b; }
WASM_EXPORT(sv_reach) void* sv_reach(int p) { return reach_root[p]; }
WASM_EXPORT(sv_avg) void* sv_avg(void) { return avg; }
WASM_EXPORT(sv_regret) void* sv_regret(void) { return regret; }
WASM_EXPORT(sv_node_size) int sv_node_size(void) { return (int)sizeof(Node); }

WASM_EXPORT(sv_set_showdown)
void* sv_set_showdown(int r, int count) {
  sd_count[r] = count;
  sd_order[r] = sv_alloc(count * 2);
  sd_group_end[r] = sv_alloc(count * 2);
  sd_card_a[r] = sv_alloc(count);
  sd_card_b[r] = sv_alloc(count);
  return sd_order[r];
}
WASM_EXPORT(sv_group_end) void* sv_group_end(int r) { return sd_group_end[r]; }
/* Call after filling the order array, to cache the cards of each sorted hand. */
WASM_EXPORT(sv_finish_showdown) void sv_finish_showdown(int r) {
  for (int i = 0; i < sd_count[r]; i++) { sd_card_a[r][i] = hand_a[sd_order[r][i]]; sd_card_b[r][i] = hand_b[sd_order[r][i]]; }
}

/* Pin a node's strategy (a past decision by the AI that cannot be changed) to na*H floats. */
WASM_EXPORT(sv_lock_node)
void* sv_lock_node(int node) {
  int na = nodes[node].na;
  float* p = sv_alloc(na * H * 4);
  locked_off[node] = (int32_t)((unsigned char*)p - (unsigned char*)nodes);
  return p;
}

static inline const float* locked_ptr(int node) { return (const float*)((unsigned char*)nodes + locked_off[node]); }

/* Regret matching over all hands at once. Writes na*H floats. */
static void regret_match(const float* restrict R, int na, float* restrict out) {
  float* restrict sum = sigma_scratch;
  for (int h = 0; h < H; h++) sum[h] = 0;
  for (int a = 0; a < na; a++) {
    const float* restrict r = R + a * H;
    for (int h = 0; h < H; h++) { float x = r[h]; sum[h] += x > 0 ? x : 0; }
  }
  const float uniform = 1.0f / na;
  for (int a = 0; a < na; a++) {
    const float* restrict r = R + a * H;
    float* restrict o = out + a * H;
    for (int h = 0; h < H; h++) {
      float x = r[h] > 0 ? r[h] : 0;
      float s = sum[h];
      o[h] = s > 0 ? x / (s > 1e-30f ? s : 1e-30f) : uniform;
    }
  }
}

/* Counterfactual value of each hand of player `me` at a fold terminal, with card removal. */
static void fold_values(const Node* n, int me, const float* restrict opp, float* restrict out) {
  float total = 0;
  float* cs = card_scratch;
  for (int c = 0; c < 52; c++) cs[c] = 0;
  for (int h = 0; h < H; h++) {
    float x = opp[h];
    if (x == 0) continue;
    total += x;
    cs[hand_a[h]] += x;
    cs[hand_b[h]] += x;
  }
  const float pay = n->win[me];
  for (int h = 0; h < H; h++) {
    out[h] = pay * (total - cs[hand_a[h]] - cs[hand_b[h]] + opp[h]);
  }
}

/* Same for a showdown. At showdown both players have invested the same, so value = stake * (beats - loses).
 * One forward sweep over hands in ascending strength counts what each hand beats, one backward sweep what beats
 * it, each correcting for card removal. Reach is copied into sorted order first, which keeps both sweeps
 * cache-friendly. Hands that tie contribute to neither. */
static void showdown_values(const Node* n, int me, const float* restrict opp, float* restrict out) {
  const int r = n->river;
  const int16_t* restrict order = sd_order[r];
  const int16_t* restrict gend = sd_group_end[r];
  const int8_t* restrict ca = sd_card_a[r];
  const int8_t* restrict cb = sd_card_b[r];
  const int cnt = sd_count[r];
  float* restrict sr = sorted_reach;
  float* restrict sv = sorted_value;
  for (int i = 0; i < cnt; i++) sr[i] = opp[order[i]];
  float cs[52];
  for (int c = 0; c < 52; c++) cs[c] = 0;
  float total = 0;
  for (int i = 0; i < cnt;) {
    const int e = gend[i];
    for (int j = i; j < e; j++) sv[j] = total - cs[ca[j]] - cs[cb[j]];
    for (int j = i; j < e; j++) { const float x = sr[j]; total += x; cs[ca[j]] += x; cs[cb[j]] += x; }
    i = e;
  }
  for (int c = 0; c < 52; c++) cs[c] = 0;
  total = 0;
  for (int i = cnt; i > 0;) {
    /* Walk tie groups from the strongest down: gstart is the first index of the group ending at i. */
    int gstart = i - 1;
    while (gstart > 0 && gend[gstart - 1] == i) gstart--;
    for (int j = gstart; j < i; j++) sv[j] -= total - cs[ca[j]] - cs[cb[j]];
    for (int j = gstart; j < i; j++) { const float x = sr[j]; total += x; cs[ca[j]] += x; cs[cb[j]] += x; }
    i = gstart;
  }
  const float stake = n->win[me];
  for (int h = 0; h < H; h++) out[h] = 0;
  for (int i = 0; i < cnt; i++) out[order[i]] = stake * sv[i];
}

static float disc_pos, disc_neg, disc_avg;

/* One CFR traversal for player `me`. `my` and `opp` are reach vectors. Writes values into `out`. */
static void walk(int idx, int me, const float* restrict my, const float* restrict opp, float* restrict out, int depth) {
  const Node* n = &nodes[idx];
  switch (n->type) {
    case N_FOLD: fold_values(n, me, opp, out); return;
    case N_SHOWDOWN: showdown_values(n, me, opp, out); return;
    case N_CHANCE: {
      float* myc = stack_mem + (size_t)depth * 10 * H;
      float* oppc = myc + H;
      float* tmp = myc + 2 * H;
      for (int h = 0; h < H; h++) out[h] = 0;
      for (int a = 0; a < n->na; a++) {
        int card = kid_card[n->first + a];
        for (int h = 0; h < H; h++) {
          int blocked = hand_a[h] == card || hand_b[h] == card;
          myc[h] = blocked ? 0 : my[h];
          oppc[h] = blocked ? 0 : opp[h];
        }
        walk(kids[n->first + a], me, myc, oppc, tmp, depth + 1);
        for (int h = 0; h < H; h++) {
          if (hand_a[h] != card && hand_b[h] != card) out[h] += tmp[h];
        }
      }
      /* Each river is equally likely among the cards unseen by this hand pair. */
      float w = 1.0f / chance_cards;
      for (int h = 0; h < H; h++) out[h] *= w;
      return;
    }
    default: break;
  }
  const int na = n->na;
  float* block = stack_mem + (size_t)depth * 10 * H;
  float* sigma = block;                 /* uses na*H, at most 8*H */
  float* child = block + 8 * H;
  float* reachc = block + 9 * H;
  const float* R = regret + n->off;
  const int32_t* ch = kids + n->first;
  if (locked_off[idx] >= 0) {
    const float* L = locked_ptr(idx);
    for (int i = 0; i < na * H; i++) sigma[i] = L[i];
  } else {
    regret_match(R, na, sigma);
  }
  if (n->player == me) {
    const int is_locked = locked_off[idx] >= 0;
    float* Rw = regret + n->off;
    float* S = avg + n->off;
    for (int h = 0; h < H; h++) out[h] = 0;
    for (int a = 0; a < na; a++) {
      const float* restrict sa = sigma + a * H;
      for (int h = 0; h < H; h++) reachc[h] = my[h] * sa[h];
      walk(ch[a], me, reachc, opp, child, depth + 1);
      for (int h = 0; h < H; h++) out[h] += sa[h] * child[h];
      if (!is_locked) { /* regret temporarily holds old regret + action value */
        float* restrict ra = Rw + a * H;
        for (int h = 0; h < H; h++) ra[h] += child[h];
      }
    }
    if (!is_locked) {
      const float dp = disc_pos, dn = disc_neg, dg = disc_avg;
      for (int a = 0; a < na; a++) {
        float* restrict ra = Rw + a * H;
        float* restrict sa_avg = S + a * H;
        const float* restrict sa = sigma + a * H;
        for (int h = 0; h < H; h++) {
          float x = ra[h] - out[h];
          ra[h] = x * (x > 0 ? dp : dn);
          sa_avg[h] = (sa_avg[h] + my[h] * sa[h]) * dg;
        }
      }
    }
  } else {
    for (int h = 0; h < H; h++) out[h] = 0;
    for (int a = 0; a < na; a++) {
      const float* restrict sa = sigma + a * H;
      for (int h = 0; h < H; h++) reachc[h] = opp[h] * sa[h];
      walk(ch[a], me, my, reachc, child, depth + 1);
      for (int h = 0; h < H; h++) out[h] += child[h];
    }
  }
}

/* One DCFR iteration: both players update once in turn. `t` counts from 1. */
WASM_EXPORT(sv_iterate)
void sv_iterate(int t) {
  double ta = (double)t;
  /* alpha = 1.5 for positive regrets, beta = 0 for negative, gamma = 2 for the average. */
  double pa = ta * __builtin_sqrt(ta);
  disc_pos = (float)(pa / (pa + 1.0));
  disc_neg = 0.5f;
  double g = ta / (ta + 1.0);
  disc_avg = (float)(g * g);
  if (!root_out) root_out = sv_alloc(H * 4);
  for (int p = 0; p < 2; p++) walk(0, p, reach_root[p], reach_root[1 - p], root_out, 0);
}

/* Average strategy at a node for all hands, normalised. Writes na*H floats to `dst`. */
WASM_EXPORT(sv_avg_strategy)
void sv_avg_strategy(int idx, float* dst) {
  const Node* n = &nodes[idx];
  const int na = n->na;
  const float* S = avg + n->off;
  if (locked_off[idx] >= 0) {
    const float* L = locked_ptr(idx);
    for (int i = 0; i < na * H; i++) dst[i] = L[i];
    return;
  }
  for (int h = 0; h < H; h++) {
    float tot = 0;
    for (int a = 0; a < na; a++) tot += S[a * H + h];
    if (tot > 1e-12f) { for (int a = 0; a < na; a++) dst[a * H + h] = S[a * H + h] / tot; }
    else { for (int a = 0; a < na; a++) dst[a * H + h] = 1.0f / na; }
  }
}

/* -- best response against the average strategy, used to measure exploitability -- */
static void br_walk(int idx, int me, const float* restrict opp, float* restrict out, int depth) {
  const Node* n = &nodes[idx];
  if (n->type == N_FOLD) { fold_values(n, me, opp, out); return; }
  if (n->type == N_SHOWDOWN) { showdown_values(n, me, opp, out); return; }
  float* block = stack_mem + (size_t)depth * 10 * H;
  if (n->type == N_CHANCE) {
    float* oppc = block + H;
    float* tmp = block + 2 * H;
    for (int h = 0; h < H; h++) out[h] = 0;
    for (int a = 0; a < n->na; a++) {
      int card = kid_card[n->first + a];
      for (int h = 0; h < H; h++) oppc[h] = (hand_a[h] == card || hand_b[h] == card) ? 0 : opp[h];
      br_walk(kids[n->first + a], me, oppc, tmp, depth + 1);
      for (int h = 0; h < H; h++) if (hand_a[h] != card && hand_b[h] != card) out[h] += tmp[h];
    }
    float w = 1.0f / chance_cards;
    for (int h = 0; h < H; h++) out[h] *= w;
    return;
  }
  const int na = n->na;
  float* child = block + 8 * H;
  float* reachc = block + 9 * H;
  if (n->player == me) {
    for (int h = 0; h < H; h++) out[h] = -1e30f;
    for (int a = 0; a < na; a++) {
      br_walk(kids[n->first + a], me, opp, child, depth + 1);
      for (int h = 0; h < H; h++) if (child[h] > out[h]) out[h] = child[h];
    }
  } else {
    float* sigma = block;
    sv_avg_strategy(idx, sigma);
    for (int h = 0; h < H; h++) out[h] = 0;
    for (int a = 0; a < na; a++) {
      const float* restrict sa = sigma + a * H;
      for (int h = 0; h < H; h++) reachc[h] = opp[h] * sa[h];
      br_walk(kids[n->first + a], me, reachc, child, depth + 1);
      for (int h = 0; h < H; h++) out[h] += child[h];
    }
  }
}

/* Exploitability of the average strategy, in chips per hand, for the ranges given at the root. */
WASM_EXPORT(sv_exploitability)
float sv_exploitability(void) {
  if (!root_out) root_out = sv_alloc(H * 4);
  double total = 0, norm = 0;
  for (int p = 0; p < 2; p++) {
    br_walk(0, p, reach_root[1 - p], root_out, 0);
    double v = 0;
    for (int h = 0; h < H; h++) v += (double)reach_root[p][h] * (double)root_out[h];
    total += v;
  }
  /* Weight of all non-colliding hand pairs. */
  float cs[52];
  for (int c = 0; c < 52; c++) cs[c] = 0;
  float t1 = 0;
  for (int h = 0; h < H; h++) { t1 += reach_root[1][h]; cs[hand_a[h]] += reach_root[1][h]; cs[hand_b[h]] += reach_root[1][h]; }
  for (int h = 0; h < H; h++) norm += (double)reach_root[0][h] * (double)(t1 - cs[hand_a[h]] - cs[hand_b[h]] + reach_root[1][h]);
  return (float)(total / (norm > 0 ? norm : 1.0) / 2.0);
}

/* Value of playing the average strategy for both players from a node downward. */
static void avg_eval(int idx, int me, const float* restrict opp, float* restrict out, int depth) {
  const Node* n = &nodes[idx];
  if (n->type == N_FOLD) { fold_values(n, me, opp, out); return; }
  if (n->type == N_SHOWDOWN) { showdown_values(n, me, opp, out); return; }
  float* block = stack_mem + (size_t)depth * 10 * H;
  if (n->type == N_CHANCE) {
    float* oppc = block + H;
    float* tmp = block + 2 * H;
    for (int h = 0; h < H; h++) out[h] = 0;
    for (int a = 0; a < n->na; a++) {
      int card = kid_card[n->first + a];
      for (int h = 0; h < H; h++) oppc[h] = (hand_a[h] == card || hand_b[h] == card) ? 0 : opp[h];
      avg_eval(kids[n->first + a], me, oppc, tmp, depth + 1);
      for (int h = 0; h < H; h++) if (hand_a[h] != card && hand_b[h] != card) out[h] += tmp[h];
    }
    float w = 1.0f / chance_cards;
    for (int h = 0; h < H; h++) out[h] *= w;
    return;
  }
  const int na = n->na;
  float* sigma = block;
  float* child = block + 8 * H;
  float* reachc = block + 9 * H;
  sv_avg_strategy(idx, sigma);
  for (int h = 0; h < H; h++) out[h] = 0;
  for (int a = 0; a < na; a++) {
    const float* restrict sa = sigma + a * H;
    if (n->player == me) {
      avg_eval(kids[n->first + a], me, opp, child, depth + 1);
      for (int h = 0; h < H; h++) out[h] += sa[h] * child[h];
    } else {
      for (int h = 0; h < H; h++) reachc[h] = opp[h] * sa[h];
      avg_eval(kids[n->first + a], me, reachc, child, depth + 1);
      for (int h = 0; h < H; h++) out[h] += child[h];
    }
  }
}

/* Per-hand value of each action at a node for player `me`, given the opponent's reach at that node.
 * Fills dst with na*H floats. JS divides by the weight of compatible opposing hands. */
WASM_EXPORT(sv_action_values)
void sv_action_values(int idx, int me, const float* opp_reach, float* dst) {
  const Node* n = &nodes[idx];
  for (int a = 0; a < n->na; a++) avg_eval(kids[n->first + a], me, opp_reach, dst + a * H, 0);
}

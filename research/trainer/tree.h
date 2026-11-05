// Abstract betting tree for one starting stack depth.
// A betting line is one node. Chance is implicit: the deal is sampled up front, and a line that ends
// a street simply continues at the first decision node of the next street.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>

namespace poker {

constexpr int BB = 100, SB = 50, MAX_ACTIONS = 7;
enum NodeType : uint8_t { DECISION = 0, TERM_FOLD = 1, TERM_SHOWDOWN = 2 };
enum ActionType : uint8_t { A_FOLD = 0, A_CHECK = 1, A_CALL = 2, A_RAISE = 3 };

struct Node {
  uint8_t type = DECISION, player = 0, street = 0, na = 0;
  int32_t inv[2] = {0, 0};  // chips each player has invested in the hand at this point
  int32_t bets[2] = {0, 0}; // chips committed on the current street
  int32_t child0 = 0;       // index into Tree::children of the first action's child
  int64_t regOff = 0;       // offset of this node's regrets (bucket * na + action)
  int64_t avgOff = -1;      // offset of average-strategy sums (preflop and flop only)
  int8_t winner = -1;       // TERM_FOLD: the player who wins
};

struct TreeConfig {
  int stack;                         // starting stack in chips
  std::vector<double> openBB;        // preflop open sizes (raise-to, in big blinds)
  std::vector<double> limpRaiseBB;   // big blind's raise-to after a limp
  std::vector<double> threeBetX;     // multiples of the bet faced
  std::vector<double> fourBetX;
  std::vector<double> flopBet, flopRaise, turnBet, turnRaise, riverBet, riverRaise;
  int capPre = 5, capFlop = 3, capTurn = 3, capRiver = 3;
};

inline TreeConfig configForDepth(int depthBB) {
  TreeConfig c;
  c.stack = depthBB * BB;
  if (depthBB >= 40) {
    c.openBB = {2.0, 2.5, 3.0, 4.0}; c.limpRaiseBB = {3.0, 4.5}; c.threeBetX = {2.5, 3.0, 4.0}; c.fourBetX = {2.2, 2.8};
  } else if (depthBB >= 15) {
    c.openBB = {2.0, 2.5, 3.0}; c.limpRaiseBB = {3.0, 4.5}; c.threeBetX = {2.5, 3.5}; c.fourBetX = {2.2};
  } else {
    c.openBB = {2.0, 2.5}; c.limpRaiseBB = {3.0}; c.threeBetX = {2.5}; c.fourBetX = {};
  }
  c.flopBet = {0.25, 0.5, 0.75, 1.25}; c.flopRaise = {0.6, 1.0};
  c.turnBet = {0.33, 0.66, 1.0};       c.turnRaise = {0.7};
  c.riverBet = {0.33, 0.66, 1.25};     c.riverRaise = {0.7};
  return c;
}

struct Tree {
  TreeConfig cfg;
  std::vector<Node> nodes;
  std::vector<int32_t> children;
  std::vector<uint8_t> actionType;
  std::vector<int32_t> actionTo; // raise-to on the street for A_RAISE
  int64_t counts[4] = {0, 0, 0, 0};
  int64_t regSize = 0, avgSize = 0;
  int bucketsFor[4] = {169, 1000, 1000, 500};

  void build(const TreeConfig& c, const int* buckets) {
    cfg = c;
    for (int i = 0; i < 4; i++) bucketsFor[i] = buckets[i];
    nodes.reserve(1 << 20);
    addDecision(0, 0, {SB, BB}, {0, 0}, 0, BB, 0);
    for (auto& n : nodes) {
      if (n.type != DECISION) continue;
      counts[n.street]++;
      n.regOff = regSize;
      regSize += (int64_t)bucketsFor[n.street] * n.na;
      if (n.street <= 1) { n.avgOff = avgSize; avgSize += (int64_t)bucketsFor[n.street] * n.na; }
    }
  }

 private:
  struct Pair { int a, b; int operator[](int i) const { return i == 0 ? a : b; } };

  int addTerminal(uint8_t type, int street, Pair inv, int winner) {
    Node n;
    n.type = type; n.street = street; n.inv[0] = inv.a; n.inv[1] = inv.b; n.winner = winner;
    nodes.push_back(n);
    return (int)nodes.size() - 1;
  }

  // Street `street` begins with `prior` chips invested by each player and betting `bets`.
  int addDecision(int street, int player, Pair bets, Pair prior, int raises, int lastRaise, int depth) {
    const int S = cfg.stack;
    const int cur = std::max(bets.a, bets.b);
    const int mine = bets[player];
    const int owe = cur - mine;
    const int invMe = prior[player] + mine;
    const int maxTo = mine + (S - invMe);
    const int oppBehind = S - (prior[1 - player] + bets[1 - player]);
    const int pot = prior.a + prior.b + bets.a + bets.b;

    std::vector<uint8_t> types;
    std::vector<int> tos;
    if (owe > 0) { types.push_back(A_FOLD); tos.push_back(0); types.push_back(A_CALL); tos.push_back(0); }
    else { types.push_back(A_CHECK); tos.push_back(0); }

    const int cap = street == 0 ? cfg.capPre : street == 1 ? cfg.capFlop : street == 2 ? cfg.capTurn : cfg.capRiver;
    if (oppBehind > 0 && maxTo > cur) {
      std::vector<int> cands;
      const int minTo = cur + std::max(lastRaise, (int)BB);
      if (raises < cap) {
        if (street == 0) {
          if (raises == 0 && player == 0) for (double x : cfg.openBB) cands.push_back((int)std::lround(x * BB));
          else if (raises == 0) for (double x : cfg.limpRaiseBB) cands.push_back((int)std::lround(x * BB));
          else if (raises == 1) for (double x : cfg.threeBetX) cands.push_back((int)std::lround(x * cur));
          else if (raises == 2) for (double x : cfg.fourBetX) cands.push_back((int)std::lround(x * cur));
        } else {
          const auto& fr = street == 1 ? (raises == 0 ? cfg.flopBet : cfg.flopRaise)
                         : street == 2 ? (raises == 0 ? cfg.turnBet : cfg.turnRaise)
                                       : (raises == 0 ? cfg.riverBet : cfg.riverRaise);
          for (double f : fr) cands.push_back(cur + (int)std::lround(f * (pot + owe)));
        }
      }
      std::sort(cands.begin(), cands.end());
      int prev = cur;
      for (int to : cands) {
        if (to < minTo) to = minTo;
        // Sizes close to all-in merge into the all-in below.
        if (to >= (int)(0.75 * maxTo) || to >= maxTo) break;
        if (to <= prev) continue;
        types.push_back(A_RAISE); tos.push_back(to);
        prev = to;
      }
      types.push_back(A_RAISE); tos.push_back(maxTo);
    }

    Node me;
    me.type = DECISION; me.player = player; me.street = street; me.na = (uint8_t)types.size();
    me.inv[0] = prior.a + bets.a; me.inv[1] = prior.b + bets.b;
    me.bets[0] = bets.a; me.bets[1] = bets.b;
    if (me.na > MAX_ACTIONS) { fprintf(stderr, "too many actions\n"); exit(1); }
    int idx = (int)nodes.size();
    nodes.push_back(me);
    int base = (int)children.size();
    nodes[idx].child0 = base;
    children.resize(base + me.na);
    actionType.resize(base + me.na);
    actionTo.resize(base + me.na);
    for (int a = 0; a < me.na; a++) { actionType[base + a] = types[a]; actionTo[base + a] = tos[a]; }

    for (int a = 0; a < me.na; a++) {
      int c = -1;
      Pair inv{prior.a + bets.a, prior.b + bets.b};
      switch (types[a]) {
        case A_FOLD:
          c = addTerminal(TERM_FOLD, street, inv, 1 - player);
          break;
        case A_CHECK: {
          bool closes = (street == 0) ? (player == 1) : (player == 0);
          // Preflop the big blind's check closes the action; postflop the button (player 0) closes it.
          c = closes ? nextStreet(street, inv) : addDecision(street, 1 - player, bets, prior, raises, lastRaise, depth + 1);
          break;
        }
        case A_CALL: {
          Pair nb = player == 0 ? Pair{cur, bets.b} : Pair{bets.a, cur};
          Pair ni{prior.a + nb.a, prior.b + nb.b};
          // A limp is a call with the big blind still to act.
          if (street == 0 && raises == 0 && player == 0) {
            c = addDecision(0, 1, nb, prior, 0, BB, depth + 1);
          } else if (ni.a >= S || ni.b >= S) {
            c = addTerminal(TERM_SHOWDOWN, street, ni, -1);
          } else {
            c = nextStreet(street, ni);
          }
          break;
        }
        case A_RAISE: {
          int to = tos[a];
          Pair nb = player == 0 ? Pair{to, bets.b} : Pair{bets.a, to};
          c = addDecision(street, 1 - player, nb, prior, raises + 1, to - cur, depth + 1);
          break;
        }
      }
      children[base + a] = c;
    }
    return idx;
  }

  int nextStreet(int street, Pair inv) {
    if (street == 3) return addTerminal(TERM_SHOWDOWN, 3, inv, -1);
    // Player 0 is the button; the big blind (player 1) acts first after the flop.
    return addDecision(street + 1, 1, {0, 0}, inv, 0, BB, 0);
  }
};

}  // namespace poker

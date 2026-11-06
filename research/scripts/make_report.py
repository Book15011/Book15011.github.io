"""Builds poker/data/benchmarks.json from raw results, so the website only ever shows measured numbers.

Usage: python make_report.py <resultsDir> <modelsDir> <outJson>

Pooling: jobs with different seeds are independent, so hands add up, means are weighted by hands,
and confidence intervals combine in quadrature.
"""
import glob
import json
import math
import os
import sys

results_dir, models_dir, out_path = sys.argv[1:4]

OPPONENT_NAMES = {
    'random': 'Random', 'station': 'Call station', 'casual': 'Casual (site bot)', 'tight': 'Tight-passive',
    'lag': 'Loose-aggressive', 'equity': 'Equity / pot odds', 'strong': 'Competitive (site bot)',
    'maniac': 'Maniac (pot-bets)', 'minraiser': 'Min-raiser', 'shover': 'Random shover', 'blueprint': 'Blueprint only',
}


def read_jsonl(pattern):
    rows = []
    for path in sorted(glob.glob(os.path.join(results_dir, pattern))):
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line.startswith('{'):
                    rows.append(json.loads(line))
    return rows


def pool(rows, value='bb100'):
    total = sum(r['hands'] for r in rows)
    mean = sum(r[value] * r['hands'] for r in rows) / total
    ci = math.sqrt(sum((r['ci95'] * r['hands'] / total) ** 2 for r in rows))
    return {'hands': total, 'value': mean, 'ci': ci}


bench = [r for r in read_jsonl('round*.jsonl')]
hands_rows = [r for r in bench if r.get('format') != 'quick']
quick_rows = [r for r in bench if r.get('format') == 'quick']

groups = {}
for r in hands_rows:
    groups.setdefault((r['nameA'], r['nameB'], r['format']), []).append(r)

sections = []
total_hands = sum(r['hands'] for r in hands_rows) + sum(round(r['handsPerMatch'] * r['matches']) for r in quick_rows)
latencies = []
for r in hands_rows:
    if r['nameA'] == 'expert':
        latencies.append((r['latencyMsA']['mean'], r['hands']))

for fmt in sorted({k[2] for k in groups}, key=lambda x: int(x)):
    rows = []
    for (a, b, f), rs in groups.items():
        if f != fmt or a != 'expert':
            continue
        p = pool(rs)
        rows.append({'key': b, 'label': OPPONENT_NAMES.get(b, b), 'value': p['value'], 'ci': p['ci'], 'hands': p['hands']})
    rows.sort(key=lambda x: x['value'])
    if not rows:
        continue
    sections.append({
        'title': f'Expert against each opponent, {fmt} big blinds deep',
        'chart': {'title': f'Expert win rate at {fmt}bb, in bb/100, with 95% intervals', 'unit': 'bb/100', 'rows': [{'label': x['label'], 'value': x['value'], 'ci': x['ci']} for x in rows if x['key'] != 'random']},
        'table': {'headers': ['Opponent', '#Hands', '#bb/100', '#95% CI'], 'rows': [[x['label'], f"{x['hands']:,}", f"{x['value']:+.1f}", f"±{x['ci']:.1f}"] for x in rows]},
        'note': 'Blueprint only is the same trained model with no live solving, the most direct measure of what the solver adds. The other opponents are hand-written and were never used in training.',
    })

# Quick-match win rates
quick_groups = {}
for r in quick_rows:
    quick_groups.setdefault((r['nameA'], r['nameB']), []).append(r)
if quick_groups:
    tr = []
    for (a, b), rs in sorted(quick_groups.items(), key=lambda kv: kv[0][1]):
        n = sum(r['matches'] for r in rs)
        w = sum(r['wins'] for r in rs)
        p = w / n
        hpm = sum(r['handsPerMatch'] * r['matches'] for r in rs) / n
        tr.append([OPPONENT_NAMES.get(b, b), f'{n:,}', f'{100 * p:.1f}%', f'±{196 * math.sqrt(p * (1 - p) / n):.1f}', f'{hpm:.1f}'])
    sections.append({
        'title': 'Whole quick matches: first to 3,000 chips',
        'text': 'This is the format on the site. Short matches carry a lot of luck, so even a strong player loses some of them.',
        'table': {'headers': ['Expert against', '#Matches', '#Expert wins', '#95% CI', '#Hands per match'], 'rows': tr},
    })

# Slumbot: summary written by research/bench/slumbot_report.js
slumbot_summary = None
sp = os.path.join(results_dir, 'slumbot_summary.json')
if os.path.exists(sp):
    sm = json.load(open(sp, encoding='utf-8'))
    raw, adj = sm['raw'], sm['allInAdjusted']
    slumbot_summary = {'hands': raw['hands'], 'bb100': raw['bb100'], 'ci': raw['ci95'], 'adj': adj['bb100'], 'adjCi': adj['ci95']}
    sections.append({
        'title': 'Slumbot: the independent test',
        'text': 'Slumbot won the 2018 Annual Computer Poker Competition and has a public API. It is the only opponent here I did not write. These matches are 200 big blinds deep with no duplicate deals, so variance is far higher than in the tables above. The second row scores hands where both players were all-in before the river at their expected value over the remaining cards, a standard way to remove some of the luck. It uses the same hands.',
        'table': {'headers': ['Scoring', '#Hands', '#bb/100', '#95% CI', '#mbb/hand'], 'rows': [
            ['Raw chips', f"{raw['hands']:,}", f"{raw['bb100']:+.1f}", f"±{raw['ci95']:.1f}", f"{raw['bb100'] * 10:+.0f}"],
            [f"All-in adjusted ({sm['handsAdjusted']:,} hands)", f"{adj['hands']:,}", f"{adj['bb100']:+.1f}", f"±{adj['ci95']:.1f}", f"{adj['bb100'] * 10:+.0f}"],
        ]},
        'note': 'For scale, published results against Slumbot include ReBeL at +45 ± 5 mbb/hand and Modicum at +11 ± 5, both over far larger samples. A sample this size cannot separate results that close.',
    })

# Local Best Response. A run stopped early has no final line, so its last progress line is used and marked.
lbr = read_jsonl('lbr*.json')
done = {(r['mode'], r['stackBB'], r['fromStreet']) for r in lbr}
for path in glob.glob(os.path.join(results_dir, 'lbr_*.err')):
    import re
    m = re.match(r'lbr_(\w+?)_(\d+)_f(\d)\.err', os.path.basename(path))
    if not m or (m.group(1), int(m.group(2)), int(m.group(3))) in done:
        continue
    last = None
    for line in open(path, encoding='utf-8'):
        mm = re.match(r'(\d+) hands: LBR (-?\d+) \+- (\d+) mbb/hand', line)
        if mm:
            last = mm
    if last:
        lbr.append({'mode': m.group(1), 'stackBB': int(m.group(2)), 'fromStreet': int(m.group(3)), 'hands': int(last.group(1)),
                    'lbrMbb': float(last.group(2)), 'ci95': float(last.group(3)), 'partial': True})
if lbr:
    rows = []
    for r in sorted(lbr, key=lambda x: (x['stackBB'], x['fromStreet'], x['mode'])):
        start = {0: 'preflop', 1: 'flop', 2: 'turn'}[r['fromStreet']]
        rows.append(['Expert' if r['mode'] == 'expert' else 'Blueprint only', f"{r['stackBB']}bb", start, f"{r['hands']:,}" + (' (stopped early)' if r.get('partial') else ''), f"{-r['lbrMbb']:+.0f}", f"±{r['ci95']:.0f}"])
    sections.append({
        'title': 'Local Best Response: how exploitable is it?',
        'text': 'LBR is told the exact strategy, then attacks it greedily, assuming the hand checks down afterwards. If LBR won, that would prove a minimum amount the bot can be exploited by. The table shows how much the bot won against LBR, as in the ReBeL paper: positive means the attack failed. That is evidence, not proof, that the bot is hard to exploit.',
        'table': {'headers': ['Agent', 'Stack', 'LBR plays from', '#Hands', '#Agent mbb/hand', '#95% CI'], 'rows': rows},
        'note': 'For scale, ReBeL beat LBR by 881 ± 94 and DeepStack by 383 ± 112, when LBR had to call through preflop and flop at 200bb (the "turn" rows here).',
    })

# Models
sizes = {}
for path in glob.glob(os.path.join(models_dir, '*')):
    sizes[os.path.basename(path)] = os.path.getsize(path)
manifest = json.load(open(os.path.join(models_dir, 'manifest.json'), encoding='utf-8'))
quick_depths = [d for d in manifest['depths'] if d <= 20]
quick_bytes = sizes.get('flop_buckets.bin.gz', 0) + sum(sizes.get(f'bp_{d}.bin.gz', 0) for d in quick_depths)
solver_bytes = os.path.getsize(os.path.join(models_dir, '..', 'js', 'ai', 'solver.wasm'))
sections.append({
    'title': 'Model size',
    'table': {'headers': ['File', '#Size'], 'rows': [[k, f'{v / 1024:,.0f} KB'] for k, v in sorted(sizes.items()) if k.endswith('.gz')] + [['solver.wasm', f'{solver_bytes / 1024:,.0f} KB']]},
    'note': 'Only the tables for the current stack depth download, and only when a game against the Expert starts.',
})

perf_path = os.path.join(results_dir, 'perf.json')
all_hands = total_hands + sum(r['hands'] for r in lbr) + (slumbot_summary['hands'] if slumbot_summary else 0)
tiles = [{'value': f'{all_hands:,}', 'label': 'hands evaluated: head-to-head, Local Best Response and Slumbot, all on the code the browser runs'}]
if slumbot_summary:
    tiles.append({'value': f"{slumbot_summary['bb100']:+.0f} ± {slumbot_summary['ci']:.0f}", 'label': f"bb/100 against Slumbot over {slumbot_summary['hands']:,} hands"})
tiles.append({'value': f'{(quick_bytes + solver_bytes) / 1048576:.1f} MB', 'label': 'download for a quick match, loaded only when you start'})
if os.path.exists(perf_path):
    perf = json.load(open(perf_path, encoding='utf-8'))
    base = perf['cpu_1x']
    tiles.append({'value': f"{base['turn']['mean'] / 1000:.1f} s", 'label': 'average live turn solve on a laptop, in a background thread'})
    rows = []
    for key, label in [('cpu_1x', 'Laptop'), ('cpu_4x', '4x CPU throttle'), ('cpu_6x', '6x CPU throttle')]:
        s = perf[key]['solverMainThread']
        rows.append([label, f"{s['turn_stride4']['msPerIter']:.0f} ms", f"{s['turn_stride4']['iterationsIn1500ms']}", f"{s['turn_stride6']['iterationsIn1500ms']}", f"{s['river']['msPerIter']:.1f} ms"])
    sections.append({
        'title': 'Speed in the browser',
        'text': f"Measured in Chrome. Preflop and flop decisions took {base['preflop']['mean']:.0f} ms and {base['flop']['mean']:.0f} ms on average. Turn solves are capped at about 1.5 s and river solves at about 0.7 s. The throttled rows are a rough stand-in for phones, not tests on real phones.",
        'table': {'headers': ['Device', '#Turn ms/iter', '#Iterations in 1.5 s (every 4th river)', '#Iterations in 1.5 s (every 6th river)', '#River ms/iter'], 'rows': rows},
    })

os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump({'tiles': tiles, 'sections': sections}, f, indent=1)
print(f'wrote {out_path}: {total_hands:,} hands, {len(sections)} sections')
for s in sections:
    if 'table' in s:
        print('\n## ' + s['title'])
        print(' | '.join(h.lstrip('#') for h in s['table']['headers']))
        for row in s['table']['rows']:
            print(' | '.join(row))

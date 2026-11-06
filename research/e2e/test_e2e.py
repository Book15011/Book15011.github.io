"""End-to-end browser test of the real site, in the installed Chrome.

Plays full matches through the visible buttons at desktop and phone sizes. Checks that chips are conserved after
every hand, that the page never shows the AI's cards during a hand, that there are no console errors, and that
the existing portfolio pages still load.

Usage: python test_e2e.py <base_url> [--levels casual,competitive,expert] [--hands N]
"""
import argparse
import random
import sys
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('base')
parser.add_argument('--levels', default='casual,competitive,expert')
parser.add_argument('--hands', type=int, default=8)
args = parser.parse_args()
BASE = args.base.rstrip('/')
rng = random.Random(1234)
failures = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        failures.append(msg)


def chips(page, sel):
    return int(page.inner_text(f'[data-test={sel}]').replace(',', ''))


def play_hands(page, max_hands, total):
    """Click through hands with random legal choices, checking invariants along the way."""
    hands = 0
    for _ in range(600):
        page.wait_for_selector('[data-test=call],[data-test=check],[data-test=next],[data-test=match-end]', timeout=60000)
        if page.query_selector('[data-test=match-end]'):
            return hands, True
        if page.query_selector('[data-test=next]'):
            hands += 1
            pot_stacks = chips(page, 'my-stack') + chips(page, 'ai-stack')
            check(pot_stacks == total, f'hand {hands}: chips conserved ({pot_stacks})')
            page.click('[data-test=review]')
            page.wait_for_timeout(60)
            check(page.locator('[data-el=panel]').inner_text().strip() != '', f'hand {hands}: AI review has content')
            close = page.locator('.pk-side [aria-label="Close this panel"]')
            if close.is_visible():
                close.click()
                page.wait_for_timeout(300)
            page.click('[data-test=next]')
            page.wait_for_timeout(250)
            if hands >= max_hands:
                return hands, False
            continue
        # While the hand is live, the AI's cards must stay face down.
        down = page.locator('[data-el=aiHole] .pk-card.is-down').count()
        faces = page.locator('[data-el=aiHole] .pk-card[data-card]').count()
        if faces or down != 2:
            check(False, f'AI cards hidden during the hand (down={down}, faces={faces})')
        roll = rng.random()
        fold = page.query_selector('[data-test=fold]:not([disabled])')
        raise_btn = page.query_selector('[data-test=raise]:not([disabled])')
        if raise_btn and roll < 0.25:
            presets = page.locator('.pk-preset')
            presets.nth(rng.randrange(presets.count())).click()
            raise_btn.click()
        elif fold and roll < 0.33:
            fold.click()
        else:
            target = page.query_selector('[data-test=check]') or page.query_selector('[data-test=call]')
            target.click()
        page.wait_for_timeout(60)
    return hands, False


with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    for name, (w, h, mobile) in {'desktop': (1366, 800, False), 'phone': (390, 844, True)}.items():
        ctx = browser.new_context(viewport={'width': w, 'height': h}, has_touch=mobile, is_mobile=mobile)
        for level in args.levels.split(','):
            print(f'== {name} / {level} / standalone page')
            page = ctx.new_page()
            errors = []
            bad = []
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('response', lambda r: bad.append(f'{r.status} {r.url}') if r.status >= 400 and 'localhost' in r.url else None)
            page.goto(f'{BASE}/poker/index.html')
            page.click(f'[data-test=level-{level}]')
            page.click('[data-test=start]')
            count, ended = play_hands(page, args.hands, 4000)
            check(count >= 1, f'played {count} hands (match ended: {ended})')
            overflow = page.evaluate('document.documentElement.scrollWidth > innerWidth + 1')
            check(not overflow, 'no sideways overflow')
            check(not errors, f'no console errors {errors[:3]}')
            check(not bad, f'no failed requests {bad[:3]}')
            page.close()

        print(f'== {name} / modal on the Quant page')
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(f'{BASE}/quant.html')
        page.wait_for_selector('#poker')
        page.locator('#poker [data-poker-open]').click()
        page.wait_for_selector('[data-test=start]', timeout=20000)
        check(page.locator('.pk-modal').count() == 1, 'game opens in a modal without leaving the page')
        check(page.url.endswith('quant.html'), 'the page did not navigate away')
        page.click('[data-test=level-casual]')
        page.click('[data-test=start]')
        count, _ = play_hands(page, 2, 4000)
        check(count >= 1, f'played {count} hands inside the modal')
        page.keyboard.press('Escape')
        page.wait_for_timeout(150)
        check(not page.locator('.pk-modal').first.is_visible(), 'Escape closes the modal')
        check(page.evaluate("document.body.style.overflow") == '', 'page scroll is restored')
        page.locator('#poker [data-poker-open]').click()
        page.wait_for_timeout(150)
        check(page.locator('.pk-modal').first.is_visible(), 'reopening returns to the same match')
        page.close()
        ctx.close()

    print('== Existing portfolio pages still load')
    ctx = browser.new_context()
    for path in ['index.html', 'quant.html', 'robotics-home.html', 'robotics.html', 'about.html', 'projects.html', 'contact.html', 'thanks.html', 'poker/how-it-works.html']:
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        res = page.goto(f'{BASE}/{path}', wait_until='domcontentloaded')
        page.wait_for_timeout(300)
        check(res.status == 200 and not errors, f'{path}: HTTP {res.status}, page errors {errors[:2]}')
        page.close()
    browser.close()

print(f'\n{len(failures)} failures')
for f in failures:
    print(' -', f)
sys.exit(1 if failures else 0)

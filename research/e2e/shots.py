"""Screenshots of the game at desktop and phone sizes, using the installed Chrome.

Usage: python shots.py <base_url> <out_dir> [level] [page]
"""
import sys
from playwright.sync_api import sync_playwright

base = sys.argv[1].rstrip('/')
out = sys.argv[2]
level = sys.argv[3] if len(sys.argv) > 3 else 'competitive'
page_path = sys.argv[4] if len(sys.argv) > 4 else 'poker/index.html'

VIEWPORTS = {'desktop': (1366, 800, False), 'phone': (390, 844, True)}


def wait_for_turn(page, timeout=30000):
    page.wait_for_selector('[data-test=call],[data-test=check],[data-test=next]', timeout=timeout)


with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    for name, (w, h, mobile) in VIEWPORTS.items():
        ctx = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=1.5 if mobile else 1, has_touch=mobile, is_mobile=mobile)
        page = ctx.new_page()
        errors = []
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(f'{base}/{page_path}')
        page.wait_for_selector('[data-test=start]')
        page.wait_for_timeout(400)
        page.screenshot(path=f'{out}/{name}_menu.png')
        page.click(f'[data-test=level-{level}]')
        page.click('[data-test=start]')
        wait_for_turn(page, 60000)
        page.wait_for_timeout(900)
        page.screenshot(path=f'{out}/{name}_preflop.png')
        # Play check/call until a hand ends, photographing the board along the way.
        took_board = False
        for _ in range(30):
            wait_for_turn(page, 60000)
            if page.query_selector('[data-test=next]'):
                break
            if not took_board and page.locator('[data-test=board] .pk-card').count() >= 3:
                page.wait_for_timeout(500)
                page.screenshot(path=f'{out}/{name}_flop.png')
                took_board = True
            target = page.query_selector('[data-test=check]') or page.query_selector('[data-test=call]')
            target.click()
            page.wait_for_timeout(200)
        page.wait_for_timeout(900)
        page.screenshot(path=f'{out}/{name}_result.png')
        page.click('[data-test=review]')
        page.wait_for_timeout(400)
        page.screenshot(path=f'{out}/{name}_review.png')
        print(name, 'console errors:', errors)
        ctx.close()
    browser.close()

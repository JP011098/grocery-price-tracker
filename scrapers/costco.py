"""
Costco.ca. Product pages are public (no login needed to see most prices)
but the price is filled in client-side by JavaScript, so a plain request
usually returns an empty shell. We try static extraction first (cheap,
fast, and sometimes works if Costco changes their rendering), then fall
back to Playwright to actually render the page.
"""

from . import base


def scrape(url):
    html = base.fetch_html(url)
    price, method = base.extract_price_static(html)

    if price is None:
        rendered = base.render_with_playwright(
            url, wait_selector="[automation-id*=price]", wait_ms=6000
        )
        if rendered:
            price, method = base.extract_price_static(rendered)
        elif rendered is None:
            method = "playwright_not_installed"

    return base.result(price, method=method)

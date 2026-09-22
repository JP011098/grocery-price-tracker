"""
FreshCo (Empire/Sobeys banner). Same generic static-first strategy as
Superstore - try JSON-LD / embedded JSON before reaching for a browser.
FreshCo sometimes gates prices behind a store/postal-code selection;
if extract_price_static keeps returning None for a URL that works fine
in your own browser, note it in scrape_notes.md - it likely needs a
store cookie set, which the Playwright path below handles by letting
the page fully load first.
"""

from . import base


def scrape(url):
    html = base.fetch_html(url)
    price, method = base.extract_price_static(html)

    if price is None:
        rendered = base.render_with_playwright(url, wait_selector="[class*=price]")
        if rendered:
            price, method = base.extract_price_static(rendered)

    return base.result(price, method=method)

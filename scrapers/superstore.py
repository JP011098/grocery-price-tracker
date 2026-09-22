"""
Real Canadian Superstore / No Frills (Loblaws family, Next.js sites).
These usually expose price data in static HTML (JSON-LD or __NEXT_DATA__),
so a plain request is normally enough - no headless browser needed.
"""

from . import base


def scrape(url):
    html = base.fetch_html(url)
    price, method = base.extract_price_static(html)

    if price is None:
        # Fall back to rendering, in case the page changed its structure
        rendered = base.render_with_playwright(url, wait_selector="[class*=price]")
        if rendered:
            price, method = base.extract_price_static(rendered)

    return base.result(price, method=method)

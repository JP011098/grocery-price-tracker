"""
Costco.ca. Product pages are public (no login needed to see most
prices) but are filled in by JavaScript, so - same as the other three
now - a plain request is just a quick free check before rendering.
"""

from . import base


def scrape(url, unit="each"):
    try:
        html = base.fetch_html(url)
        price, method = base.extract_price_static(html)
        if price is not None:
            return base.result(price, method=method)
    except Exception:
        pass  # plain request failed (blocked, timed out, etc) - fall through to a real render

    price, method = base.render_and_extract(url, wait_ms=6000)
    return base.result(price, method=method)

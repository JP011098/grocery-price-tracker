"""
Walmart.ca. Fair warning: this one has real bot protection (Cloudflare-
style challenge pages) and is the most likely to break or come back
empty. Treat it as best-effort - run.py is written so a Walmart failure
never takes down the rest of the run, it just keeps the last known price
and flags it as stale in prices.json.

If this stops working entirely, the practical options are:
1. Drop Walmart tracking for now and rely on Superstore/FreshCo/Costco.
2. Point it at a paid scraping API (a few exist specifically for
   bot-protected Canadian retail sites) instead of scraping directly.
This file is deliberately simple so swapping in an API later is a
one-function change.
"""

from . import base


def scrape(url):
    try:
        html = base.fetch_html(url)
    except Exception as exc:  # noqa: BLE001 - we want to keep going either way
        return base.result(None, method="request_failed", raw=str(exc))

    if "challenge" in html.lower() or "captcha" in html.lower():
        return base.result(None, method="blocked_by_bot_protection")

    price, method = base.extract_price_static(html)

    if price is None:
        rendered = base.render_with_playwright(url, wait_selector="[itemprop=price]", wait_ms=6000)
        if rendered:
            if "challenge" in rendered.lower() or "captcha" in rendered.lower():
                return base.result(None, method="blocked_by_bot_protection")
            price, method = base.extract_price_static(rendered)
        elif rendered is None:
            method = "playwright_not_installed"

    return base.result(price, method=method)

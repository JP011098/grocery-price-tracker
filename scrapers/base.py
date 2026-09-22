"""
Shared helpers used by every store-specific scraper.

Strategy, in order of preference:
1. Plain HTTP GET with browser-like headers, then look for schema.org
   JSON-LD ("application/ld+json") Product/offers price data embedded
   in the page. Most retail sites include this for SEO even when the
   visible price is rendered by JavaScript.
2. Look for a Next.js "__NEXT_DATA__" JSON blob (Loblaws-family sites
   are built on Next.js and embed the full page state there).
3. Fall back to a regex price search in the raw HTML as a last resort.
4. If nothing works and a headless browser is available, render the
   page with Playwright and repeat steps 1-3 against the rendered DOM.

Every function returns a dict:
    {"price": float | None, "currency": "CAD", "raw": <debug string>, "method": <str>}
so run.py can log *why* a scrape failed, not just that it did.
"""

import json
import re
import time
from datetime import datetime, timezone

import requests

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-CA,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
}

PRICE_REGEX = re.compile(r"\$\s?(\d{1,4}(?:\.\d{2})?)")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def fetch_html(url, session=None, timeout=20):
    s = session or requests.Session()
    resp = s.get(url, headers=HEADERS, timeout=timeout)
    resp.raise_for_status()
    return resp.text


def extract_price_from_jsonld(html):
    """Look for schema.org Product/Offer price in <script type=application/ld+json>."""
    blocks = re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html,
        re.DOTALL | re.IGNORECASE,
    )
    for block in blocks:
        try:
            data = json.loads(block.strip())
        except (json.JSONDecodeError, ValueError):
            continue
        candidates = data if isinstance(data, list) else [data]
        for item in candidates:
            price = _dig_price(item)
            if price is not None:
                return price
    return None


def _dig_price(node):
    if not isinstance(node, dict):
        return None
    offers = node.get("offers")
    if isinstance(offers, dict):
        p = offers.get("price") or offers.get("lowPrice")
        if p is not None:
            try:
                return float(p)
            except (TypeError, ValueError):
                pass
    if isinstance(offers, list):
        for o in offers:
            if isinstance(o, dict) and o.get("price"):
                try:
                    return float(o["price"])
                except (TypeError, ValueError):
                    continue
    # Some sites nest the Product inside @graph
    graph = node.get("@graph")
    if isinstance(graph, list):
        for g in graph:
            p = _dig_price(g)
            if p is not None:
                return p
    return None


def extract_price_from_next_data(html):
    """Loblaws-family sites (Superstore, No Frills, etc.) are Next.js apps."""
    match = re.search(
        r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL
    )
    if not match:
        return None
    try:
        data = json.loads(match.group(1))
    except (json.JSONDecodeError, ValueError):
        return None
    text_blob = json.dumps(data)
    # Look for the common Loblaws price shape: {"price": {"value": 4.99, ...}}
    price_matches = re.findall(r'"value"\s*:\s*([\d.]+)\s*[,}].{0,40}"currency"', text_blob)
    if price_matches:
        try:
            return float(price_matches[0])
        except ValueError:
            pass
    return None


def extract_price_regex(html):
    match = PRICE_REGEX.search(html)
    if match:
        try:
            return float(match.group(1))
        except ValueError:
            return None
    return None


def extract_price_static(html):
    """Run all static-HTML strategies in order; return (price, method) or (None, None)."""
    price = extract_price_from_jsonld(html)
    if price is not None:
        return price, "jsonld"
    price = extract_price_from_next_data(html)
    if price is not None:
        return price, "next_data"
    price = extract_price_regex(html)
    if price is not None:
        return price, "regex_fallback"
    return None, None


def render_with_playwright(url, wait_selector=None, wait_ms=4000):
    """
    Render a JS-heavy page and return its final HTML.
    Requires: pip install playwright && playwright install chromium
    Returns None if Playwright isn't installed, so callers can degrade
    gracefully instead of crashing the whole run.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(user_agent=HEADERS["User-Agent"])
        try:
            page.goto(url, timeout=30000)
            if wait_selector:
                try:
                    page.wait_for_selector(wait_selector, timeout=wait_ms)
                except Exception:
                    pass
            else:
                page.wait_for_timeout(wait_ms)
            html = page.content()
        finally:
            browser.close()
    return html


def result(price, currency="CAD", method=None, raw=None):
    return {
        "price": price,
        "currency": currency,
        "method": method,
        "fetched_at": now_iso(),
        "raw": raw,
    }

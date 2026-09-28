"""
Shared helpers used by every store-specific scraper.

Extraction strategy, in order - each step only runs if the one before
it found nothing (never overwritten by a "maybe" match):
1. Plain HTTP GET, then look for schema.org JSON-LD or a Next.js
   __NEXT_DATA__ blob in the STATIC html. This works only on sites
   that server-render their price; several of ours (Superstore,
   FreshCo, Costco) are client-rendered apps where a plain GET returns
   an almost-empty shell, so this step legitimately finds nothing for
   them most of the time - that's expected, not a bug.
2. Render the page with Playwright (real headless Chrome), then retry
   JSON-LD / __NEXT_DATA__ against the RENDERED html - once the JS has
   actually run, the real data is usually there.
3. If that still finds nothing, scan only the DOM elements whose
   class/id/data-testid mentions "price" and regex within just those
   (not the whole page) - narrow enough to avoid matching unrelated
   dollar amounts elsewhere on the page (promos, delivery-fee banners,
   etc).
4. If nothing legitimate turns up, return price=None. We deliberately
   do NOT fall back to a blind whole-page regex anymore - an earlier
   version did this and it was silently matching an unrelated "$2.50"
   that appeared on every Superstore page (likely a delivery-fee
   banner in the static shell), which is worse than reporting no price.

Every function returns a dict:
    {"price": float | None, "currency": "CAD", "method": <str>, "fetched_at": <iso>, "raw": <debug string>}
so run.py can log *why* a scrape found (or didn't find) a price.
"""

import json
import re
from contextlib import contextmanager
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
CENTS_REGEX = re.compile(r"(\d{1,3}(?:\.\d+)?)\s?¢")


def parse_money(text):
    """Parses '$4.34', '$4.34/kg', '58¢', or '43¢/100g' -> a float in dollars.
    Some sites (Walmart.ca) show weight-based prices in cents, not dollars."""
    if not text:
        return None
    m = PRICE_REGEX.search(text)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass
    m = CENTS_REGEX.search(text)
    if m:
        try:
            return float(m.group(1)) / 100
        except ValueError:
            pass
    return None


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
    price_matches = re.findall(r'"value"\s*:\s*([\d.]+)\s*[,}].{0,40}"currency"', text_blob)
    if price_matches:
        try:
            return float(price_matches[0])
        except ValueError:
            pass
    return None


def extract_price_static(html):
    """JSON-LD / __NEXT_DATA__ only - no blind whole-page regex. Returns (price, method)."""
    price = extract_price_from_jsonld(html)
    if price is not None:
        return price, "jsonld"
    price = extract_price_from_next_data(html)
    if price is not None:
        return price, "next_data"
    return None, None


# JS snippet run inside the rendered page: collects the text of every
# element whose class/id/data-testid mentions "price", so the regex
# pass afterward only ever looks at price-labelled elements instead of
# the whole page.
_PRICE_ELEMENTS_JS = """
() => {
  const els = Array.from(document.querySelectorAll('[class*="price" i], [id*="price" i], [data-testid*="price" i]'));
  return els.map(el => el.innerText || el.textContent || "").filter(Boolean).slice(0, 40);
}
"""


def extract_price_from_dom_elements(page):
    """Scoped last resort: regex only within elements that are themselves labelled 'price'."""
    try:
        texts = page.evaluate(_PRICE_ELEMENTS_JS)
    except Exception:
        return None
    for text in texts:
        match = PRICE_REGEX.search(text)
        if match:
            try:
                return float(match.group(1))
            except ValueError:
                continue
    return None


def render_and_extract(url, wait_ms=5000):
    """
    Render a page with Playwright and try every extraction strategy
    against the result: JSON-LD/__NEXT_DATA__ first, then price-scoped
    DOM elements. Returns (price, method). (None, "playwright_not_installed")
    if Playwright isn't available, so callers degrade gracefully.
    Used by stores without a known-good selector yet (currently Costco) -
    stores with one (Superstore, FreshCo, Walmart) use rendered_page()
    below with a store-specific extraction function instead.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None, "playwright_not_installed"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(user_agent=HEADERS["User-Agent"])
        try:
            page.goto(url, timeout=30000)
            page.wait_for_timeout(wait_ms)
            html = page.content()

            price, method = extract_price_static(html)
            if price is not None:
                return price, f"rendered_{method}"

            price = extract_price_from_dom_elements(page)
            if price is not None:
                return price, "rendered_dom_price_element"

            return None, "rendered_no_price_found"
        finally:
            browser.close()


@contextmanager
def rendered_page(url, wait_ms=5000):
    """
    Context manager yielding a loaded, rendered Playwright `page` for
    custom per-store extraction (known CSS selectors, not just generic
    guessing). Yields None if Playwright isn't installed, so callers can
    check for that and degrade gracefully instead of crashing.
    Uses a realistic browser profile (Canadian locale, normal desktop
    window size, automation flag hidden) since some sites treat the
    default headless profile differently from a real visitor.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        yield None
        return

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context(
            user_agent=HEADERS["User-Agent"],
            locale="en-CA",
            viewport={"width": 1366, "height": 900},
        )
        page = context.new_page()
        try:
            page.goto(url, timeout=30000)
            page.wait_for_timeout(wait_ms)
            yield page
        finally:
            browser.close()


def page_diagnostics(page, max_chars=300):
    """A short description of what the page actually shows (title plus the
    start of its visible text). Recorded when no price is found, so we can
    see WHY - a store-selection prompt, a block page, an empty shell, etc."""
    try:
        title = page.title()
    except Exception:
        title = ""
    try:
        body = page.evaluate("() => (document.body && document.body.innerText) || ''")
    except Exception:
        body = ""
    body = " ".join(str(body).split())[:max_chars]
    return f"title={title!r} body={body!r}"


_BLOCK_PAGE_PHRASES = (
    "robot or human",
    "verify you are human",
    "verify you're human",
    "are you a robot",
    "press & hold",
    "press and hold",
    "access denied",
    "unusual traffic",
    "captcha",
)


def looks_like_block_page(diagnostics_text):
    """True only if the VISIBLE page text (not scripts) reads like a bot-check page."""
    text = (diagnostics_text or "").lower()
    return any(phrase in text for phrase in _BLOCK_PAGE_PHRASES)


def result(price, currency="CAD", method=None, raw=None):
    return {
        "price": price,
        "currency": currency,
        "method": method,
        "fetched_at": now_iso(),
        "raw": raw,
    }

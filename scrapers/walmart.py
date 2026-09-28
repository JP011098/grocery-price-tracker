"""
Walmart.ca. Has real bot protection on top of being JS-rendered, so
this is the least reliable store - treated as best-effort, a Walmart
failure never blocks the rest of a run.

Known structure (confirmed Sept 2026): the main price sits in an
element with itemprop="price" (a clean, semantic hook), and weight-sold
items ALSO show a per-100g reference price under
[data-seo-id="hero-unit-price"]. Walmart shows small prices in CENTS
("58c"), not dollars - base.parse_money() handles both, and also copes
with sale text like "Now $4.97".

An earlier version declared a page "blocked" if the raw HTML contained
the word "captcha" or "challenge" anywhere - but normal pages mention
those words in their scripts, so it could give up before even trying
to read a price. Now we always render and try to read the price first,
and only call it blocked if the VISIBLE page text looks like a
bot-check page. On any failure the page title/text is recorded in the
result's "raw" field so we can see what actually happened.
"""

from . import base

_HERO_PRICE_SELECTOR = '[itemprop="price"]'
_HERO_UNIT_PRICE_SELECTOR = '[data-seo-id="hero-unit-price"]'


def _extract(page, unit):
    if unit == "kg":
        unit_el = page.query_selector(_HERO_UNIT_PRICE_SELECTOR)
        if unit_el:
            text = (unit_el.inner_text() or "").lower()
            value = base.parse_money(text)
            if value is not None:
                if "100g" in text:
                    return round(value * 10, 2), "walmart_unit_price_100g_to_kg"
                if "kg" in text:
                    return value, "walmart_unit_price_kg"
                if "lb" in text:
                    return round(value / 0.453592, 2), "walmart_unit_price_lb_to_kg"

    hero_el = page.query_selector(_HERO_PRICE_SELECTOR)
    if hero_el:
        price = base.parse_money(hero_el.inner_text())
        if price is not None:
            return price, "walmart_hero_price"

    return None, None


def scrape(url, unit="each"):
    try:
        with base.rendered_page(url, wait_ms=7000) as page:
            if page is None:
                return base.result(None, method="playwright_not_installed")

            price, method = _extract(page, unit)
            if price is not None:
                return base.result(price, method=method)

            price = base.extract_price_from_dom_elements(page)
            if price is not None:
                return base.result(price, method="rendered_dom_price_element_fallback")

            diagnostics = base.page_diagnostics(page)
            if base.looks_like_block_page(diagnostics):
                return base.result(None, method="blocked_by_bot_protection", raw=diagnostics)
            return base.result(None, method="rendered_no_price_found", raw=diagnostics)
    except Exception as exc:  # noqa: BLE001
        return base.result(None, method="render_failed", raw=str(exc)[:300])

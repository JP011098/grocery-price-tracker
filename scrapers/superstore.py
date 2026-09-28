"""
Real Canadian Superstore / No Frills (Loblaws family). Client-rendered
Next.js app - a plain request returns an empty shell, so this goes
straight to a real render.

Known structure (confirmed from inspect-element snippets, Sept 2026):
the main price sits inside a `.selling-price-list__item` container, in
a span whose class contains "price__value" - but the FULL class name
differs depending on whether the item is on sale
("...--sale__value") or not ("...--now-price__value"). An earlier
version of this file only matched the "now-price" variant, so any
item currently on sale silently returned no price at all. Scoping to
the container and matching any "price__value" class inside it covers
both cases with one rule.

For weight-sold items there's ALSO a separate comparison-price-list
with real per-kg (or per-100g, or per-lb) reference prices - that's
what kg-tracked products should use instead of the per-item estimate.
"""

from . import base

_MAIN_PRICE_CONTAINER = ".selling-price-list__item"
_VALUE_IN_CONTAINER = '[class*="price__value"]'
_COMPARISON_ITEM_SELECTOR = ".comparison-price-list__item"


def _kg_from_comparison(page):
    for item in page.query_selector_all(_COMPARISON_ITEM_SELECTOR):
        unit_el = item.query_selector('[class*="price__unit"]')
        value_el = item.query_selector('[class*="price__value"]')
        if not unit_el or not value_el:
            continue
        unit_text = (unit_el.inner_text() or "").lower()
        value = base.parse_money(value_el.inner_text())
        if value is None:
            continue
        if "100g" in unit_text:
            return round(value * 10, 2)
        if "kg" in unit_text and "lb" not in unit_text:
            return value
    return None


def _main_price(page):
    container = page.query_selector(_MAIN_PRICE_CONTAINER)
    scope = container or page
    value_el = scope.query_selector(_VALUE_IN_CONTAINER)
    if value_el:
        return base.parse_money(value_el.inner_text())
    return None


def _extract(page, unit):
    if unit == "kg":
        price = _kg_from_comparison(page)
        if price is not None:
            return price, "superstore_comparison_kg"

    price = _main_price(page)
    if price is not None:
        return price, "superstore_main_price"

    return None, None


def scrape(url, unit="each"):
    try:
        html = base.fetch_html(url)
        price, method = base.extract_price_static(html)
        if price is not None:
            return base.result(price, method=method)
    except Exception:
        pass  # plain request failed (blocked, timed out, etc) - fall through to a real render

    with base.rendered_page(url) as page:
        if page is None:
            return base.result(None, method="playwright_not_installed")

        price, method = _extract(page, unit)
        if price is not None:
            return base.result(price, method=method)

        price = base.extract_price_from_dom_elements(page)
        if price is not None:
            return base.result(price, method="rendered_dom_price_element_fallback")

        return base.result(None, method="rendered_no_price_found")

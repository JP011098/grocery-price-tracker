"""
Walmart.ca. Has real bot protection on top of being JS-rendered, so
this is still the most likely to come back empty - treated as
best-effort, a Walmart failure never blocks the rest of a run.

Known structure (confirmed Sept 2026): the main price sits in an
element with itemprop="price" (a clean, semantic hook), and weight-sold
items ALSO show a per-100g reference price under
[data-seo-id="hero-unit-price"]. Important: Walmart shows small prices
in CENTS ("58¢"), not dollars - base.parse_money() handles both.
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
        html = base.fetch_html(url)
    except Exception as exc:  # noqa: BLE001
        return base.result(None, method="request_failed", raw=str(exc))

    if "challenge" in html.lower() or "captcha" in html.lower():
        return base.result(None, method="blocked_by_bot_protection")

    price, method = base.extract_price_static(html)
    if price is not None:
        return base.result(price, method=method)

    with base.rendered_page(url, wait_ms=6000) as page:
        if page is None:
            return base.result(None, method="playwright_not_installed")

        rendered_html = page.content()
        if "challenge" in rendered_html.lower() or "captcha" in rendered_html.lower():
            return base.result(None, method="blocked_by_bot_protection")

        price, method = _extract(page, unit)
        if price is not None:
            return base.result(price, method=method)

        price = base.extract_price_from_dom_elements(page)
        if price is not None:
            return base.result(price, method="rendered_dom_price_element_fallback")

        return base.result(None, method="rendered_no_price_found")

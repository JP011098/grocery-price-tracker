"""
FreshCo (Empire/Sobeys banner). No semantic price class names - matches
on the SHAPE of the price text ("$5.49" or "$5.49/kg") instead.

On sale items, FreshCo shows the current price in a span classed
"text-red400" and the crossed-out original price in a span classed
"...line-through...". We explicitly prefer the "text-red400" price and
explicitly skip anything "line-through", rather than relying on which
one happens to appear first in the page.
"""

from . import base

_PRICE_TEXT_JS = r"""
() => {
  const regex = /^\$\d+\.\d{2}(?:\/(?:kg|lb|ea))?$/;
  const sale = [];
  const plain = [];
  for (const el of document.querySelectorAll('span, p, div')) {
    const cls = (el.className && el.className.includes) ? el.className : '';
    if (cls.includes('line-through')) continue;  // crossed-out "was" price
    const text = (el.innerText || '').trim();
    if (!regex.test(text)) continue;
    if (cls.includes('text-red400')) sale.push(text);
    else plain.push(text);
  }
  return { sale, plain };
}
"""


def _pick(texts, unit):
    if unit == "kg":
        kg = [t for t in texts if t.endswith("/kg")]
        if kg:
            return kg[0]
    no_slash = [t for t in texts if "/" not in t]
    if no_slash:
        return no_slash[0]
    return texts[0] if texts else None


def _extract(page, unit):
    try:
        found = page.evaluate(_PRICE_TEXT_JS)
    except Exception:
        return None, None

    text = _pick(found.get("sale", []), unit)
    if text:
        return base.parse_money(text), "freshco_sale_price"

    text = _pick(found.get("plain", []), unit)
    if text:
        return base.parse_money(text), "freshco_plain_price"

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

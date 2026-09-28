"""
Reads products.json (each product = one or more brand/store variants),
scrapes every variant, and writes:
  - data/prices.json   current snapshot: every variant's price, plus the
                        cheapest one per product and a trend flag for
                        products with "track_drop" in their modes
  - data/history.json  append-only log, one entry per scrape
  - data/status.json   health summary for THIS run: when it ran, how
                        many variants succeeded/failed overall and per
                        store. This is what tells you the scraper is
                        actually working, separate from any one item's
                        price - see scraper-health section in the README.

Grocery-list features (My List, widget mode, adding products) all live
on the phone in scriptable/grocery-app.js and read/write prices.json +
products.json - this script's only job is keeping prices.json and
status.json accurate.
"""

import json
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from scrapers import costco, freshco, superstore, walmart

ROOT = Path(__file__).parent
PRODUCTS_FILE = ROOT / "products.json"
PRICES_FILE = ROOT / "data" / "prices.json"
HISTORY_FILE = ROOT / "data" / "history.json"
STATUS_FILE = ROOT / "data" / "status.json"

STORE_SCRAPERS = {
    "superstore": superstore.scrape,
    "freshco": freshco.scrape,
    "costco": costco.scrape,
    "walmart": walmart.scrape,
}

DELAY_SECONDS = 2  # be polite between requests

# If the overall success rate for this run falls below this, run.py
# exits non-zero so the GitHub Actions run shows red / can email you.
# Data still gets committed either way - see scrape.yml's "if: always()".
MIN_HEALTHY_SUCCESS_RATE = 0.4


def load_json(path, default):
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def variant_key(variant):
    return f"{variant['store']}|{variant.get('brand', '')}|{variant['url']}"


def scrape_variant(variant, unit="each"):
    scraper = STORE_SCRAPERS.get(variant["store"])
    if scraper is None:
        return {"price": None, "currency": "CAD", "method": "unknown_store", "fetched_at": None, "raw": None}
    try:
        return scraper(variant["url"], unit)
    except Exception as exc:  # noqa: BLE001
        return {"price": None, "currency": "CAD", "method": "unhandled_error", "fetched_at": None, "raw": str(exc)}


def main():
    config = load_json(PRODUCTS_FILE, {"products": []})
    current_prices = load_json(PRICES_FILE, {})
    history = load_json(HISTORY_FILE, [])

    store_stats = defaultdict(lambda: {"attempted": 0, "succeeded": 0})
    failures = []
    total_attempted = 0
    total_succeeded = 0

    for product in config["products"]:
        pid = product["id"]
        variants = product.get("variants", [])
        prev_entry = current_prices.get(pid, {})
        prev_cheapest_price = (prev_entry.get("cheapest") or {}).get("price")

        entry = {
            "name": product["name"],
            "modes": product.get("modes", []),
            "category": product.get("category", "other"),
            "unit": product.get("unit", "each"),
            "variants": {},
        }
        if not variants:
            entry["cheapest"] = None
            entry["trend"] = None
            current_prices[pid] = entry
            continue

        for variant in variants:
            store = variant["store"]

            if variant.get("manual"):
                # Manually-entered price (e.g. Costco, where the site is
                # unreliable and/or hides in-store promo pricing) - never
                # scraped, just carried forward as-is.
                outcome = {
                    "price": variant.get("manual_price"),
                    "currency": "CAD",
                    "method": "manual_entry",
                    "fetched_at": variant.get("manual_price_updated") or datetime.now(timezone.utc).isoformat(),
                    "raw": None,
                }
            else:
                print(f"Scraping {product['name']} [{variant.get('brand') or store}] @ {store} ...")
                outcome = scrape_variant(variant, entry["unit"])

            total_attempted += 1
            store_stats[store]["attempted"] += 1
            if outcome["price"] is not None:
                total_succeeded += 1
                store_stats[store]["succeeded"] += 1
            else:
                failures.append({
                    "product": product["name"],
                    "store": store,
                    "brand": variant.get("brand", ""),
                    "method": outcome["method"],
                    "detail": (outcome.get("raw") or "")[:300],
                })

            history.append({
                "product_id": pid,
                "product_name": product["name"],
                "store": store,
                "brand": variant.get("brand", ""),
                "url": variant["url"],
                **outcome,
            })

            key = variant_key(variant)
            prev_variant = (prev_entry.get("variants") or {}).get(key, {})

            if outcome["price"] is not None:
                entry["variants"][key] = {
                    "store": store,
                    "brand": variant.get("brand", ""),
                    "url": variant["url"],
                    "price": outcome["price"],
                    "currency": outcome.get("currency", "CAD"),
                    "last_updated": outcome["fetched_at"],
                    "stale": False,
                    "manual": bool(variant.get("manual")),
                    "manual_source": variant.get("manual_source", ""),
                }
            else:
                entry["variants"][key] = {
                    "store": store,
                    "brand": variant.get("brand", ""),
                    "url": variant["url"],
                    "price": prev_variant.get("price"),
                    "currency": prev_variant.get("currency", "CAD"),
                    "last_updated": prev_variant.get("last_updated"),
                    "stale": True,
                    "last_attempt_method": outcome["method"],
                }

            if not variant.get("manual"):
                time.sleep(DELAY_SECONDS)

        priced = [x for x in entry["variants"].values() if x["price"] is not None]
        if priced:
            cheapest = min(priced, key=lambda x: x["price"])
            entry["cheapest"] = {
                "store": cheapest["store"],
                "brand": cheapest["brand"],
                "price": cheapest["price"],
                "currency": cheapest["currency"],
                "url": cheapest["url"],
                "stale": cheapest["stale"],
                "manual": cheapest.get("manual", False),
                "manual_source": cheapest.get("manual_source", ""),
                "last_updated": cheapest.get("last_updated"),
            }
        else:
            entry["cheapest"] = None

        if "track_drop" in entry["modes"] and entry["cheapest"] and prev_cheapest_price is not None:
            if entry["cheapest"]["price"] < prev_cheapest_price:
                entry["trend"] = "down"
            elif entry["cheapest"]["price"] > prev_cheapest_price:
                entry["trend"] = "up"
            else:
                entry["trend"] = "same"
        else:
            entry["trend"] = None

        current_prices[pid] = entry

    save_json(PRICES_FILE, current_prices)
    save_json(HISTORY_FILE, history)

    # Safety net: if 3+ different products at the same store landed on the
    # exact same price this run, that's very likely the scraper matching
    # something unrelated (a promo banner, a placeholder) rather than real
    # prices - the same failure mode this file was built to catch. Surface
    # it in status.json instead of silently trusting it.
    by_store_price = defaultdict(set)
    for pid, entry in current_prices.items():
        for variant in entry.get("variants", {}).values():
            if variant.get("price") is not None and not variant.get("stale"):
                by_store_price[(variant["store"], variant["price"])].add(entry["name"])

    duplicate_warnings = [
        {"store": store, "price": price, "product_count": len(names), "products": sorted(names)}
        for (store, price), names in by_store_price.items()
        if len(names) >= 3
    ]

    success_rate = (total_succeeded / total_attempted) if total_attempted else 0
    status = {
        "last_run": datetime.now(timezone.utc).isoformat(),
        "total_attempted": total_attempted,
        "total_succeeded": total_succeeded,
        "success_rate": round(success_rate, 3),
        "by_store": {
            store: {
                "attempted": s["attempted"],
                "succeeded": s["succeeded"],
                "success_rate": round(s["succeeded"] / s["attempted"], 3) if s["attempted"] else 0,
            }
            for store, s in store_stats.items()
        },
        "failures": failures,
        "duplicate_price_warnings": duplicate_warnings,
        "healthy": success_rate >= MIN_HEALTHY_SUCCESS_RATE and not duplicate_warnings,
    }
    save_json(STATUS_FILE, status)

    print(f"\nDone. {total_succeeded}/{total_attempted} variants scraped successfully "
          f"({success_rate:.0%}). Wrote {PRICES_FILE}, {HISTORY_FILE}, {STATUS_FILE}.")

    if duplicate_warnings:
        print(f"\n⚠️  {len(duplicate_warnings)} suspicious duplicate-price group(s) found - "
              "see data/status.json 'duplicate_price_warnings'.")

    if not status["healthy"]:
        print(f"\n⚠️  Marking this run as unhealthy (data was still saved).")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

# Grocery Price Tracker

![scrape status](https://github.com/YOUR_GITHUB_USERNAME/grocery-price-tracker/actions/workflows/scrape.yml/badge.svg)

Tracks prices for your grocery list across Real Canadian Superstore,
FreshCo, Costco.ca, and Walmart.ca (Calgary), compares multiple
brands/variants of the same item, flags price drops, and shows it all
in a Scriptable app + home-screen widget on your iPhone.

## How it's built

- `products.json` — every tracked product, each with one or more
  **variants** (a specific brand's URL at a specific store) and
  **modes** (`compare_cheapest`, `track_drop`, or both)
- `scrapers/` — one file per store; each variant is scraped with
  whichever store it's tagged with
- `run.py` — scrapes every variant, works out the cheapest one per
  product, and (for `track_drop` products) flags whether the price
  went up/down/same since the last run
- `data/prices.json` — current snapshot the app/widget read
- `data/history.json` — every scrape ever recorded
- `.github/workflows/scrape.yml` — runs `run.py` twice a day and
  commits the updated data automatically
- `scriptable/grocery-app.js` — **one script, two jobs**:
  - Run it directly in Scriptable → interactive menu (build "My
    List", view cheapest prices, add new products, trigger a scrape,
    check for price drops)
  - Add it as a home-screen widget → shows either "My List" or "All
    Products," whichever you've picked

## Setup

1. **Push this to a new GitHub repo**:
   ```
   cd grocery-price-tracker
   git init && git add . && git commit -m "Initial setup"
   git branch -M main
   git remote add origin https://github.com/<you>/grocery-price-tracker.git
   git push -u origin main
   ```

2. **Test the scraper locally first**:
   ```
   pip install -r requirements.txt
   playwright install chromium
   python run.py
   ```
   Check `data/prices.json` — any variant with `"price": null` needs a
   look (see the Troubleshooting table from before; same idea, now
   per-variant instead of per-product).

3. **GitHub Actions** runs automatically twice a day (see the cron in
   `scrape.yml`) and commits updated prices. You can also trigger it
   right from the phone app (see below) or manually from the repo's
   Actions tab.

4. **Set up the Scriptable script**:
   - Open Scriptable, create a new script, paste in
     `scriptable/grocery-app.js`
   - Change `GITHUB_USER` / `GITHUB_REPO` at the top to your own
   - Run it once directly (not as a widget) — this opens the menu
   - Tap **⚙️ GitHub setup** and paste a GitHub personal access token
     (needs `repo` scope, or fine-grained Contents read/write +
     Actions write, on this one repo) — only needed for **adding new
     products** and **triggering a scrape** from your phone; viewing
     prices and building My List don't need it at all
   - Tap **📝 Edit My List** and pick the items you're buying this trip

5. **Add the widget**: long-press your home screen → add widget →
   Scriptable → pick `grocery-app` as its script.
   - By default the widget shows whatever you last set via
     **🔁 Switch widget default** in the app menu
   - You can also override this per-widget without opening the app:
     long-press the widget → Edit Widget → in the **Parameter** field
     type `list` or `all`. Handy if you want one widget always
     showing "My List" and another always showing "All Products."

## Using it day-to-day

- Before a shopping trip: open the app → **Edit My List** → tap the
  items you need → swipe down when done. The widget (or **View
  cheapest — My List**) now shows just those items at their lowest
  current price and which store/brand that is.
- **View cheapest — All Products** shows your whole tracked catalogue,
  regardless of what's on today's list.
- **Check price drops now** compares the latest scrape against the
  previous one for anything marked `track_drop` (your Costco/household
  staples) and fires a local notification for each drop. Since
  Scriptable widgets run with limited background permissions, this is
  most reliable when you either open the app now and then, or set up
  an iOS Shortcuts **Personal Automation** (e.g. "at 9am and 6pm, run
  Scriptable script grocery-app") so it checks and notifies without
  you opening it manually.
- **Add new product** walks you through name → tracking mode → one or
  more store URLs, then commits it straight to `products.json` on
  GitHub (needs the token from step 4). It'll be scraped on the next
  run — or tap **Trigger scrape now** to run it immediately instead of
  waiting for the twice-daily schedule.

## How to tell if the scraper is actually working

Three ways, from quickest to most detailed:

1. **The badge at the top of this README** (once you swap in your own
   username above) turns green after a successful run and red after a
   failed one — GitHub renders it live from the workflow's status.
2. **In the app, tap 📊 Scraper health** — shows when it last ran, the
   overall success rate, a per-store breakdown, and up to 5 example
   failures if something's broken.
3. **The widget itself** shows a small dot next to its title: 🟢
   healthy, 🟠 ran but a lot of variants failed, 🔴 hasn't run in over
   20 hours (the schedule is twice a day, so this means something's
   stuck), ⚪️ no run yet. It also shows "updated Xh ago" underneath.

Under the hood, every run writes `data/status.json` with these numbers,
and if the overall success rate drops below 40%, the GitHub Actions
run is deliberately marked as failed (the data still gets committed —
only the pass/fail flag changes) so the badge turns red and, if you
have GitHub's email notifications on for failed workflows, you'll get
an email too. To turn those on: on the repo page, click **Watch** →
**Custom** → check **Actions**.

## Troubleshooting by store

| Store | Reliability | Notes |
|---|---|---|
| Superstore / No Frills | High | Static page data usually has the price |
| FreshCo | Medium-high | Same approach; a few items may need the Playwright fallback |
| Costco.ca | Medium | Needs the Playwright render step (price loads via JS) |
| Walmart.ca | Low-medium | Active bot protection; expect occasional `blocked_by_bot_protection` |

If a specific variant keeps coming back `null`: open its URL yourself
logged out and confirm the price shows without picking a store/postal
code first — a script has no saved location. Check `data/history.json`
for that variant's `"method"` field to see which extraction strategy
was tried.

## Extending later

- Trend charts: `data/history.json` has a full timestamped log already.
- Location-based pricing: URLs are Calgary-specific; a different
  postal code would need cookie/localStorage setup inside that store's
  scraper before rendering.

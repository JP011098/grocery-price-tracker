// Grocery Price Tracker - unified app + widget script
//
// Run this script directly in Scriptable to get the interactive menu
// (build "My List", view cheapest prices, add products, trigger a
// scrape, etc). Add it as a home-screen widget to see either your
// list or the full catalogue at the lowest current price.
//
// SETUP: set these two to your own GitHub username/repo.
const GITHUB_USER = "JP011098";
const GITHUB_REPO = "grocery-price-tracker";
const BRANCH = "main";

const STORE_LABELS = { superstore: "Superstore", freshco: "FreshCo", costco: "Costco", walmart: "Walmart" };

// ---------- local storage (shared between the widget and the app) ----------

const fm = FileManager.local();
const baseDir = fm.joinPath(fm.documentsDirectory(), "grocery-tracker");
if (!fm.fileExists(baseDir)) fm.createDirectory(baseDir);

function localPath(name) {
  return fm.joinPath(baseDir, name);
}

function readLocal(name, fallback) {
  const p = localPath(name);
  if (!fm.fileExists(p)) return fallback;
  try {
    return JSON.parse(fm.readString(p));
  } catch (e) {
    return fallback;
  }
}

function writeLocal(name, obj) {
  fm.writeString(localPath(name), JSON.stringify(obj));
}

function getShoppingList() {
  return new Set(readLocal("shopping-list.json", []));
}

function getWidgetMode() {
  return readLocal("widget-mode.json", { mode: "list" }).mode;
}

function setWidgetMode(mode) {
  writeLocal("widget-mode.json", { mode });
}

// ---------- GitHub access ----------

function getPAT() {
  return Keychain.contains("gh_pat") ? Keychain.get("gh_pat") : null;
}

function setPAT(token) {
  Keychain.set("gh_pat", token);
}

async function fetchPricesRaw() {
  const url = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${BRANCH}/data/prices.json?t=${Date.now()}`;
  const req = new Request(url);
  req.timeoutInterval = 15;
  return await req.loadJSON();
}

async function fetchStatusRaw() {
  const url = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${BRANCH}/data/status.json?t=${Date.now()}`;
  const req = new Request(url);
  req.timeoutInterval = 15;
  return await req.loadJSON();
}

function hoursSince(isoString) {
  if (!isoString) return null;
  return (Date.now() - new Date(isoString).getTime()) / 36e5;
}

// A run is expected roughly every 12h (twice-daily schedule) - call it
// stale past ~20h so one slow run doesn't cry wolf.
const STALE_HOURS = 20;

function healthDot(status) {
  if (!status || !status.last_run) return "⚪️";
  const hrs = hoursSince(status.last_run);
  if (hrs > STALE_HOURS) return "🔴";
  if (!status.healthy) return "🟠";
  return "🟢";
}

async function ghApiGet(path) {
  const pat = getPAT();
  const req = new Request(`https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}?ref=${BRANCH}`);
  req.headers = { Authorization: `token ${pat}`, Accept: "application/vnd.github+json" };
  return await req.loadJSON();
}

async function ghApiPut(path, contentObj, sha, message) {
  const pat = getPAT();
  const req = new Request(`https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`);
  req.method = "PUT";
  req.headers = { Authorization: `token ${pat}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
  const b64 = Data.fromString(JSON.stringify(contentObj, null, 2)).toBase64String();
  req.body = JSON.stringify({ message, content: b64, sha, branch: BRANCH });
  return await req.loadJSON();
}

async function triggerWorkflow() {
  const pat = getPAT();
  const req = new Request(`https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/actions/workflows/scrape.yml/dispatches`);
  req.method = "POST";
  req.headers = { Authorization: `token ${pat}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
  req.body = JSON.stringify({ ref: BRANCH });
  await req.load();
}

// ---------- helpers ----------

function cheapestLabel(cheapest, unit) {
  if (!cheapest) return "no price yet";
  const brand = cheapest.brand ? `${cheapest.brand} ` : "";
  const stale = cheapest.stale ? " (stale)" : "";
  const manual = cheapest.manual ? " (manual)" : "";
  const suffix = unit === "kg" ? "/kg" : "";
  return `${brand}$${cheapest.price.toFixed(2)}${suffix} @ ${STORE_LABELS[cheapest.store] || cheapest.store}${stale}${manual}`;
}

const CATEGORY_ORDER = ["produce", "dairy", "bakery/frozen", "paper goods", "cleaning", "personal care", "other"];
const CATEGORY_LABELS = {
  "produce": "🥬 Produce",
  "dairy": "🥛 Dairy",
  "bakery/frozen": "🍞 Bakery & Frozen",
  "paper goods": "🧻 Paper Goods",
  "cleaning": "🧼 Cleaning",
  "personal care": "🧴 Personal Care",
  "other": "📦 Other",
};

// Groups [id, item] or {p, item} style pairs by item.category, in CATEGORY_ORDER,
// alphabetical by name within each category. getCategory/getName let this work
// for either shape of input.
function groupByCategory(list, getCategory, getName) {
  const buckets = {};
  for (const entry of list) {
    const cat = getCategory(entry) || "other";
    (buckets[cat] = buckets[cat] || []).push(entry);
  }
  const ordered = [];
  for (const cat of CATEGORY_ORDER) {
    if (!buckets[cat]) continue;
    buckets[cat].sort((a, b) => getName(a).localeCompare(getName(b)));
    ordered.push([cat, buckets[cat]]);
    delete buckets[cat];
  }
  // any leftover/unrecognized categories go last
  for (const [cat, items] of Object.entries(buckets)) {
    items.sort((a, b) => getName(a).localeCompare(getName(b)));
    ordered.push([cat, items]);
  }
  return ordered;
}

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// ---------- widget rendering ----------

async function buildWidget() {
  const widget = new ListWidget();
  widget.backgroundColor = new Color("#111111");
  widget.setPadding(14, 14, 14, 14);

  let data;
  try {
    data = await fetchPricesRaw();
  } catch (e) {
    const err = widget.addText(`Couldn't load prices:\n${e}`);
    err.textColor = Color.red();
    err.font = Font.systemFont(11);
    return widget;
  }

  const modeParam = (args.widgetParameter || "").toLowerCase().trim();
  const mode = modeParam === "list" || modeParam === "all" ? modeParam : getWidgetMode();

  let status = null;
  try {
    status = await fetchStatusRaw();
  } catch (e) {
    // status.json missing/unreachable just means "no health info yet" - not fatal to the widget
  }

  const titleRow = widget.addStack();
  titleRow.layoutHorizontally();
  titleRow.centerAlignContent();
  const title = titleRow.addText(mode === "list" ? "My Grocery List" : "All Products - Cheapest");
  title.font = Font.boldSystemFont(15);
  title.textColor = Color.white();
  titleRow.addSpacer();
  const dot = titleRow.addText(healthDot(status));
  dot.font = Font.systemFont(13);
  widget.addSpacer(2);

  if (status && status.last_run) {
    const hrs = hoursSince(status.last_run);
    const freshness = widget.addText(`updated ${hrs < 1 ? "<1h" : hrs.toFixed(0) + "h"} ago`);
    freshness.font = Font.systemFont(9);
    freshness.textColor = hrs > STALE_HOURS ? Color.red() : Color.gray();
  }
  widget.addSpacer(6);

  let entries;
  if (mode === "list") {
    const list = getShoppingList();
    entries = Object.entries(data).filter(([id]) => list.has(id));
  } else {
    entries = Object.entries(data);
  }

  if (entries.length === 0) {
    const empty = widget.addText(mode === "list" ? "Your list is empty.\nOpen the app to add items." : "No price data yet.");
    empty.font = Font.systemFont(12);
    empty.textColor = Color.gray();
    return widget;
  }

  // Bigger widget families can fit a lot more - iOS decides which family
  // this instance is via config.widgetFamily.
  const ROW_BUDGET = { small: 4, medium: 8, large: 16, extraLarge: 22 }[config.widgetFamily] || 10;

  const grouped = groupByCategory(entries, ([, item]) => item.category, ([, item]) => item.name);
  let rowsLeft = ROW_BUDGET;
  let shown = 0;

  for (const [category, items] of grouped) {
    if (rowsLeft <= 0) break;

    const header = widget.addText(CATEGORY_LABELS[category] || category);
    header.font = Font.boldSystemFont(11);
    header.textColor = Color.lightGray();
    widget.addSpacer(2);

    for (const [id, item] of items) {
      if (rowsLeft <= 0) break;
      const row = widget.addStack();
      row.layoutHorizontally();
      row.centerAlignContent();

      const name = row.addText(item.name);
      name.font = Font.systemFont(12);
      name.textColor = Color.white();
      name.lineLimit = 1;

      row.addSpacer();

      const trendMark = item.trend === "down" ? "↓ " : item.trend === "up" ? "↑ " : "";
      const priceText = row.addText(trendMark + cheapestLabel(item.cheapest, item.unit));
      priceText.font = Font.systemFont(11);
      priceText.textColor = item.trend === "down" ? Color.green() : item.cheapest && item.cheapest.stale ? Color.orange() : Color.white();

      rowsLeft -= 1;
      shown += 1;
    }
    widget.addSpacer(6);
  }

  if (shown < entries.length) {
    const more = widget.addText(`+${entries.length - shown} more - open app`);
    more.font = Font.systemFont(9);
    more.textColor = Color.gray();
  }

  return widget;
}

// ---------- interactive app ----------

async function editMyList(products) {
  const listSet = getShoppingList();
  const table = new UITable();
  table.showSeparators = true;

  function buildRows() {
    table.removeAllRows();
    const instructions = new UITableRow();
    instructions.isHeader = true;
    instructions.addText("Tap to add/remove. Swipe down when done.");
    table.addRow(instructions);

    const grouped = groupByCategory(products, (p) => p.category, (p) => p.name);
    for (const [category, items] of grouped) {
      const header = new UITableRow();
      header.isHeader = true;
      header.addText(CATEGORY_LABELS[category] || category);
      table.addRow(header);

      for (const p of items) {
        const row = new UITableRow();
        const checked = listSet.has(p.id);
        row.addText(`${checked ? "✅" : "⬜"} ${p.name}`);
        row.onSelect = () => {
          if (listSet.has(p.id)) listSet.delete(p.id);
          else listSet.add(p.id);
          buildRows();
          table.reload();
        };
        table.addRow(row);
      }
    }
  }

  buildRows();
  await table.present();
  writeLocal("shopping-list.json", Array.from(listSet));
}

async function viewCheapest(products, filterToList) {
  let data;
  try {
    data = await fetchPricesRaw();
  } catch (e) {
    const a = new Alert();
    a.title = "Couldn't load prices";
    a.message = String(e);
    a.addAction("OK");
    await a.presentAlert();
    return;
  }

  const list = getShoppingList();
  const table = new UITable();
  table.showSeparators = true;

  const filtered = products.filter((p) => !filterToList || list.has(p.id));

  if (filtered.length === 0) {
    const header = new UITableRow();
    header.addText(filterToList ? "Your list is empty." : "No products tracked yet.");
    table.addRow(header);
  } else {
    const grouped = groupByCategory(filtered, (p) => p.category, (p) => p.name);
    for (const [category, items] of grouped) {
      const header = new UITableRow();
      header.isHeader = true;
      header.addText(CATEGORY_LABELS[category] || category);
      table.addRow(header);

      for (const p of items) {
        const item = data[p.id];
        const row = new UITableRow();
        const trendMark = item && item.trend === "down" ? "↓ " : item && item.trend === "up" ? "↑ " : "";
        row.addText(p.name, trendMark + cheapestLabel(item && item.cheapest, p.unit));
        table.addRow(row);
      }
    }
  }

  await table.present();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// A true auto-scrolling ticker only works inside the app - WidgetKit
// (the home-screen widget system) only ever renders a static snapshot,
// it can't run a continuous animation, so this view opens full-screen
// when you tap this menu item rather than living on the home screen.
async function showTicker(products) {
  let data;
  try {
    data = await fetchPricesRaw();
  } catch (e) {
    const a = new Alert();
    a.title = "Couldn't load prices";
    a.message = String(e);
    a.addAction("OK");
    await a.presentAlert();
    return;
  }

  const list = getShoppingList();
  const scope = list.size > 0 ? products.filter((p) => list.has(p.id)) : products;
  const grouped = groupByCategory(scope, (p) => p.category, (p) => p.name);

  let rowsHtml = "";
  let rowCount = 0;
  for (const [category, items] of grouped) {
    rowsHtml += `<div class="cat">${escapeHtml(CATEGORY_LABELS[category] || category)}</div>`;
    rowCount += 1;
    for (const p of items) {
      const item = data[p.id];
      const label = cheapestLabel(item && item.cheapest, p.unit);
      const trend = item && item.trend === "down" ? "↓ " : item && item.trend === "up" ? "↑ " : "";
      rowsHtml += `<div class="row"><span class="name">${escapeHtml(p.name)}</span><span class="price">${trend}${escapeHtml(label)}</span></div>`;
      rowCount += 1;
    }
  }

  const duration = Math.max(rowCount * 1.6, 18);

  const html = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;height:100%;background:#111;overflow:hidden;font-family:-apple-system,sans-serif;}
  .viewport{height:100vh;position:relative;overflow:hidden;}
  .track{position:absolute;width:100%;animation:scrollUp ${duration}s linear infinite;}
  .cat{font-weight:700;color:#999;padding:14px 18px 4px;font-size:13px;letter-spacing:0.5px;}
  .row{display:flex;justify-content:space-between;padding:10px 18px;font-size:17px;color:#fff;border-bottom:1px solid #222;}
  .price{color:#4caf50;font-weight:600;}
  @keyframes scrollUp { from { transform: translateY(0); } to { transform: translateY(-50%); } }
</style></head>
<body>
  <div class="viewport"><div class="track">${rowsHtml}${rowsHtml}</div></div>
</body></html>`;

  const wv = new WebView();
  await wv.loadHTML(html);
  await wv.present(true);
}

async function showScraperHealth() {
  let status;
  try {
    status = await fetchStatusRaw();
  } catch (e) {
    const a = new Alert();
    a.title = "Couldn't load status.json";
    a.message = "Either the scraper hasn't run yet, or: " + String(e);
    a.addAction("OK");
    await a.presentAlert();
    return;
  }

  const hrs = hoursSince(status.last_run);
  const dot = healthDot(status);
  const lastRunLocal = new Date(status.last_run).toLocaleString();

  let lines = [];
  lines.push(`${dot} Last run: ${lastRunLocal}`);
  lines.push(`(${hrs.toFixed(1)}h ago${hrs > STALE_HOURS ? " - overdue, check GitHub Actions" : ""})`);
  lines.push(`Overall: ${status.total_succeeded}/${status.total_attempted} succeeded (${Math.round(status.success_rate * 100)}%)`);
  lines.push("");
  lines.push("By store:");
  for (const [store, s] of Object.entries(status.by_store || {})) {
    lines.push(`  ${STORE_LABELS[store] || store}: ${s.succeeded}/${s.attempted} (${Math.round(s.success_rate * 100)}%)`);
  }
  if (status.failures && status.failures.length) {
    lines.push("");
    lines.push(`${status.failures.length} failure(s) this run, e.g.:`);
    status.failures.slice(0, 5).forEach((f) => {
      lines.push(`  ${f.product} @ ${STORE_LABELS[f.store] || f.store} - ${f.method}`);
    });
  }
  if (status.duplicate_price_warnings && status.duplicate_price_warnings.length) {
    lines.push("");
    lines.push(`⚠️ ${status.duplicate_price_warnings.length} suspicious duplicate-price group(s):`);
    status.duplicate_price_warnings.slice(0, 3).forEach((w) => {
      lines.push(`  ${STORE_LABELS[w.store] || w.store} $${w.price.toFixed(2)} on ${w.product_count} products - likely a scraper bug, not real prices`);
    });
  }

  const a = new Alert();
  a.title = "📊 Scraper Health";
  a.message = lines.join("\n");
  a.addAction("OK");
  await a.presentAlert();
}

async function checkPriceDrops() {
  let data;
  try {
    data = await fetchPricesRaw();
  } catch (e) {
    return;
  }
  const drops = Object.values(data).filter((item) => item.modes && item.modes.includes("track_drop") && item.trend === "down" && item.cheapest);

  if (drops.length === 0) {
    const a = new Alert();
    a.title = "No new price drops";
    a.addAction("OK");
    await a.presentAlert();
    return;
  }

  for (const item of drops) {
    const n = new Notification();
    n.title = "Price drop 🎉";
    n.body = `${item.name}: ${cheapestLabel(item.cheapest, item.unit)}`;
    await n.schedule();
  }

  const a = new Alert();
  a.title = `${drops.length} price drop(s)`;
  a.message = drops.map((d) => `${d.name}: ${cheapestLabel(d.cheapest, d.unit)}`).join("\n");
  a.addAction("OK");
  await a.presentAlert();
}

async function updatePriceManually(products) {
  if (!getPAT()) {
    const a = new Alert();
    a.title = "GitHub setup needed";
    a.message = "Set up your GitHub access token first (see menu option below).";
    a.addAction("OK");
    await a.presentAlert();
    return;
  }

  // Pick a product
  const picker = new Alert();
  picker.title = "Which product?";
  const sorted = [...products].sort((a, b) => a.name.localeCompare(b.name));
  sorted.forEach((p) => picker.addAction(p.name));
  picker.addCancelAction("Cancel");
  const productChoice = await picker.presentSheet();
  if (productChoice === -1) return;
  const product = sorted[productChoice];

  // Pick which store/brand variant on that product (or add a new manual-only one)
  const variantPicker = new Alert();
  variantPicker.title = `Which variant of "${product.name}"?`;
  product.variants.forEach((v) => {
    const label = v.brand ? `${v.brand} @ ${STORE_LABELS[v.store] || v.store}` : STORE_LABELS[v.store] || v.store;
    variantPicker.addAction(label + (v.manual ? " (manual)" : ""));
  });
  variantPicker.addAction("+ Add a new manual-only variant");
  variantPicker.addCancelAction("Cancel");
  const variantChoice = await variantPicker.presentSheet();
  if (variantChoice === -1) return;

  const priceAlert = new Alert();
  priceAlert.title = "Current price";
  priceAlert.addTextField("e.g. 12.99");
  priceAlert.addAction("Save");
  priceAlert.addCancelAction("Cancel");
  if ((await priceAlert.present()) === -1) return;
  const priceValue = parseFloat(priceAlert.textFieldValue(0).trim());
  if (isNaN(priceValue)) {
    const err = new Alert();
    err.title = "Not a valid price";
    err.addAction("OK");
    await err.presentAlert();
    return;
  }

  try {
    const current = await ghApiGet("products.json");
    const decoded = Data.fromBase64String(current.content.replace(/\n/g, ""));
    const config = JSON.parse(decoded.toRawString());
    const targetProduct = config.products.find((p) => p.id === product.id);
    const now = new Date().toISOString();

    if (variantChoice < product.variants.length) {
      const targetVariant = targetProduct.variants[variantChoice];
      targetVariant.manual = true;
      targetVariant.manual_price = priceValue;
      targetVariant.manual_price_updated = now;
    } else {
      const storeAlert = new Alert();
      storeAlert.title = "Which store is this price from?";
      storeAlert.addAction("Costco");
      storeAlert.addAction("Superstore");
      storeAlert.addAction("FreshCo");
      storeAlert.addAction("Walmart");
      storeAlert.addAction("Other");
      const storeChoice = await storeAlert.presentSheet();
      const store = ["costco", "superstore", "freshco", "walmart", "other"][storeChoice] || "other";
      targetProduct.variants.push({
        store,
        brand: "",
        url: "",
        manual: true,
        manual_price: priceValue,
        manual_price_updated: now,
      });
    }

    await ghApiPut("products.json", config, current.sha, `Manual price update: ${product.name}`);

    const a = new Alert();
    a.title = "Saved";
    a.message = "This price will carry forward until you update it again - it won't be scraped. Trigger a scrape now to refresh prices.json right away, or wait for the next scheduled run.";
    a.addAction("OK");
    await a.presentAlert();
  } catch (e) {
    const a = new Alert();
    a.title = "Couldn't save to GitHub";
    a.message = String(e);
    a.addAction("OK");
    await a.presentAlert();
  }
}

// ---------- phone-side refresh (FreshCo + Walmart) ----------
//
// FreshCo and Walmart block the scraper when it runs on GitHub's servers
// (FreshCo: "Access Denied", Walmart: "verify you're human"). This reads
// their pages from THIS phone instead, using Scriptable's built-in web
// view on your own connection, and saves what it finds as manual prices
// (which the GitHub scraper then carries forward instead of trying and
// failing). It only runs while Scriptable is open on screen. If a page
// shows a verification / access-denied page, that item is skipped - this
// does not try to get past those checks.

function sleep(ms) {
  return new Promise((resolve) => Timer.schedule(ms, false, () => resolve()));
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, sleep(ms).then(() => fallback)]);
}

// --- pageExtractor: runs INSIDE the web page (so it can only use page APIs) ---
function pageExtractor(STORE, UNIT, completion) {
  const BLOCK_PHRASES = [
    "verify your identity",
    "press and hold",
    "press & hold",
    "access denied",
    "robot or human",
    "are you a robot",
    "verify you are human",
  ];

  function textOf(el) {
    const t = el.innerText !== undefined ? el.innerText : el.textContent;
    return (t || "").trim();
  }

  function money(text) {
    if (!text) return null;
    let m = text.match(/\$\s?(\d{1,4}(?:\.\d{2})?)/);
    if (m) return parseFloat(m[1]);
    m = text.match(/(\d{1,3}(?:\.\d+)?)\s?¢/);
    if (m) return parseFloat(m[1]) / 100;
    return null;
  }

  function freshco() {
    const regex = /^\$\d+\.\d{2}(?:\/(?:kg|lb|ea))?$/;
    const sale = [];
    const plain = [];
    for (const el of document.querySelectorAll("span, p, div")) {
      const cls = typeof el.className === "string" ? el.className : "";
      if (cls.includes("line-through")) continue;
      const text = textOf(el);
      if (!regex.test(text)) continue;
      if (cls.includes("text-red400")) sale.push(text);
      else plain.push(text);
    }
    const pick = (texts) => {
      if (UNIT === "kg") {
        const kg = texts.filter((t) => t.endsWith("/kg"));
        return kg.length ? kg[0] : null;
      }
      const noSlash = texts.filter((t) => !t.includes("/"));
      if (noSlash.length) return noSlash[0];
      return texts.length ? texts[0] : null;
    };
    const chosen = pick(sale) || pick(plain);
    return chosen ? money(chosen) : null;
  }

  function walmart() {
    if (UNIT === "kg") {
      const u = document.querySelector('[data-seo-id="hero-unit-price"]');
      if (!u) return null;
      const text = textOf(u).toLowerCase();
      const v = money(text);
      if (v === null) return null;
      if (text.includes("100g")) return Math.round(v * 10 * 100) / 100;
      if (text.includes("kg")) return v;
      if (text.includes("lb")) return Math.round((v / 0.453592) * 100) / 100;
      return null;
    }
    const h = document.querySelector('[itemprop="price"]');
    return h ? money(textOf(h)) : null;
  }

  const started = Date.now();
  const timer = setInterval(() => {
    let price = null;
    try {
      price = STORE === "freshco" ? freshco() : walmart();
    } catch (e) {
      price = null;
    }
    if (price !== null && !isNaN(price) && price > 0 && price < 1000) {
      clearInterval(timer);
      completion({ price: price });
      return;
    }
    const pageText = ((document.title || "") + " " + (document.body ? textOf(document.body) : ""))
      .replace(/\s+/g, " ")
      .slice(0, 500)
      .toLowerCase();
    if (BLOCK_PHRASES.some((p) => pageText.includes(p))) {
      clearInterval(timer);
      completion({ price: null, blocked: true, note: pageText.slice(0, 100) });
      return;
    }
    if (Date.now() - started > 15000) {
      clearInterval(timer);
      completion({ price: null, note: pageText.slice(0, 100) });
    }
  }, 600);
}
// --- end pageExtractor ---

async function readPriceInWebView(url, store, unit) {
  const wv = new WebView();
  try {
    const loaded = await withTimeout(wv.loadURL(url).then(() => true), 30000, false);
    if (!loaded) return { price: null, note: "page load timed out" };
  } catch (e) {
    return { price: null, note: "couldn't load: " + String(e) };
  }

  const js = `(${pageExtractor.toString()})(${JSON.stringify(store)}, ${JSON.stringify(unit)}, completion);`;
  try {
    const res = await withTimeout(wv.evaluateJavaScript(js, true), 25000, { price: null, note: "timed out waiting for a price" });
    return res || { price: null, note: "no result" };
  } catch (e) {
    return { price: null, note: String(e) };
  }
}

async function refreshBlockedStoresFromPhone(products) {
  if (!getPAT()) {
    const a = new Alert();
    a.title = "GitHub setup needed";
    a.message = "Prices are saved to your GitHub repo, so set up your access token first (⚙️ GitHub setup).";
    a.addAction("OK");
    await a.presentAlert();
    return;
  }

  const targets = [];
  for (const p of products) {
    for (const v of p.variants || []) {
      if ((v.store === "freshco" || v.store === "walmart") && v.url) {
        targets.push({ productId: p.id, name: p.name, unit: p.unit || "each", store: v.store, brand: v.brand || "", url: v.url });
      }
    }
  }
  if (targets.length === 0) {
    const a = new Alert();
    a.title = "Nothing to refresh";
    a.message = "No FreshCo or Walmart product URLs found.";
    a.addAction("OK");
    await a.presentAlert();
    return;
  }

  const confirm = new Alert();
  confirm.title = "Refresh FreshCo + Walmart from this phone?";
  confirm.message = `This opens ${targets.length} product pages one at a time in a hidden browser and reads each price. It takes several minutes: keep Scriptable open and your screen on. If a store shows a verification or access-denied page, that item is skipped and left as it was.`;
  confirm.addAction("Start");
  confirm.addCancelAction("Cancel");
  if ((await confirm.present()) === -1) return;

  const statuses = targets.map(() => "waiting");
  const table = new UITable();
  table.showSeparators = true;

  function render(headline) {
    table.removeAllRows();
    const header = new UITableRow();
    header.isHeader = true;
    header.addText(headline);
    table.addRow(header);
    targets.forEach((t, i) => {
      const row = new UITableRow();
      row.addText(t.name + (t.brand ? ` (${t.brand})` : ""), `${STORE_LABELS[t.store]} - ${statuses[i]}`);
      table.addRow(row);
    });
    table.reload();
  }

  const found = [];
  let blockedCount = 0;
  let noPriceCount = 0;

  render(`Starting - ${targets.length} pages`);

  const work = (async () => {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      statuses[i] = "loading...";
      render(`Reading page ${i + 1} of ${targets.length}`);

      const res = await readPriceInWebView(t.url, t.store, t.unit);
      if (res.price !== null && res.price !== undefined) {
        statuses[i] = `$${res.price.toFixed(2)}${t.unit === "kg" ? "/kg" : ""}`;
        found.push({ ...t, price: res.price });
      } else if (res.blocked) {
        statuses[i] = "blocked - skipped";
        blockedCount += 1;
      } else {
        statuses[i] = "no price found - skipped";
        noPriceCount += 1;
      }
      render(`Reading page ${i + 1} of ${targets.length}`);
      await sleep(1500);
    }
    render("Done - swipe down to continue");
  })();

  await table.present();
  await work;

  if (found.length === 0) {
    const a = new Alert();
    a.title = "No prices could be read";
    a.message = `${blockedCount} page(s) showed a verification/access-denied page, ${noPriceCount} had no readable price. Nothing was changed.`;
    a.addAction("OK");
    await a.presentAlert();
    return;
  }

  try {
    const current = await ghApiGet("products.json");
    const decoded = Data.fromBase64String(current.content.replace(/\n/g, ""));
    const config = JSON.parse(decoded.toRawString());
    const now = new Date().toISOString();
    let saved = 0;
    for (const f of found) {
      const prod = config.products.find((p) => p.id === f.productId);
      if (!prod) continue;
      const variant = prod.variants.find((v) => v.store === f.store && v.url === f.url);
      if (!variant) continue;
      variant.manual = true;
      variant.manual_price = f.price;
      variant.manual_price_updated = now;
      variant.manual_source = "phone";
      saved += 1;
    }
    await ghApiPut("products.json", config, current.sha, `Phone refresh: ${saved} FreshCo/Walmart prices`);

    let triggered = true;
    try {
      await triggerWorkflow();
    } catch (e) {
      triggered = false;
    }

    const a = new Alert();
    a.title = "Prices saved";
    a.message =
      `Read ${saved} of ${targets.length} prices.` +
      (blockedCount + noPriceCount > 0 ? ` Skipped ${blockedCount + noPriceCount} (${blockedCount} blocked, ${noPriceCount} with no readable price).` : "") +
      (triggered ? " A scrape was started - the widget updates in about 7 minutes." : " Trigger a scrape from the menu to refresh the widget.") +
      " These prices stay as saved until you refresh again.";
    a.addAction("OK");
    await a.presentAlert();
  } catch (e) {
    const a = new Alert();
    a.title = "Read the prices but couldn't save them";
    a.message = String(e);
    a.addAction("OK");
    await a.presentAlert();
  }
}

async function addNewProduct() {
  if (!getPAT()) {
    const a = new Alert();
    a.title = "GitHub setup needed";
    a.message = "Set up your GitHub access token first (see menu option below).";
    a.addAction("OK");
    await a.presentAlert();
    return;
  }

  const nameAlert = new Alert();
  nameAlert.title = "New product name";
  nameAlert.addTextField("e.g. Basmati Rice 10kg");
  nameAlert.addAction("Next");
  nameAlert.addCancelAction("Cancel");
  if ((await nameAlert.present()) === -1) return;
  const name = nameAlert.textFieldValue(0).trim();
  if (!name) return;

  const modeAlert = new Alert();
  modeAlert.title = "Track how?";
  modeAlert.addAction("Compare cheapest");
  modeAlert.addAction("Track price drops");
  modeAlert.addAction("Both");
  const modeChoice = await modeAlert.presentSheet();
  const modes = modeChoice === 0 ? ["compare_cheapest"] : modeChoice === 1 ? ["track_drop"] : ["compare_cheapest", "track_drop"];

  const variants = [];
  let addingMore = true;
  while (addingMore) {
    const storeAlert = new Alert();
    storeAlert.title = `Add a store for "${name}"`;
    storeAlert.addAction("Superstore");
    storeAlert.addAction("FreshCo");
    storeAlert.addAction("Costco");
    storeAlert.addAction("Walmart");
    storeAlert.addCancelAction("Done adding stores");
    const storeChoice = await storeAlert.presentSheet();
    if (storeChoice === -1) break;
    const store = ["superstore", "freshco", "costco", "walmart"][storeChoice];

    const urlAlert = new Alert();
    urlAlert.title = `${STORE_LABELS[store]} product URL`;
    urlAlert.addTextField("https://...");
    urlAlert.addTextField("Brand (optional)");
    urlAlert.addAction("Add");
    urlAlert.addCancelAction("Skip");
    if ((await urlAlert.present()) !== -1) {
      const url = urlAlert.textFieldValue(0).trim();
      const brand = urlAlert.textFieldValue(1).trim();
      if (url) variants.push({ store, brand, url });
    }

    const moreAlert = new Alert();
    moreAlert.title = "Add another store for this product?";
    moreAlert.addAction("Yes");
    moreAlert.addCancelAction("No, I'm done");
    addingMore = (await moreAlert.presentSheet()) === 0;
  }

  if (variants.length === 0) {
    const a = new Alert();
    a.title = "No stores added";
    a.message = "Nothing was saved.";
    a.addAction("OK");
    await a.presentAlert();
    return;
  }

  const newProduct = { id: slugify(name), name, modes, variants };

  try {
    const current = await ghApiGet("products.json");
    const decoded = Data.fromBase64String(current.content.replace(/\n/g, ""));
    const config = JSON.parse(decoded.toRawString());
    config.products.push(newProduct);
    await ghApiPut("products.json", config, current.sha, `Add product: ${name}`);

    const a = new Alert();
    a.title = "Added!";
    a.message = `${name} will be scraped on the next run. You can trigger one now from the menu.`;
    a.addAction("OK");
    await a.presentAlert();
  } catch (e) {
    const a = new Alert();
    a.title = "Couldn't save to GitHub";
    a.message = String(e);
    a.addAction("OK");
    await a.presentAlert();
  }
}

async function githubSetup() {
  const a = new Alert();
  a.title = "GitHub personal access token";
  a.message = "Needs 'repo' scope (or fine-grained: Contents read/write + Actions write) on your grocery-price-tracker repo. Create one at github.com/settings/tokens.";
  a.addTextField(getPAT() ? "•••• already set - paste to replace ••••" : "ghp_...");
  a.addAction("Save");
  a.addCancelAction("Cancel");
  if ((await a.present()) === -1) return;
  const token = a.textFieldValue(0).trim();
  if (token && !token.startsWith("••••")) {
    setPAT(token);
    const done = new Alert();
    done.title = "Saved";
    done.addAction("OK");
    await done.presentAlert();
  }
}

async function fetchProductsList() {
  // products.json is public repo data - no auth needed to read it
  const url = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${BRANCH}/products.json?t=${Date.now()}`;
  const req = new Request(url);
  const config = await req.loadJSON();
  return config.products;
}

async function mainMenu() {
  let products;
  try {
    products = await fetchProductsList();
  } catch (e) {
    const a = new Alert();
    a.title = "Couldn't load products.json";
    a.message = String(e);
    a.addAction("OK");
    await a.presentAlert();
    return;
  }

  let running = true;
  while (running) {
    const list = getShoppingList();
    const mode = getWidgetMode();

    const a = new Alert();
    a.title = "🛒 Grocery Price Tracker";
    a.message = `My List: ${list.size} item(s)\nWidget shows: ${mode === "list" ? "My List" : "All Products"}`;
    a.addAction("📝 Edit My List");
    a.addAction("💰 View cheapest - My List");
    a.addAction("🛍️ View cheapest - All Products");
    a.addAction("🎬 View as scrolling ticker");
    a.addAction(`🔁 Switch widget default (currently: ${mode})`);
    a.addAction("📊 Scraper health");
    a.addAction("🔔 Check price drops now");
    a.addAction("➕ Add new product");
    a.addAction("✏️ Update a price manually");
    a.addAction("⚙️ GitHub setup");
    a.addAction("🔄 Trigger scrape now");
    a.addAction("📲 Refresh FreshCo + Walmart (phone)");
    a.addCancelAction("Close");

    const choice = await a.presentSheet();
    switch (choice) {
      case 0:
        await editMyList(products);
        break;
      case 1:
        await viewCheapest(products, true);
        break;
      case 2:
        await viewCheapest(products, false);
        break;
      case 3:
        await showTicker(products);
        break;
      case 4:
        setWidgetMode(mode === "list" ? "all" : "list");
        break;
      case 5:
        await showScraperHealth();
        break;
      case 6:
        await checkPriceDrops();
        break;
      case 7:
        await addNewProduct();
        break;
      case 8:
        await updatePriceManually(products);
        break;
      case 9:
        await githubSetup();
        break;
      case 10:
        if (!getPAT()) {
          const err = new Alert();
          err.title = "GitHub setup needed";
          err.addAction("OK");
          await err.presentAlert();
        } else {
          await triggerWorkflow();
          const ok = new Alert();
          ok.title = "Scrape triggered";
          ok.message = "Check the Actions tab on GitHub in a minute or two.";
          ok.addAction("OK");
          await ok.presentAlert();
        }
        break;
      case 11:
        await refreshBlockedStoresFromPhone(products);
        break;
      default:
        running = false;
    }
  }
}

// ---------- entry point ----------

if (config.runsInWidget) {
  const widget = await buildWidget();
  Script.setWidget(widget);
} else {
  await mainMenu();
}
Script.complete();

// Grocery Price Tracker - unified app + widget script
//
// Run this script directly in Scriptable to get the interactive menu
// (build "My List", view cheapest prices, add products, trigger a
// scrape, etc). Add it as a home-screen widget to see either your
// list or the full catalogue at the lowest current price.
//
// SETUP: set these two to your own GitHub username/repo.
const GITHUB_USER = "YOUR_GITHUB_USERNAME";
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

function cheapestLabel(cheapest) {
  if (!cheapest) return "no price yet";
  const brand = cheapest.brand ? `${cheapest.brand} ` : "";
  const stale = cheapest.stale ? " (stale)" : "";
  return `${brand}$${cheapest.price.toFixed(2)} @ ${STORE_LABELS[cheapest.store] || cheapest.store}${stale}`;
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

  const maxRows = 8;
  entries.slice(0, maxRows).forEach(([id, item]) => {
    const row = widget.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();

    const name = row.addText(item.name);
    name.font = Font.systemFont(12);
    name.textColor = Color.white();
    name.lineLimit = 1;

    row.addSpacer();

    const trendMark = item.trend === "down" ? "↓ " : item.trend === "up" ? "↑ " : "";
    const priceText = row.addText(trendMark + cheapestLabel(item.cheapest));
    priceText.font = Font.systemFont(11);
    priceText.textColor = item.trend === "down" ? Color.green() : item.cheapest && item.cheapest.stale ? Color.orange() : Color.white();
    widget.addSpacer(4);
  });

  if (entries.length > maxRows) {
    const more = widget.addText(`+${entries.length - maxRows} more - open app`);
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
    const header = new UITableRow();
    header.isHeader = true;
    header.addText("Tap to add/remove. Swipe down when done.");
    table.addRow(header);

    for (const p of products) {
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

  const rows = products
    .filter((p) => !filterToList || list.has(p.id))
    .map((p) => ({ p, item: data[p.id] }))
    .sort((a, b) => a.p.name.localeCompare(b.p.name));

  if (rows.length === 0) {
    const header = new UITableRow();
    header.addText(filterToList ? "Your list is empty." : "No products tracked yet.");
    table.addRow(header);
  }

  for (const { p, item } of rows) {
    const row = new UITableRow();
    const trendMark = item && item.trend === "down" ? "↓ " : item && item.trend === "up" ? "↑ " : "";
    row.addText(p.name, trendMark + cheapestLabel(item && item.cheapest));
    table.addRow(row);
  }

  await table.present();
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
    n.body = `${item.name}: ${cheapestLabel(item.cheapest)}`;
    await n.schedule();
  }

  const a = new Alert();
  a.title = `${drops.length} price drop(s)`;
  a.message = drops.map((d) => `${d.name}: ${cheapestLabel(d.cheapest)}`).join("\n");
  a.addAction("OK");
  await a.presentAlert();
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
    a.addAction(`🔁 Switch widget default (currently: ${mode})`);
    a.addAction("📊 Scraper health");
    a.addAction("🔔 Check price drops now");
    a.addAction("➕ Add new product");
    a.addAction("⚙️ GitHub setup");
    a.addAction("🔄 Trigger scrape now");
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
        setWidgetMode(mode === "list" ? "all" : "list");
        break;
      case 4:
        await showScraperHealth();
        break;
      case 5:
        await checkPriceDrops();
        break;
      case 6:
        await addNewProduct();
        break;
      case 7:
        await githubSetup();
        break;
      case 8:
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

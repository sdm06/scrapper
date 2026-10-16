'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TARGET_URL =
  'https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI';

const OUTPUT_PATH = path.join(__dirname, '..', 'output', 'product.json');

// No GTIN/UPC/EAN/JAN is exposed on the product page.
const GTIN = null;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// The site is protected by Akamai, which flags the bundled chrome-headless-shell
// but accepts the full Chromium build in its "new" headless mode. `channel:
// 'chromium'` selects that full build, so no virtual display is required.
// Escape hatches:
//   HEADFUL=1 npm run scrape              -> run a visible browser
//   BROWSER_CHANNEL=chrome npm run scrape -> use a locally installed Chrome
const HEADLESS = process.env.HEADFUL !== '1';
const CHANNEL = process.env.BROWSER_CHANNEL || 'chromium';

// ---------------------------------------------------------------------------
// Generic helpers (pure, easy to unit test)
// ---------------------------------------------------------------------------

function cleanText(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length ? text : null;
}

// The product page has no brand/manufacturer field, so infer the brand from the
// site logo text (e.g. "MSI-US Official Store" -> "MSI"), falling back to the
// registrable domain label (us-store.msi.com -> "MSI").
function deriveBrand(rawBrand, url) {
  const source = cleanText(rawBrand);
  if (source) {
    const token = source.split(/[\s-]+/)[0];
    if (token) return token;
  }
  try {
    const labels = new URL(url).hostname.replace(/^www\./, '').split('.');
    return labels.length >= 2 ? labels[labels.length - 2].toUpperCase() : null;
  } catch {
    return null;
  }
}

function parsePrice(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const num = Number.parseFloat(match[0]);
  return Number.isFinite(num) ? num : null;
}

function parseRating(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const rating = /(\d+(?:\.\d+)?)/.exec(text);
  const count = /\((\d+)\)/.exec(text);
  return {
    star_rating: rating ? Number.parseFloat(rating[1]) : null,
    review_count: count ? Number.parseInt(count[1], 10) : null,
  };
}

function normalizeAvailability(rawText) {
  const text = (rawText || '').toLowerCase();
  if (!text) return null;
  if (/(pre[- ]?order)/.test(text)) return 'pre_order';
  if (/(out of stock|out-of-stock|sold out|unavailable)/.test(text)) return 'out_of_stock';
  if (/(in stock|instock|available)/.test(text)) return 'in_stock';
  return null;
}

function dedupe(list) {
  return Array.from(new Set(list));
}

// Images are named ".../<MODEL>-<n>-<WxH>.png"; use <n> for deterministic order.
function imageIndex(url) {
  const match = /-(\d+)-\d+x\d+\.[a-z]+$/i.exec(url) || /-(\d+)\./.exec(url);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function resolveAvailability(raw) {
  const byText = normalizeAvailability(raw.stockText);
  if (byText) return byText;
  if (raw.hasNotifyButton) return 'out_of_stock';
  if (raw.hasCartButton) return 'in_stock';
  return null;
}

// ---------------------------------------------------------------------------
// Raw extraction (runs in the browser; all selectors live here)
// ---------------------------------------------------------------------------

async function extractRaw(page) {
  return page.evaluate(() => {
    const textOf = (el) => (el ? el.textContent : null);
    const attrOf = (el, name) => (el ? el.getAttribute(name) : null);

    const titleEl = document.querySelector('h2.crop-text-2.title');
    const itemIdEl = document.querySelector('input[name="product_id"]');

    const crumbs = Array.from(
      document.querySelectorAll('ol.breadcrumb li.breadcrumb-item')
    ).map((li) => {
      const link = li.querySelector('a');
      return {
        name: (li.textContent || '').trim(),
        url: link ? link.href : null,
        active: li.classList.contains('active'),
      };
    });

    // Price + stock are scoped to the buybox only: .price-new (no "s") belongs
    // to the "Recommended for you" grid and would otherwise pollute the result.
    const buybox = document.querySelector('#prices-wrapper');
    const currentPriceEl = document.querySelector('#prices-new');
    const oldPriceEl = buybox ? buybox.querySelector('.price-old') : null;

    const qtyBox = document.querySelector('#product_qty');
    const cartButton = qtyBox ? qtyBox.querySelector('button[onclick*="cart.add"]') : null;
    const notifyButton = qtyBox ? qtyBox.querySelector('button[onclick*="notify.showNotify"]') : null;

    // The short product summary sits directly after the title heading.
    const descriptionEl = titleEl ? titleEl.nextElementSibling : null;

    const mainImageEl = document.querySelector('#imagePopup');
    const gallery = Array.from(
      document.querySelectorAll('#carouselImages img[popup_img]')
    ).map((img) => img.getAttribute('popup_img'));

    const specs = Array.from(
      document.querySelectorAll('table.table-borderless tr')
    ).map((tr) => {
      const nameEl = tr.querySelector('th');
      const valueEl = tr.querySelector('td');
      return {
        name: nameEl ? nameEl.textContent : '',
        value: valueEl ? valueEl.textContent : null,
      };
    });

    // No brand field exists; the site logo text is the only brand signal.
    const logoEl = document.querySelector('.logo img[alt], img[alt*="MSI"]');

    const ratingEl = document.querySelector('#average-rating-info');

    return {
      title: textOf(titleEl),
      brandSource: logoEl ? logoEl.getAttribute('alt') || logoEl.getAttribute('title') : null,
      itemId: attrOf(itemIdEl, 'value'),
      crumbs,
      priceCurrent: textOf(currentPriceEl),
      priceOld: textOf(oldPriceEl),
      stockText: textOf(buybox),
      description: textOf(descriptionEl),
      mainImage: attrOf(mainImageEl, 'src'),
      gallery,
      specs,
      ratingText: textOf(ratingEl),
      hasCartButton: Boolean(cartButton),
      hasNotifyButton: Boolean(notifyButton),
    };
  });
}

// ---------------------------------------------------------------------------
// Normalization (pure, runs in Node)
// ---------------------------------------------------------------------------

function normalize(raw, url) {
  // Breadcrumb: drop "Home" and the trailing (active) product crumb.
  const categoryTree = raw.crumbs
    .filter((crumb) => !crumb.active)
    .filter((crumb) => !/^home$/i.test(crumb.name))
    .map((crumb) => ({ name: crumb.name, url: crumb.url }));

  const productCategory = categoryTree.length
    ? categoryTree.map((crumb) => crumb.name).join(' > ')
    : null;

  // price = regular/list price, sale_price = discounted price (if any).
  const current = parsePrice(raw.priceCurrent);
  const original = parsePrice(raw.priceOld);
  let price = current;
  let salePrice = null;
  if (original !== null && current !== null && original > current) {
    price = original;
    salePrice = current;
  }

  const gallery = dedupe(raw.gallery)
    .filter(Boolean)
    .sort((a, b) => imageIndex(a) - imageIndex(b));

  const imageUrl = cleanText(raw.mainImage) || (gallery.length ? gallery[0] : null);
  const additionalImageUrls = gallery.filter((img) => img !== imageUrl);

  const specs = raw.specs
    .map((spec) => ({ name: cleanText(spec.name), value: cleanText(spec.value) }))
    .filter((spec) => spec.name);

  const manufacturerRow = specs.find((spec) => /^manufacturer number$/i.test(spec.name));
  const rating = parseRating(raw.ratingText);

  return {
    url,
    item_id: cleanText(raw.itemId),
    title: cleanText(raw.title),
    brand: deriveBrand(raw.brandSource, url),
    product_category: productCategory,
    category_tree: categoryTree,
    description: cleanText(raw.description),
    price,
    sale_price: salePrice,
    availability: resolveAvailability(raw),
    image_url: imageUrl,
    additional_image_urls: additionalImageUrls,
    specs,
    star_rating: rating.star_rating,
    review_count: rating.review_count,
    gtin: GTIN,
    mpn: manufacturerRow ? manufacturerRow.value : null,
    scraped_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Browser / navigation
// ---------------------------------------------------------------------------

async function launchBrowser() {
  return chromium.launch({
    headless: HEADLESS,
    channel: CHANNEL,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
    ],
  });
}

async function newContext(browser) {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  // The store sits behind Akamai, which inspects the automation flag.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  return context;
}

async function fetchRawData(page) {
  const response = await page.goto(TARGET_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  const pageTitle = await page.title();
  if (/access denied/i.test(pageTitle) || (response && response.status() === 403)) {
    throw new Error('Blocked by bot protection (Access Denied).');
  }

  // Dismiss the cookie banner if it rendered (cosmetic, not required to extract).
  const acceptButton = page.locator('#ccc-notify-accept');
  if (await acceptButton.count()) {
    await acceptButton.click({ timeout: 3000 }).catch(() => {});
  }

  // The buybox (title, price, stock, images, specs) is server-rendered.
  await page.waitForSelector('#prices-wrapper', { timeout: 30000 });

  // Ratings/reviews are injected via AJAX (route=product/product/review), so
  // give them a bounded chance to render. Products without reviews never show
  // the element, which is fine -- we simply don't fail on the timeout.
  await page
    .waitForSelector('#average-rating-info', { timeout: 10000 })
    .catch(() => {});

  return extractRaw(page);
}

async function withRetry(fn, attempts) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(`Attempt ${attempt} failed (${error.message}); retrying...`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function saveProduct(product) {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(product, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const browser = await launchBrowser();
  try {
    const context = await newContext(browser);
    const page = await context.newPage();

    const raw = await withRetry(() => fetchRawData(page), 2);
    const product = normalize(raw, TARGET_URL);

    saveProduct(product);
    console.log(`Saved ${OUTPUT_PATH}`);
    console.log(JSON.stringify(product, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`Scrape failed: ${error.message}`);
  process.exit(1);
});

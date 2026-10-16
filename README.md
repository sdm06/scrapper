# MSI Product Page Scraper

A small, production-style [Playwright](https://playwright.dev/) scraper (plain
JavaScript) that extracts a single product from the MSI US store and writes a
normalized JSON document to `output/product.json`.

Target page:

```
https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI
```

## Requirements

- Node.js 18 or newer
- npm

## Install

```bash
npm install
npx playwright install chromium
```

## Run

```bash
npm run scrape
```

The script opens the product page in a real headless browser, extracts the data,
and creates/overwrites `output/product.json`.

## Output

```json
{
  "url": "string",
  "item_id": "string | null",
  "title": "string | null",
  "brand": "string | null",
  "product_category": "string | null",
  "category_tree": [{ "name": "string", "url": "string | null" }],
  "description": "string | null",
  "price": "number | null",
  "sale_price": "number | null",
  "availability": "in_stock | out_of_stock | pre_order | null",
  "image_url": "string | null",
  "additional_image_urls": ["string"],
  "specs": [{ "name": "string", "value": "string | null" }],
  "star_rating": "number | null",
  "review_count": "number | null",
  "gtin": "string | null",
  "mpn": "string | null",
  "scraped_at": "ISO 8601 datetime string"
}
```

## Notes on the implementation

- **The store is protected by Akamai.** The default Playwright
  `chromium.launch({ headless: true })` build (the lightweight
  `chrome-headless-shell`) receives a `403 Access Denied`. This project launches
  the **full Chromium build in new headless mode** via
  `chromium.launch({ headless: true, channel: 'chromium' })`, which loads the page
  successfully with no display required.
- **All selectors are scoped.** Prices/stock are read from the buy-box
  (`#prices-wrapper`) only, because the same `.price-new` classes are reused by
  the "Recommended for you" grid and would otherwise corrupt the result.
- **Data sources.** The page uses OpenCart with a custom theme and contains no
  JSON-LD or `window` product state, so values are read from stable DOM hooks:
  the product title (`h2.crop-text-2.title`), the breadcrumb (`ol.breadcrumb`),
  the main image (`#imagePopup`), the gallery (`#carouselImages img[popup_img]`),
  and the specification tables (`table.table-borderless`).
- **Ratings/reviews load via AJAX**, so the scraper waits (with a bounded,
  non-fatal timeout) for `#average-rating-info` to appear.
- **Normalization.** Prices become numbers, missing values become `null`, list
  fields default to `[]`, and `scraped_at` is a UTC ISO-8601 timestamp.
- `brand` is inferred from the site logo (`"MSI-US Official Store"` -> `"MSI"`)
  because the page exposes no brand field.
- `mpn` is taken from the spec row `Manufacturer Number`; `gtin` is `null`
  because the page exposes no GTIN/UPC/EAN.

## Project structure

```
msi-product-scraper/
├── package.json
├── src/
│   └── scrape.js
└── output/
    └── product.json   # generated sample output
```

## Escape hatches

If the site ever changes its bot protection, the browser can be launched
differently:

```bash
HEADFUL=1 npm run scrape                  # run a visible browser
BROWSER_CHANNEL=chrome npm run scrape     # use locally installed Google Chrome
```

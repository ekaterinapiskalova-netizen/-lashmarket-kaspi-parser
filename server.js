import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const CITY_ID = "391010000";

function cleanProductCode(value) {
  return String(value || "").replace(/\D/g, "");
}

function buildKaspiUrl(productCode) {
  if (productCode === "108538543") {
    return `https://kaspi.kz/shop/p/le-mat-edinichnye-c-0-07-mm-chernyi-mix-7-13-mm-108538543/?c=${CITY_ID}`;
  }
  return `https://kaspi.kz/shop/p/-${productCode}/?c=${CITY_ID}`;
}

function normalizePrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const n = Number(value.replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function collectOfferLikeObjects(value, out = [], depth = 0) {
  if (depth > 8 || value == null) return out;

  if (Array.isArray(value)) {
    for (const item of value) collectOfferLikeObjects(item, out, depth + 1);
    return out;
  }

  if (typeof value !== "object") return out;

  const seller =
    value.merchantName ??
    value.sellerName ??
    value.shopName ??
    value.merchant?.name ??
    value.seller?.name ??
    value.merchant ??
    value.seller ??
    null;

  const rawPrice =
    value.price ??
    value.salePrice ??
    value.currentPrice ??
    value.amount ??
    value.offerPrice ??
    null;

  const price = normalizePrice(rawPrice);

  if ((typeof seller === "string" && seller.trim()) && price !== null) {
    out.push({
      seller: seller.trim(),
      price,
      raw: {
        id: value.id ?? value.offerId ?? null,
        merchantId: value.merchantId ?? value.sellerId ?? null
      }
    });
  }

  for (const child of Object.values(value)) {
    collectOfferLikeObjects(child, out, depth + 1);
  }

  return out;
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "lashmarket-kaspi-parser",
    version: 3,
    mode: "direct-product-url"
  });
});

app.get("/offers/:productCode", async (req, res) => {
  const productCode = cleanProductCode(req.params.productCode);

  if (!productCode) {
    return res.status(400).json({ ok: false, error: "BAD_PRODUCT_CODE" });
  }

  const productUrl = buildKaspiUrl(productCode);
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled"
      ]
    });

    const context = await browser.newContext({
      locale: "ru-RU",
      timezoneId: "Asia/Almaty",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) " +
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 " +
        "Mobile/15E148 Safari/604.1",
      extraHTTPHeaders: {
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8"
      }
    });

    const page = await context.newPage();
    const networkCandidates = [];

    page.on("response", async (response) => {
      try {
        const url = response.url();
        const contentType = response.headers()["content-type"] || "";

        if (
          contentType.includes("application/json") ||
          /offer|merchant|seller|product/i.test(url)
        ) {
          let sample = "";
          try {
            sample = (await response.text()).slice(0, 5000);
          } catch {}

          networkCandidates.push({
            status: response.status(),
            url,
            contentType,
            bodySample: sample
          });

          if (networkCandidates.length > 40) networkCandidates.shift();
        }
      } catch {}
    });

    const nav = await page.goto(productUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    await page.waitForTimeout(5000);

    const title = await page.title().catch(() => "");
    const finalUrl = page.url();
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");

    const offers = [];

    for (const candidate of networkCandidates) {
      if (!candidate.bodySample) continue;
      try {
        const parsed = JSON.parse(candidate.bodySample);
        collectOfferLikeObjects(parsed, offers);
      } catch {}
    }

    const unique = [];
    const seen = new Set();

    for (const offer of offers) {
      const key = `${offer.seller}|${offer.price}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(offer);
    }

    return res.json({
      ok: unique.length > 0,
      version: 3,
      mode: "direct-product-url",
      productCode,
      cityId: CITY_ID,
      productUrl,
      navigationStatus: nav?.status?.() ?? null,
      finalUrl,
      pageTitle: title,
      offers: unique.slice(0, 100),
      networkCandidates: networkCandidates.slice(-20),
      bodySample: bodyText.slice(0, 1500)
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      version: 3,
      mode: "direct-product-url",
      productCode,
      cityId: CITY_ID,
      productUrl,
      error: String(error?.message || error)
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Kaspi parser listening on port ${PORT}`);
});

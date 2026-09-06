import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const CITY_ID = "391010000";

const PROXY_HOST = process.env.DECODO_HOST;
const PROXY_PORT = process.env.DECODO_PORT;
const PROXY_USERNAME = process.env.DECODO_USERNAME;
const PROXY_PASSWORD = process.env.DECODO_PASSWORD;

function proxyConfigured() {
  return Boolean(
    PROXY_HOST &&
    PROXY_PORT &&
    PROXY_USERNAME &&
    PROXY_PASSWORD
  );
}

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
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") return null;

  const n = Number(
    value
      .replace(/\s/g, "")
      .replace(/[^\d.,]/g, "")
      .replace(",", ".")
  );

  return Number.isFinite(n) ? n : null;
}

function collectOffers(value, out = [], depth = 0) {
  if (depth > 10 || value == null) return out;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectOffers(item, out, depth + 1);
    }
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
    value.currentPrice ??
    value.offerPrice ??
    value.finalPrice ??
    value.unitPrice ??
    null;

  const price = normalizePrice(rawPrice);

  if (
    typeof seller === "string" &&
    seller.trim() &&
    price !== null
  ) {
    out.push({
      seller: seller.trim(),
      price
    });
  }

  for (const child of Object.values(value)) {
    collectOffers(child, out, depth + 1);
  }

  return out;
}

function uniqueOffers(offers) {
  const seen = new Set();

  return offers.filter((offer) => {
    const key = `${offer.seller}|${offer.price}`;

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function launchBrowser() {
  if (!proxyConfigured()) {
    throw new Error("DECODO_PROXY_NOT_CONFIGURED");
  }

  return chromium.launch({
    headless: true,
    proxy: {
      server: `http://${PROXY_HOST}:${PROXY_PORT}`,
      username: PROXY_USERNAME,
      password: PROXY_PASSWORD
    }
  });
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    version: 4,
    mode: "decodo-kz-proxy",
    proxyConfigured: proxyConfigured(),
    proxyHost: PROXY_HOST || null,
    proxyPort: PROXY_PORT || null
  });
});

app.get("/proxy-test", async (req, res) => {
  let browser;

  try {
    browser = await launchBrowser();

    const context = await browser.newContext({
      locale: "ru-RU"
    });

    const page = await context.newPage();

    const response = await page.goto(
      "https://api.ipify.org?format=json",
      {
        waitUntil: "domcontentloaded",
        timeout: 60000
      }
    );

    const body = await page.textContent("body");

    let data = null;

    try {
      data = JSON.parse(body || "");
    } catch {
      data = { raw: body };
    }

    res.json({
      ok: true,
      version: 4,
      proxy: "decodo-kz",
      status: response?.status() ?? null,
      result: data
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: 4,
      error: String(error?.message || error)
    });
  } finally {
    if (browser) await browser.close();
  }
});

app.get("/offers/:productCode", async (req, res) => {
  const productCode = cleanProductCode(req.params.productCode);

  if (!productCode) {
    return res.status(400).json({
      ok: false,
      error: "BAD_PRODUCT_CODE"
    });
  }

  const productUrl =
    typeof req.query.url === "string" && req.query.url.startsWith("https://kaspi.kz/")
      ? req.query.url
      : buildKaspiUrl(productCode);

  let browser;

  try {
    browser = await launchBrowser();

    const context = await browser.newContext({
      locale: "ru-RU",
      timezoneId: "Asia/Almaty",
      viewport: {
        width: 1440,
        height: 1000
      },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/128.0.0.0 Safari/537.36"
    });

    const page = await context.newPage();

    await page.setExtraHTTPHeaders({
      "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8"
    });

    const networkCandidates = [];
    const parsedOffers = [];

    page.on("response", async (response) => {
      const url = response.url();

      if (
        url.includes("offer-view") ||
        url.includes("/offers") ||
        url.includes("merchant")
      ) {
        const candidate = {
          url,
          status: response.status(),
          contentType: response.headers()["content-type"] || ""
        };

        try {
          if (candidate.contentType.includes("json")) {
            const json = await response.json();
            candidate.json = json;

            const found = collectOffers(json);
            parsedOffers.push(...found);
          }
        } catch {
          // диагностический режим
        }

        networkCandidates.push(candidate);
      }
    });

    const navigation = await page.goto(productUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90000
    });

    await page.waitForTimeout(8000);

    const pageTitle = await page.title().catch(() => "");
    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "");

    const offers = uniqueOffers(parsedOffers)
      .sort((a, b) => a.price - b.price);

    res.json({
      ok: navigation?.status() >= 200 && navigation?.status() < 400,
      version: 4,
      mode: "playwright-decodo-kz",
      proxyConfigured: proxyConfigured(),
      productCode,
      cityId: CITY_ID,
      productUrl,
      navigationStatus: navigation?.status() ?? null,
      finalUrl: page.url(),
      pageTitle,
      offers,
      offerCount: offers.length,
      networkCandidates: networkCandidates.slice(0, 20),
      bodySample: bodyText.slice(0, 1500)
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: 4,
      mode: "playwright-decodo-kz",
      productCode,
      productUrl,
      error: String(error?.message || error)
    });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Kaspi parser v4 listening on port ${PORT}`);
});

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
    return Math.round(value);
  }

  if (typeof value !== "string") return null;

  const n = Number(
    value
      .replace(/\s/g, "")
      .replace(/[^\d.,]/g, "")
      .replace(",", ".")
  );

  return Number.isFinite(n) ? Math.round(n) : null;
}

function collectOffers(value, out = [], depth = 0) {
  if (depth > 12 || value == null) return out;

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
    price !== null &&
    price > 0
  ) {
    out.push({
      seller: seller.trim(),
      price,
      merchantId: String(
        value.merchantId ??
        value.merchantUID ??
        value.merchant?.id ??
        ""
      )
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
    const key =
      `${String(offer.seller).toLowerCase()}|${offer.price}`;

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

async function enableTrafficSaving(page) {
  const blockedResourceTypes = new Set([
    "image",
    "media",
    "font"
  ]);

  await page.route("**/*", async (route) => {
    const request = route.request();
    const resourceType = request.resourceType();

    if (blockedResourceTypes.has(resourceType)) {
      await route.abort();
      return;
    }

    await route.continue();
  });
}

async function fetchOffersInsideKaspi(page, productCode) {
  return page.evaluate(
    async ({ productCode, cityId }) => {
      const endpoint =
        `/yml/offer-view/offers/${encodeURIComponent(productCode)}`;

      const payload = {
        cityId,
        id: productCode,
        limit: 64,
        page: 0,
        sortOption: "PRICE"
      };

      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Content-Type": "application/json; charset=UTF-8"
        },
        body: JSON.stringify(payload)
      });

      let json = null;

      try {
        json = await response.json();
      } catch {
        json = null;
      }

      return {
        status: response.status,
        ok: response.ok,
        endpoint,
        json
      };
    },
    {
      productCode,
      cityId: CITY_ID
    }
  );
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    version: 6,
    mode: "decodo-kz-traffic-saving",
    proxyConfigured: proxyConfigured()
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

    await enableTrafficSaving(page);

    const response = await page.goto(
      "https://api.ipify.org?format=json",
      {
        waitUntil: "domcontentloaded",
        timeout: 60000
      }
    );

    const body = await page.textContent("body");

    let result;

    try {
      result = JSON.parse(body || "");
    } catch {
      result = { raw: body };
    }

    res.json({
      ok: true,
      version: 6,
      proxy: "decodo-kz",
      status: response?.status() ?? null,
      result
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: 6,
      error: String(error?.message || error)
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.get("/offers/:productCode", async (req, res) => {
  const productCode =
    cleanProductCode(req.params.productCode);

  if (!productCode) {
    return res.status(400).json({
      ok: false,
      safeToReprice: false,
      error: "BAD_PRODUCT_CODE"
    });
  }

  const productUrl =
    typeof req.query.url === "string" &&
    req.query.url.startsWith("https://kaspi.kz/")
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

    await enableTrafficSaving(page);

    await page.setExtraHTTPHeaders({
      "Accept-Language":
        "ru-RU,ru;q=0.9,en;q=0.8"
    });

    const passiveOffers = [];

    page.on("response", async (response) => {
      const url = response.url();

      if (
        url.includes("offer-view") ||
        url.includes("/offers")
      ) {
        try {
          const contentType =
            response.headers()["content-type"] || "";

          if (contentType.includes("json")) {
            const json = await response.json();

            const found = collectOffers(json);

            passiveOffers.push(...found);
          }
        } catch {
          // Запасной источник.
          // Ошибка здесь не ломает основной запрос.
        }
      }
    });

    let navigation = null;
    let navigationError = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        navigation = await page.goto(
          productUrl,
          {
            waitUntil: "domcontentloaded",
            timeout: 30000
          }
        );

        navigationError = null;
        break;
      } catch (error) {
        navigationError =
          String(error?.message || error);

        if (attempt < 3) {
          await page.waitForTimeout(1000);
        }
      }
    }

    if (!navigation) {
      throw new Error(
        `KASPI_NAVIGATION_FAILED_AFTER_3_ATTEMPTS: ${
          navigationError || "NO_RESPONSE"
        }`
      );
    }

    const navigationStatus = navigation.status();

    if (
      navigationStatus < 200 ||
      navigationStatus >= 400
    ) {
      throw new Error(
        `KASPI_BAD_NAVIGATION_STATUS_${navigationStatus}`
      );
    }

    await page.waitForTimeout(2500);

    let directResult = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        directResult =
          await fetchOffersInsideKaspi(
            page,
            productCode
          );

        if (
          directResult?.ok &&
          directResult?.json
        ) {
          break;
        }
      } catch (error) {
        directResult = {
          ok: false,
          status: null,
          error:
            String(error?.message || error),
          attempt
        };
      }

      if (attempt < 3) {
        await page.waitForTimeout(1500);
      }
    }

    const directOffers = [];

    if (directResult?.json) {
      collectOffers(
        directResult.json,
        directOffers
      );
    }

    const offers = uniqueOffers([
      ...directOffers,
      ...passiveOffers
    ]).sort((a, b) => a.price - b.price);

    if (offers.length === 0) {
      throw new Error(
        "NO_OFFERS_RECEIVED_PRICE_UPDATE_BLOCKED"
      );
    }

    res.json({
      ok: true,
      safeToReprice: true,
      version: 6,
      productCode,
      cityId: CITY_ID,
      offers,
      offerCount: offers.length
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      safeToReprice: false,
      version: 6,
      productCode,
      error:
        String(error?.message || error)
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Kaspi parser v6 listening on port ${PORT}`
  );
});

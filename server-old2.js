import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const CITY_ID = "391010000";

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "lashmarket-kaspi-parser", version: 2 });
});

function cleanPrice(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n) : null;
}

function normalizeOffer(obj) {
  if (!obj || typeof obj !== "object") return null;

  const merchant =
    obj.merchantName ??
    obj.merchant?.name ??
    obj.sellerName ??
    obj.seller?.name ??
    obj.shopName ??
    obj.storeName ??
    obj.name;

  const price =
    cleanPrice(obj.price) ??
    cleanPrice(obj.currentPrice) ??
    cleanPrice(obj.offerPrice) ??
    cleanPrice(obj.salePrice);

  if (typeof merchant === "string" && merchant.trim() && price && price > 0) {
    return { seller: merchant.trim(), price };
  }
  return null;
}

function walkJson(value, found, depth = 0) {
  if (depth > 10 || value == null) return;
  if (Array.isArray(value)) {
    for (const x of value) walkJson(x, found, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const offer = normalizeOffer(value);
  if (offer) found.push(offer);

  for (const v of Object.values(value)) {
    walkJson(v, found, depth + 1);
  }
}

function dedupeOffers(items) {
  const out = [];
  const seen = new Set();
  for (const x of items) {
    if (!x?.seller || !x?.price) continue;
    const key = `${x.seller.toLowerCase()}|${x.price}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(x);
    }
  }
  return out.sort((a, b) => a.price - b.price);
}

app.get("/offers/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!/^\d+$/.test(code)) {
    return res.status(400).json({ ok: false, error: "BAD_PRODUCT_CODE" });
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });

    const context = await browser.newContext({
      locale: "ru-RU",
      timezoneId: "Asia/Almaty",
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
      viewport: { width: 430, height: 932 },
      extraHTTPHeaders: {
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8"
      }
    });

    const page = await context.newPage();
    const jsonCandidates = [];
    const networkOffers = [];

    page.on("response", async (response) => {
      try {
        const ct = (response.headers()["content-type"] || "").toLowerCase();
        if (!ct.includes("json")) return;

        const url = response.url();
        const data = await response.json();

        const found = [];
        walkJson(data, found);
        if (found.length) {
          networkOffers.push(...found);
          jsonCandidates.push({
            url,
            status: response.status(),
            offersFound: found.length
          });
        }
      } catch {}
    });

    // 1) Open Kaspi search as a normal shopper.
    const searchUrl = `https://kaspi.kz/shop/search/?text=${encodeURIComponent(code)}`;
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    await page.waitForTimeout(5000);

    // 2) Find the product card URL from the rendered page.
    let productUrl = await page.evaluate((code) => {
      const links = [...document.querySelectorAll("a[href]")];
      const exact = links.find(a => (a.href || "").includes(code));
      return exact ? exact.href : null;
    }, code);

    // If search did not expose a URL, try links containing /shop/p/
    if (!productUrl) {
      productUrl = await page.evaluate(() => {
        const links = [...document.querySelectorAll('a[href*="/shop/p/"]')];
        return links[0]?.href || null;
      });
    }

    if (productUrl) {
      await page.goto(productUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });
      await page.waitForTimeout(6000);
    }

    // 3) Try to open seller/offer UI exactly as a shopper would.
    const labels = [
      /все продавцы/i,
      /продавцы/i,
      /предложения/i,
      /купить у/i
    ];

    for (const re of labels) {
      try {
        const loc = page.getByText(re).first();
        if (await loc.isVisible({ timeout: 1200 })) {
          await loc.click({ timeout: 2500 });
          await page.waitForTimeout(4000);
          break;
        }
      } catch {}
    }

    // 4) Scrape visible DOM for seller + price blocks.
    const domResult = await page.evaluate(() => {
      const priceRe = /(\d[\d\s\u00A0]{1,10})\s*₸/g;
      const rows = [];
      const all = [...document.querySelectorAll("body *")];

      for (const el of all) {
        const txt = (el.innerText || "").trim();
        if (!txt || txt.length > 500) continue;
        const matches = [...txt.matchAll(priceRe)];
        if (!matches.length) continue;

        const priceText = matches[0][1].replace(/[\s\u00A0]/g, "");
        const price = Number(priceText);
        if (!Number.isFinite(price) || price < 100) continue;

        const lines = txt.split("\n").map(x => x.trim()).filter(Boolean);
        const sellerLine = lines.find(x =>
          !/₸/.test(x) &&
          !/достав/i.test(x) &&
          !/рейтинг/i.test(x) &&
          !/отзыв/i.test(x) &&
          x.length >= 2 &&
          x.length <= 80
        );

        if (sellerLine) rows.push({ seller: sellerLine, price, text: txt.slice(0, 220) });
      }

      const unique = [];
      const seen = new Set();
      for (const x of rows) {
        const k = `${x.seller.toLowerCase()}|${x.price}`;
        if (!seen.has(k)) {
          seen.add(k);
          unique.push(x);
        }
      }
      return unique.slice(0, 50);
    });

    const offers = dedupeOffers([
      ...networkOffers,
      ...domResult.map(x => ({ seller: x.seller, price: x.price }))
    ]);

    const bodyText = await page.locator("body").innerText().catch(() => "");

    res.json({
      ok: offers.length > 0,
      version: 2,
      productCode: code,
      cityId: CITY_ID,
      productUrl: productUrl || null,
      pageTitle: await page.title(),
      finalUrl: page.url(),
      offers,
      diagnostics: {
        networkCandidates: jsonCandidates.slice(0, 30),
        domCandidates: domResult.slice(0, 20),
        bodySample: bodyText.slice(0, 1500)
      }
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      version: 2,
      error: String(e)
    });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on ${PORT}`);
});

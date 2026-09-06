import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const CITY_ID = "391010000";

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "lashmarket-kaspi-parser" });
});

app.get("/offers/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!/^\d+$/.test(code)) {
    return res.status(400).json({ ok: false, error: "BAD_PRODUCT_CODE" });
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext({
      locale: "ru-RU",
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36"
    });
    const page = await context.newPage();

    await page.goto(`https://kaspi.kz/shop/search/?text=${encodeURIComponent(code)}`, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });
    await page.waitForTimeout(4000);

    const api = await page.evaluate(async ({ code, cityId }) => {
      try {
        const r = await fetch(`https://kaspi.kz/yml/offer-view/offers/${code}`, {
          method: "POST",
          credentials: "include",
          headers: {
            "accept": "application/json, text/plain, */*",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            cityId,
            id: code,
            limit: 50,
            page: 0,
            sortOption: "PRICE"
          })
        });
        const text = await r.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        return { status: r.status, data, text: data ? undefined : text.slice(0, 1000) };
      } catch (e) {
        return { status: 0, error: String(e) };
      }
    }, { code, cityId: CITY_ID });

    res.json({
      ok: api.status >= 200 && api.status < 300,
      productCode: code,
      cityId: CITY_ID,
      api,
      pageTitle: await page.title(),
      finalUrl: page.url()
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));

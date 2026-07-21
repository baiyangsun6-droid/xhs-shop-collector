import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { dataDir } from "./config.mjs";

let browserContext = null;
let activePage = null;

const profileDir = path.join(dataDir, "playwright-profile", "xhs");
const debugDir = path.join(dataDir, "debug");
const shopApiEndpoint = "https://mall.xiaohongshu.com/api/store/guide/components/general/h5";

export async function openLoginBrowser() {
  const context = await ensureContext();
  const page = await context.newPage();
  activePage = page;
  await page.goto("https://www.xiaohongshu.com", { waitUntil: "domcontentloaded", timeout: 60000 });
  return { ok: true, message: "已打开小红书，请在浏览器里完成登录" };
}

export async function getBrowserStatus() {
  return {
    opened: Boolean(browserContext),
    pageUrl: activePage && !activePage.isClosed() ? activePage.url() : "",
  };
}

export async function collectCreatorProducts(url, config, hooks = {}) {
  try {
    return await collectCreatorProductsPublic(url, config, hooks);
  } catch (error) {
    if (!config.collector?.useBrowserFallback) throw error;
    hooks.onDiagnostic?.({
      debugDir,
      debugId: "",
      reason: `公开模式失败：${error.message}`,
    });
    hooks.onStep?.("公开模式失败，使用浏览器兜底");
  }

  return collectCreatorProductsWithBrowser(url, config, hooks);
}

async function collectCreatorProductsPublic(url, config, hooks = {}) {
  const collectedAt = new Date().toISOString();
  const requestDelayMs = Math.max(1000, Number(config.collector?.requestDelayMs) || 3000);

  hooks.onStep?.("公开模式解析链接");
  const resolved = await resolvePublicUrl(url);
  let creatorUrl = canonicalXhsUrl(resolved.finalUrl, url);
  let sellerId = shopSellerId(resolved.finalUrl) || extractSellerIdFromText(resolved.finalUrl);
  let creatorName = extractCreatorNameFromHtml(resolved.body);

  if (!sellerId) {
    hooks.onStep?.("公开模式查找店铺标识");
    const discovered = await discoverPublicShop(url, resolved);
    sellerId = discovered.sellerId;
    creatorName = creatorName || discovered.creatorName;
    creatorUrl = discovered.creatorUrl || creatorUrl;
  }

  if (!sellerId) {
    const reason = "公开模式未识别到店铺入口；为保护账号，默认不会自动打开、点击或滚动小红书页面。请改用店铺分享链接，或在连接配置里手动开启浏览器兜底。";
    hooks.onDiagnostic?.({ debugDir, debugId: "", reason });
    throw new Error(reason);
  }

  hooks.onStep?.("请求公开店铺商品接口");
  const apiResult = await collectProductsFromShopApiHttp({
    sellerId,
    collectedAt,
    requestDelayMs,
    onProgress: hooks.onProgress,
    shouldStop: hooks.shouldStop,
  });

  creatorName = cleanTitle(creatorName || apiResult.creatorName || `店铺 ${sellerId.slice(0, 8)}`).slice(0, 80) || "未知博主";
  const shopUrl = `https://www.xiaohongshu.com/shop/${sellerId}`;
  const creator = {
    name: creatorName,
    url: creatorUrl,
    shopUrl,
    aliasUrls: [shopUrl].filter((item) => item && item !== creatorUrl),
  };
  hooks.onCreator?.(creator);

  if (apiResult.products.length === 0) {
    hooks.onDiagnostic?.({
      debugDir,
      debugId: "",
      reason: "公开店铺接口没有返回在售商品",
    });
  }

  return {
    creator,
    products: apiResult.products,
    safeToOverwriteEmpty: true,
  };
}

async function collectCreatorProductsWithBrowser(url, config, hooks = {}) {
  const context = await ensureContext();
  let page = await context.newPage();
  activePage = page;
  const collectedAt = new Date().toISOString();
  const debugId = new Date().toISOString().replace(/[:.]/g, "-");

  hooks.onStep?.("打开博主主页");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(2500);
  await saveDebugSnapshot(page, `${debugId}-profile`);

  const creatorName = await getCreatorName(page);
  const creatorUrl = canonicalXhsUrl(page.url(), url);
  hooks.onCreator?.({ name: creatorName, url: creatorUrl });

  hooks.onStep?.("查找店铺入口");
  const shopResult = isShopPage(page.url()) ? { page, clicked: false, isShopPage: true } : await openShopArea(page);
  if (shopResult.page && shopResult.page !== page) {
    await page.close().catch(() => {});
    page = shopResult.page;
    activePage = page;
  }
  if (isShopPage(page.url())) {
    const previewUrl = shopPreviewUrl(page.url());
    if (previewUrl !== page.url()) {
      hooks.onStep?.("打开店铺预览页");
      await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    }
  }
  await page.waitForTimeout(1500);
  await saveDebugSnapshot(page, `${debugId}-shop`, shopResult);

  const sellerId = shopSellerId(page.url());
  let apiProducts = [];
  let apiTotal = 0;
  if (sellerId) {
    hooks.onStep?.("请求店铺商品接口");
    const apiResult = await collectProductsFromShopApi(page, {
      sellerId,
      collectedAt,
    });
    apiProducts = apiResult.products;
    apiTotal = apiResult.total;
    hooks.onProgress?.(apiProducts, 1);
  }

  let products = apiProducts;
  if (!products.length || (apiTotal && products.length < apiTotal)) {
    hooks.onStep?.(products.length ? "滚动商品列表补充解析" : "滚动商品列表");
    const pageProducts = await collectProductsFromPage(page, {
      collectedAt,
      maxScrollRounds: config.collector.maxScrollRounds,
      stableRounds: config.collector.stableRounds,
      onProgress: hooks.onProgress,
      shouldStop: hooks.shouldStop,
    });
    products = mergeProducts(apiProducts, pageProducts);
  }

  if (products.length === 0) {
    hooks.onDiagnostic?.({
      debugDir,
      debugId,
      reason: shopResult.isShopPage
        ? "已进入店铺页，但页面未解析出商品卡片"
        : shopResult.clicked
          ? "已尝试进入店铺/商品入口，但页面未解析出商品卡片"
          : "未找到明确的店铺/商品入口",
    });
  }

  await page.close().catch(() => {});
  const shopUrl = sellerId ? `https://www.xiaohongshu.com/shop/${sellerId}` : "";
  return {
    creator: {
      name: creatorName,
      url: creatorUrl,
      shopUrl,
      aliasUrls: [shopUrl].filter((item) => item && item !== creatorUrl),
    },
    products,
    safeToOverwriteEmpty: Boolean(shopResult.isShopPage || shopResult.clicked),
  };
}

async function ensureContext() {
  if (browserContext) return browserContext;
  const { chromium } = await import("playwright");
  browserContext = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1365, height: 900 },
    locale: "zh-CN",
  });
  browserContext.on("close", () => {
    browserContext = null;
    activePage = null;
  });
  return browserContext;
}

async function resolvePublicUrl(inputUrl) {
  if (!isHttpUrl(inputUrl)) return { finalUrl: inputUrl, body: "" };
  try {
    const response = await fetchWithTimeout(inputUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      },
      timeoutMs: 30000,
    });
    const contentType = response.headers.get("content-type") || "";
    const canReadBody = /text|html|json|javascript/.test(contentType);
    return {
      finalUrl: response.url || inputUrl,
      body: canReadBody ? await response.text() : "",
    };
  } catch {
    return { finalUrl: inputUrl, body: "" };
  }
}

async function discoverPublicShop(inputUrl, resolved) {
  const candidates = Array.from(new Set([resolved.finalUrl, inputUrl].filter(Boolean)));
  let body = resolved.body || "";

  for (const candidate of candidates) {
    const sellerId = shopSellerId(candidate) || extractSellerIdFromText(candidate) || extractSellerIdFromText(body);
    const creatorName = extractCreatorNameFromHtml(body);
    if (sellerId) {
      return {
        sellerId,
        creatorName,
        creatorUrl: canonicalXhsUrl(candidate, inputUrl),
      };
    }
    if (!body && isHttpUrl(candidate)) {
      try {
        const response = await fetchWithTimeout(candidate, {
          method: "GET",
          redirect: "follow",
          headers: {
            accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          },
          timeoutMs: 30000,
        });
        body = await response.text();
        const nextSellerId = shopSellerId(response.url) || extractSellerIdFromText(response.url) || extractSellerIdFromText(body);
        if (nextSellerId) {
          return {
            sellerId: nextSellerId,
            creatorName: extractCreatorNameFromHtml(body),
            creatorUrl: canonicalXhsUrl(response.url, inputUrl),
          };
        }
      } catch {
        // Public discovery is best effort; the caller decides whether to fail or use browser fallback.
      }
    }
    body = "";
  }

  return { sellerId: "", creatorName: "", creatorUrl: "" };
}

async function collectProductsFromShopApiHttp(options) {
  const pageSize = 10;
  const maxPages = 20;
  const products = [];
  let total = 0;
  let creatorName = "";

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    if (options.shouldStop?.()) break;

    const payload = {
      biz_identity: { template_id: "shopH5Page", biz_type: "shop", scene: "shop_pc" },
      component_param: {
        mix_card_component_param: [
          {
            page_param: { page: pageIndex, page_size: pageSize },
            sort_type: "sales_qty",
          },
        ],
      },
      common_param: { seller_id: options.sellerId },
    };

    const response = await fetchWithTimeout(shopApiEndpoint, {
      method: "POST",
      redirect: "follow",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        referer: `https://www.xiaohongshu.com/shop/${encodeURIComponent(options.sellerId)}?preview=true`,
      },
      body: JSON.stringify(payload),
      timeoutMs: 45000,
    });

    if (!response.ok) throw new Error(`公开店铺接口返回 HTTP ${response.status}`);

    const data = await response.json();
    creatorName = creatorName || extractShopNameFromApi(data);

    const component = findComponent(data, "DefaultMixCardComponent");
    const componentData = getValue(component, ["componentData", "component_data"]) || {};
    const componentTotal = Number(getValue(componentData, ["total"]) || 0);
    if (componentTotal > total) total = componentTotal;

    const rows = extractGoodsRows(componentData, options.collectedAt);
    if (!rows.length) break;
    products.push(...rows);

    const unique = uniqueProducts(products);
    options.onProgress?.(normalizeProductsSales(unique), pageIndex + 1);

    if (total && unique.length >= total) break;
    if (getValue(componentData, ["hasMore", "has_more"]) === false) break;
    await delay(options.requestDelayMs);
  }

  return {
    products: normalizeProductsSales(uniqueProducts(products)),
    total,
    creatorName: cleanTitle(stripShopSuffix(creatorName)),
  };
}

async function getCreatorName(page) {
  const title = await page.evaluate(() => {
    const selectors = [
      "[class*='shop-name']",
      "[class*='shop-info']",
      "[class*='user-name']",
      "[class*='nickname']",
      "[class*='name']",
      "h1",
      "meta[property='og:title']",
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const value = node?.content || node?.textContent;
      if (value && value.trim().length > 1) return value.trim().split(/\n/)[0];
    }
    return document.title || "未知博主";
  });
  return cleanTitle(title).slice(0, 80) || "未知博主";
}

async function openShopArea(page) {
  const popupPromise = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
  const result = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("a,button,[role='button'],[class*='shop'],[class*='goods'],[class*='product'],span,div"));
    const candidates = nodes
      .map((node) => {
        const clickable = node.closest("a,button,[role='button']") || node;
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        const href = clickable.href || node.href || "";
        const cls = `${node.className || ""} ${clickable.className || ""}`;
        const textOrHrefMatches = /店铺|橱窗|商品|好物|购物|小店|商城/.test(text) || /shop|store|goods|product|commerce|mall/i.test(href);
        let score = 0;
        if (/店铺|橱窗|商品|好物|购物|小店|商城/.test(text)) score += 20;
        if (/店铺|橱窗|商品|好物|购物|小店|商城/.test(clickable.textContent || "")) score += 16;
        if (/shop|store|goods|product|commerce|mall/i.test(href)) score += 18;
        if (textOrHrefMatches && /shop|store|goods|product|commerce|mall/i.test(cls)) score += 10;
        if (text.length > 80) score -= 8;
        if (!textOrHrefMatches || (!text && !href && score < 10)) score = 0;
        return { node, clickable, text, href, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const target = candidates[0];
    if (!target) {
      return {
        clicked: false,
        candidates: candidates.slice(0, 10).map(({ text, href, score }) => ({ text, href, score })),
      };
    }
    target.clickable.scrollIntoView({ block: "center" });
    target.clickable.click();
    return {
      clicked: true,
      text: target.text,
      href: target.href,
      score: target.score,
      candidates: candidates.slice(0, 10).map(({ text, href, score }) => ({ text, href, score })),
    };
  });
  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    await popup.waitForTimeout(1500);
    return { ...result, page: popup, openedPopup: true };
  }
  if (result.clicked) {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    return { ...result, page };
  }

  const links = await page.$$eval("a[href]", (nodes) =>
    nodes
      .map((node) => ({ href: node.href, text: node.textContent || "" }))
      .filter((item) => /shop|goods|store|commerce|product/.test(item.href + item.text))
      .slice(0, 1)
  );
  if (links[0]?.href) {
    await page.goto(links[0].href, { waitUntil: "domcontentloaded", timeout: 60000 });
    return { clicked: true, text: links[0].text, href: links[0].href, page };
  }
  return { ...result, page };
}

async function collectProductsFromPage(page, options) {
  let products = [];
  let stable = 0;
  const maxRounds = Number(options.maxScrollRounds) || 40;
  const stableRounds = Number(options.stableRounds) || 5;

  for (let round = 0; round < maxRounds; round += 1) {
    if (options.shouldStop?.()) break;
    const next = await extractProducts(page, options.collectedAt);
    if (next.length > products.length) {
      products = next;
      stable = 0;
    } else {
      stable += 1;
    }
    options.onProgress?.(products, round + 1);
    if (stable >= stableRounds) break;
    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 0.85, 600)));
    await page.waitForTimeout(1200);
  }

  return products;
}

async function collectProductsFromShopApi(page, options) {
  try {
    const result = await page.evaluate(async ({ sellerId, collectedAt }) => {
      const pageSize = 10;
      const maxPages = 20;
      const endpoint = "https://mall.xiaohongshu.com/api/store/guide/components/general/h5";
      const products = [];
      let total = 0;

      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const payload = {
          biz_identity: { template_id: "shopH5Page", biz_type: "shop", scene: "shop_pc" },
          component_param: {
            mix_card_component_param: [
              {
                page_param: { page: pageIndex, page_size: pageSize },
                sort_type: "sales_qty",
              },
            ],
          },
          common_param: { seller_id: sellerId },
        };

        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            accept: "application/json, text/plain, */*",
            "content-type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify(payload),
        });
        if (!response.ok) break;

        const data = await response.json();
        const component = findComponent(data, "DefaultMixCardComponent");
        const componentData = getValue(component, ["componentData", "component_data"]) || {};
        const componentTotal = Number(getValue(componentData, ["total"]) || 0);
        if (componentTotal > total) total = componentTotal;

        const rows = extractGoodsRows(componentData, collectedAt);
        if (!rows.length) break;
        products.push(...rows);

        if (total && products.length >= total) break;
        if (getValue(componentData, ["hasMore", "has_more"]) === false) break;
      }

      return { products: uniqueProducts(products), total };

      function findComponent(value, name) {
        if (!value || typeof value !== "object") return null;
        const componentName = getValue(value, ["componentName", "component_name"]);
        if (componentName === name) return value;
        if (Array.isArray(value)) {
          for (const item of value) {
            const found = findComponent(item, name);
            if (found) return found;
          }
          return null;
        }
        for (const item of Object.values(value)) {
          const found = findComponent(item, name);
          if (found) return found;
        }
        return null;
      }

      function extractGoodsRows(value, collectedAtValue) {
        const goods = [];
        walkGoods(value, goods);
        return goods
          .filter((goodsItem) => getValue(getValue(goodsItem, ["baseInfo", "base_info"]) || {}, ["buyable"]) !== false)
          .map((goodsItem, index) => {
            const base = getValue(goodsItem, ["baseInfo", "base_info"]) || {};
            const marketing = getValue(goodsItem, ["marketingInfo", "marketing_info"]) || {};
            const priceInfo = getValue(marketing, ["priceInfo", "price_info"]) || {};
            const expectedPrice = getValue(priceInfo, ["expectedPrice", "expected_price"]) || {};
            const tagMap = getValue(goodsItem, ["tagStrategyMap", "tag_strategy_map"]) || {};
            const afterPrice = getValue(tagMap, ["afterPrice", "after_price"]) || [];
            const title = getValue(base, ["title"]) || "";
            const skuId = getValue(base, ["skuId", "sku_id"]) || "";
            const itemId = getValue(base, ["itemId", "item_id"]) || "";
            const link = getValue(base, ["link"]) || "";
            const price =
              getValue(expectedPrice, ["priceStr", "price_str"]) ||
              formatPrice(getValue(expectedPrice, ["price"]));
            const sales =
              Array.isArray(afterPrice)
                ? afterPrice
                    .map((tag) => getValue(tag, ["content"]) || getValue(getValue(tag, ["tagContent", "tag_content"]) || {}, ["content"]))
                    .filter(Boolean)
                    .join(" ")
                : "";
            const id = skuId || itemId;
            const url = isHttpUrl(link)
              ? link
              : id
                ? `https://www.xiaohongshu.com/goods-detail/${encodeURIComponent(id)}`
                : `${location.origin}${location.pathname}#product-${index + 1}`;
            return { title, sales, price, url, collectedAt: collectedAtValue };
          })
          .filter((item) => item.title && item.price);
      }

      function walkGoods(value, out) {
        if (!value || typeof value !== "object") return;
        const goods = getValue(value, ["defaultGoodsComponentVO", "default_goods_component_vo"]);
        if (goods && getValue(goods, ["baseInfo", "base_info"])) out.push(goods);
        if (Array.isArray(value)) {
          value.forEach((item) => walkGoods(item, out));
          return;
        }
        Object.values(value).forEach((item) => walkGoods(item, out));
      }

      function uniqueProducts(rows) {
        const seen = new Set();
        return rows.filter((row) => {
          const key = productKey(row.url);
          if (seen.has(key)) return false;
          seen.add(key);
          return row.title && row.url;
        });
      }

      function getValue(value, names) {
        if (!value || typeof value !== "object") return undefined;
        const normalKeys = new Map(Object.keys(value).map((key) => [key.replace(/_/g, "").toLowerCase(), key]));
        for (const name of names) {
          const key = normalKeys.get(name.replace(/_/g, "").toLowerCase());
          if (key) return value[key];
        }
        return undefined;
      }

      function productKey(url) {
        const match = String(url || "").match(/\/(?:goods|goods-detail)\/([^/?#]+)/);
        return match?.[1] || String(url || "").replace(/\/$/, "");
      }

      function formatPrice(value) {
        if (value === undefined || value === null || value === "") return "";
        const number = Number(value);
        if (!Number.isFinite(number)) return "";
        return `¥${number / 100}`;
      }

      function isHttpUrl(value) {
        try {
          const url = new URL(value);
          return /^https?:$/.test(url.protocol);
        } catch {
          return false;
        }
      }
    }, options);
    return {
      ...result,
      products: normalizeProductsSales(result.products),
    };
  } catch {
    return { products: [], total: 0 };
  }
}

function findComponent(value, name) {
  if (!value || typeof value !== "object") return null;
  const componentName = getValue(value, ["componentName", "component_name"]);
  if (componentName === name) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findComponent(item, name);
      if (found) return found;
    }
    return null;
  }
  for (const item of Object.values(value)) {
    const found = findComponent(item, name);
    if (found) return found;
  }
  return null;
}

function extractGoodsRows(value, collectedAtValue) {
  const goods = [];
  walkGoods(value, goods);
  return goods
    .filter((goodsItem) => getValue(getValue(goodsItem, ["baseInfo", "base_info"]) || {}, ["buyable"]) !== false)
    .map((goodsItem, index) => {
      const base = getValue(goodsItem, ["baseInfo", "base_info"]) || {};
      const marketing = getValue(goodsItem, ["marketingInfo", "marketing_info"]) || {};
      const priceInfo = getValue(marketing, ["priceInfo", "price_info"]) || {};
      const expectedPrice = getValue(priceInfo, ["expectedPrice", "expected_price"]) || {};
      const tagMap = getValue(goodsItem, ["tagStrategyMap", "tag_strategy_map"]) || {};
      const afterPrice = getValue(tagMap, ["afterPrice", "after_price"]) || [];
      const title = getValue(base, ["title"]) || "";
      const skuId = getValue(base, ["skuId", "sku_id"]) || "";
      const itemId = getValue(base, ["itemId", "item_id"]) || "";
      const link = getValue(base, ["link"]) || "";
      const price =
        getValue(expectedPrice, ["priceStr", "price_str"]) ||
        formatPrice(getValue(expectedPrice, ["price"]));
      const sales =
        Array.isArray(afterPrice)
          ? afterPrice
              .map((tag) => getValue(tag, ["content"]) || getValue(getValue(tag, ["tagContent", "tag_content"]) || {}, ["content"]))
              .filter(Boolean)
              .join(" ")
          : "";
      const id = skuId || itemId;
      const url = isHttpUrl(link)
        ? link
        : id
          ? `https://www.xiaohongshu.com/goods-detail/${encodeURIComponent(id)}`
          : `https://www.xiaohongshu.com/goods-detail/public-${index + 1}`;
      return {
        title: cleanWhitespace(title),
        sales,
        price: cleanWhitespace(price),
        url,
        collectedAt: collectedAtValue,
      };
    })
    .filter((item) => item.title && item.price);
}

function walkGoods(value, out) {
  if (!value || typeof value !== "object") return;
  const goods = getValue(value, ["defaultGoodsComponentVO", "default_goods_component_vo"]);
  if (goods && getValue(goods, ["baseInfo", "base_info"])) out.push(goods);
  if (Array.isArray(value)) {
    value.forEach((item) => walkGoods(item, out));
    return;
  }
  Object.values(value).forEach((item) => walkGoods(item, out));
}

function uniqueProducts(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = productKey(row.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return row.title && row.url;
  });
}

function getValue(value, names) {
  if (!value || typeof value !== "object") return undefined;
  const normalKeys = new Map(Object.keys(value).map((key) => [key.replace(/_/g, "").toLowerCase(), key]));
  for (const name of names) {
    const key = normalKeys.get(name.replace(/_/g, "").toLowerCase());
    if (key) return value[key];
  }
  return undefined;
}

function extractSellerIdFromText(value) {
  const text = String(value || "");
  if (!text) return "";
  const sources = [text];
  try {
    sources.push(decodeURIComponent(text));
    sources.push(decodeURIComponent(decodeURIComponent(text)));
  } catch {
    // Ignore malformed escape sequences.
  }

  for (const source of sources) {
    const match =
      source.match(/\/shop\/([A-Za-z0-9_-]{8,})/) ||
      source.match(/seller_id(?:=|["':\s]+)([A-Za-z0-9_-]{8,})/i) ||
      source.match(/sellerId["':\s]+([A-Za-z0-9_-]{8,})/i);
    if (match?.[1]) return match[1].replace(/[?&#"'<>].*$/, "");
  }
  return "";
}

function extractCreatorNameFromHtml(value) {
  const text = String(value || "");
  if (!text) return "";
  const candidates = [
    text.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1],
    text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1],
    text.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1],
    text.match(/"nickname"\s*:\s*"([^"]+)"/i)?.[1],
    text.match(/"userName"\s*:\s*"([^"]+)"/i)?.[1],
    text.match(/"sellerName"\s*:\s*"([^"]+)"/i)?.[1],
  ]
    .map((item) => decodeHtmlEntities(item || ""))
    .map((item) => cleanTitle(stripShopSuffix(item)))
    .filter((item) => item && item !== "小红书" && item.length <= 80);
  return candidates[0] || "";
}

function extractShopNameFromApi(value) {
  const names = [];
  collectShopNames(value, names);
  return names.map((item) => cleanTitle(stripShopSuffix(item))).find(Boolean) || "";
}

function collectShopNames(value, out) {
  if (!value || typeof value !== "object") return;
  const sellerInfo =
    getValue(value, ["baseSellerInfo", "base_seller_info"]) ||
    getValue(value, ["sellerInfo", "seller_info"]) ||
    getValue(value, ["shopInfo", "shop_info"]);
  if (sellerInfo && typeof sellerInfo === "object") {
    const name = getValue(sellerInfo, ["sellerName", "seller_name", "shopName", "shop_name", "name"]);
    if (name) out.push(String(name));
  }

  const componentName = getValue(value, ["componentName", "component_name"]);
  if (componentName && /shop|seller/i.test(componentName)) {
    const name = getValue(value, ["sellerName", "seller_name", "shopName", "shop_name", "name", "title"]);
    if (name) out.push(String(name));
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectShopNames(item, out));
    return;
  }
  Object.values(value).forEach((item) => collectShopNames(item, out));
}

function stripShopSuffix(value) {
  return cleanWhitespace(value)
    .replace(/的小店$/, "")
    .replace(/的店铺$/, "")
    .replace(/的店$/, "");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function formatPrice(value) {
  if (value === undefined || value === null || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return `¥${number / 100}`;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol);
  } catch {
    return false;
  }
}

async function fetchWithTimeout(resource, options = {}) {
  const { timeoutMs = 30000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(resource, { ...fetchOptions, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractProducts(page, collectedAt) {
  const rows = await page.evaluate(() => {
    const setupRows = extractFromSetupServerState();
    if (setupRows.length) return setupRows;

    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const result = [];
    for (const anchor of anchors) {
      const href = anchor.href;
      const container =
        anchor.closest("[class*='goods'],[class*='product'],[class*='shop'],li,section,article") ||
        anchor.parentElement ||
        anchor;
      const text = (container.innerText || anchor.textContent || "").replace(/\s+\n/g, "\n").trim();
      if (!text || /售罄|下架|已抢光/.test(text)) continue;
      const looksLikeProduct = /¥|￥|价格|已售|销量|购买/.test(text) || /goods|product|shop|store|commerce|item/.test(href);
      if (!looksLikeProduct) continue;
      const price = (text.match(/[¥￥]\s*[\d,.]+(?:\.\d+)?/) || text.match(/(?:价格|到手价)[:：]?\s*[\d,.]+(?:\.\d+)?/))?.[0] || "";
      const sales = (text.match(/(?:已售|销量|售出|付款|人买)[^\n\s]*/) || text.match(/\d+(?:\.\d+)?[万千]?\+?\s*(?:人付款|件已售|已售)/))?.[0] || "";
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => line !== price && line !== sales)
        .filter((line) => !/^¥|^￥|已售|销量|售出|购买|加入购物车/.test(line));
      const title = lines.find((line) => line.length >= 4 && line.length <= 120) || anchor.textContent?.trim() || "";
      if (!title || !href) continue;
      result.push({ title, sales, price, url: href });
    }

    const pricedNodes = Array.from(document.querySelectorAll("div,li,section,article"))
      .filter((node) => {
        const text = (node.innerText || "").trim();
        return text.length >= 8 && text.length <= 500 && /[¥￥]\s*[\d,.]+/.test(text) && !/售罄|下架|已抢光/.test(text);
      })
      .slice(0, 200);
    for (const node of pricedNodes) {
      const text = node.innerText.replace(/\s+\n/g, "\n").trim();
      const anchor = node.querySelector("a[href]") || node.closest("a[href]");
      const href = anchor?.href || "";
      const price = (text.match(/[¥￥]\s*[\d,.]+(?:\.\d+)?/) || [])[0] || "";
      const sales = (text.match(/(?:已售|销量|售出|付款|人买)[^\n\s]*/) || text.match(/\d+(?:\.\d+)?[万千]?\+?\s*(?:人付款|件已售|已售)/) || [])[0] || "";
      const title = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => line !== price && line !== sales)
        .filter((line) => line.length >= 4 && line.length <= 120)
        .find((line) => !/^¥|^￥|已售|销量|售出|购买|加入购物车/.test(line));
      if (title && href) {
        result.push({ title, sales, price, url: href });
      }
    }

    const itemNodes = Array.from(document.querySelectorAll(".product-item,[class*='product-item']"))
      .filter((node) => {
        const text = (node.innerText || "").trim();
        return text && /[¥￥]/.test(text) && !/售罄|下架|已抢光/.test(text);
      })
      .slice(0, 200);
    for (const [index, node] of itemNodes.entries()) {
      const title = node.querySelector(".title-content,[class*='title']")?.textContent?.trim() || "";
      const unit = node.querySelector(".unit")?.textContent?.trim() || "¥";
      const num = node.querySelector(".num")?.textContent?.trim() || "";
      const decimal = node.querySelector(".decimal")?.textContent?.replace(/\s+/g, "").trim() || "";
      const price = num ? `${unit}${num}${decimal}` : "";
      const sales = node.querySelector(".sold-num,[class*='sold']")?.textContent?.replace(/\s+/g, "").trim() || "";
      const href = node.querySelector("a[href]")?.href || node.closest("a[href]")?.href || `${location.origin}${location.pathname}#product-${index + 1}`;
      if (title && price) {
        result.push({ title, sales, price, url: href });
      }
    }
    return result;

    function extractFromSetupServerState() {
      const state = window.__SETUP_SERVER_STATE__;
      const goods = [];
      walk(state, goods);
      return goods
        .filter((goodsItem) => goodsItem?.baseInfo?.buyable !== false)
        .map((goodsItem, index) => {
          const base = goodsItem.baseInfo || {};
          const title = base.title || "";
          const price = goodsItem.marketingInfo?.priceInfo?.expectedPrice?.priceStr || "";
          const sales =
            goodsItem.tagStrategyMap?.afterPrice?.map((tag) => tag.content || tag.tagContent?.content).filter(Boolean).join(" ") ||
            (base.itemSaleNum ? `已售${base.itemSaleNum}` : "");
          const skuId = base.skuId || "";
          const itemId = base.itemId || "";
          const sellerId = base.sellerId || "";
          const url = skuId || itemId
            ? `https://www.xiaohongshu.com/goods/${encodeURIComponent(skuId || itemId)}`
            : `${location.origin}${location.pathname}#product-${index + 1}`;
          return { title, sales, price, url, sellerId, sourceLink: base.link || "" };
        })
        .filter((item) => item.title && item.price);
    }

    function walk(value, out) {
      if (!value || typeof value !== "object") return;
      if (value.defaultGoodsComponentVO?.baseInfo) out.push(value.defaultGoodsComponentVO);
      if (Array.isArray(value)) {
        value.forEach((item) => walk(item, out));
        return;
      }
      Object.values(value).forEach((item) => walk(item, out));
    }
  });

  const seen = new Set();
  return rows
    .map((row) => ({
      title: cleanWhitespace(row.title),
      sales: normalizeSalesValue(row.sales),
      price: cleanWhitespace(row.price || "页面未展示"),
      url: row.url,
      collectedAt,
    }))
    .filter((row) => {
      const key = row.url.replace(/\/$/, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return row.title && row.url;
    });
}

function normalizeProductsSales(products) {
  return (products || []).map((product) => ({
    ...product,
    sales: normalizeSalesValue(product.sales),
  }));
}

function normalizeSalesValue(value) {
  const parsed = parseSalesCount(value);
  return parsed ?? 0;
}

function parseSalesCount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  const text = cleanWhitespace(value);
  if (!text) return null;
  const match =
    text.match(/(?:已售|销量|售出|付款|人买)\s*([0-9]+(?:\.[0-9]+)?)(万|千|k|w)?\+?/i) ||
    text.match(/([0-9]+(?:\.[0-9]+)?)(万|千|k|w)?\+?\s*(?:人付款|件已售|已售|销量|售出)/i) ||
    text.match(/([0-9]+(?:\.[0-9]+)?)(万|千|k|w)?\+?/i);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  const unit = (match[2] || "").toLowerCase();
  const multiplier = unit === "万" || unit === "w" ? 10000 : unit === "千" || unit === "k" ? 1000 : 1;
  return Math.round(number * multiplier);
}

function mergeProducts(...groups) {
  const seen = new Set();
  const result = [];
  for (const group of groups) {
    for (const row of group || []) {
      const key = productKey(row.url);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(row);
    }
  }
  return result;
}

function isShopPage(value) {
  try {
    return new URL(value).pathname.startsWith("/shop/");
  } catch {
    return false;
  }
}

function shopSellerId(value) {
  try {
    return new URL(value).pathname.match(/^\/shop\/([^/]+)/)?.[1] || "";
  } catch {
    return "";
  }
}

function productKey(value) {
  const match = String(value || "").match(/\/(?:goods|goods-detail)\/([^/?#]+)/);
  return match?.[1] || String(value || "").replace(/\/$/, "");
}

function shopPreviewUrl(value) {
  try {
    const url = new URL(value);
    const shopMatch = url.pathname.match(/^\/shop\/([^/]+)/);
    if (!shopMatch) return value;
    return `https://www.xiaohongshu.com/shop/${shopMatch[1]}?preview=true`;
  } catch {
    return value;
  }
}

function canonicalXhsUrl(value, fallback = value) {
  try {
    const url = new URL(value);
    if (!/xiaohongshu\.com$/.test(url.hostname) && !/xhslink\.com$/.test(url.hostname)) return fallback;
    const profileMatch = url.pathname.match(/^\/user\/profile\/([^/]+)/);
    if (profileMatch) return `https://www.xiaohongshu.com/user/profile/${profileMatch[1]}`;
    const shopMatch = url.pathname.match(/^\/shop\/([^/]+)/);
    if (shopMatch) return `https://www.xiaohongshu.com/shop/${shopMatch[1]}`;
    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

function cleanTitle(value) {
  return cleanWhitespace(value).replace(/[-_｜|].*小红书.*/i, "");
}

function cleanWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function saveDebugSnapshot(page, name, extra = {}) {
  try {
    await mkdir(debugDir, { recursive: true });
    const payload = await page.evaluate((extraPayload) => {
      const clickable = Array.from(document.querySelectorAll("a,button,[role='button'],span"))
        .map((node) => ({
          tag: node.tagName,
          text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
          href: node.href || "",
          className: String(node.className || "").slice(0, 120),
        }))
        .filter((item) => item.text || item.href)
        .slice(0, 200);
      const anchors = Array.from(document.querySelectorAll("a[href]"))
        .map((node) => ({
          text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
          href: node.href,
        }))
        .slice(0, 200);
      return {
        url: location.href,
        title: document.title,
        bodyText: document.body.innerText.slice(0, 5000),
        clickable,
        anchors,
        extra: extraPayload,
      };
    }, extra);
    await page.screenshot({ path: path.join(debugDir, `${name}.png`), fullPage: true }).catch(() => {});
    await writeFile(path.join(debugDir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // Debug capture must not break collection.
  }
}

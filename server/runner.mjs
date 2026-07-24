import { collectCreatorProducts, getBrowserStatus, openLoginBrowser } from "./scraper.mjs";
import { startFeishuUserAuthorization, testFeishuConnection, writeProductsForCreator } from "./lark.mjs";
import {
  createTasks,
  log,
  setConnection,
  setProductsPreview,
  state,
  updateTask,
} from "./state.mjs";

export async function testFeishu(config) {
  try {
    const result = await testFeishuConnection(config);
    if (result.ok) {
      setConnection("feishu", "connected", `字段映射正常，共 ${result.fieldCount} 个字段`);
    } else {
      setConnection("feishu", "error", `缺少字段：${result.missing.join("、")}`);
    }
    return result;
  } catch (error) {
    setConnection("feishu", "error", error.message);
    throw error;
  }
}

export async function authorizeFeishu(config) {
  setConnection("feishu", "pending", "等待在飞书页面确认授权");
  try {
    return await startFeishuUserAuthorization({
      onComplete: async () => {
        try {
          await testFeishu(config);
          log("INFO", "飞书用户授权成功，字段检查已通过");
        } catch (error) {
          log("ERROR", `飞书授权完成，但连接检查失败：${error.message}`);
        }
      },
      onError: async (error) => {
        setConnection("feishu", "error", error.message);
        log("ERROR", error.message);
      },
    });
  } catch (error) {
    setConnection("feishu", "error", error.message);
    throw error;
  }
}

export async function openLogin() {
  const result = await openLoginBrowser();
  setConnection("browser", "running", "可见浏览器已打开");
  setConnection("xhs", "pending", "仅供手动查看，默认采集不使用登录态");
  log("INFO", "已打开小红书浏览器，仅供手动查看");
  return result;
}

export async function refreshBrowserStatus() {
  const browser = await getBrowserStatus();
  setConnection("browser", browser.opened ? "running" : "idle", browser.opened ? "浏览器运行中" : "未打开");
  return browser;
}

export async function enqueueAndRun(urls, config, options = {}) {
  const cleanUrls = normalizeUrls(urls);
  if (!cleanUrls.length) throw new Error("请输入至少一个小红书博主主页链接");

  const writeMode = normalizeWriteMode(options.mode, options.overwrite);
  const salesFilter = normalizeSalesFilter(options.salesFilter);
  const tasks = createTasks(cleanUrls, writeMode, salesFilter);
  log("INFO", `已加入 ${tasks.length} 个采集任务，商品范围：${describeSalesFilter(salesFilter)}`);

  if (!state.running) {
    runQueue(config).catch((error) => {
      state.running = false;
      log("ERROR", `任务队列异常：${error.message}`);
    });
  }
  return tasks;
}

export function requestStop() {
  state.stopRequested = true;
  log("WARN", "已请求停止，当前任务会在安全点退出");
}

export async function retryTask(taskId, config) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error("任务不存在");
  updateTask(taskId, {
    status: "queued",
    step: "等待重试",
    productCount: 0,
    sourceProductCount: 0,
    writtenCount: 0,
    error: "",
    finishedAt: "",
  });
  if (!state.running) {
    runQueue(config).catch((error) => log("ERROR", `任务队列异常：${error.message}`));
  }
}

export function skipTask(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error("任务不存在");
  if (task.status !== "queued") throw new Error("只能跳过等待中的任务");
  updateTask(taskId, { status: "stopped", step: "已跳过", finishedAt: new Date().toISOString() });
  log("WARN", `已跳过任务：${task.url}`, { taskId });
}

async function runQueue(config) {
  state.running = true;
  state.stopRequested = false;

  while (!state.stopRequested) {
    const task = state.tasks.find((item) => item.status === "queued");
    if (!task) break;
    state.currentTaskId = task.id;
    await runOneTask(task, config);
  }

  if (state.stopRequested) {
    for (const task of state.tasks.filter((item) => item.status === "queued")) {
      updateTask(task.id, { status: "stopped", step: "用户停止", finishedAt: new Date().toISOString() });
    }
  }

  state.running = false;
  state.currentTaskId = null;
  state.stopRequested = false;
  log("INFO", "任务队列已结束");
}

async function runOneTask(task, config) {
  const salesFilter = normalizeSalesFilter(task.salesFilter);
  updateTask(task.id, {
    status: "running",
    step: config.collector?.dryRun ? "启动模拟采集" : "公开模式准备采集",
    startedAt: new Date().toISOString(),
    error: "",
  });
  log("INFO", `开始任务：${task.url}，商品范围：${describeSalesFilter(salesFilter)}`, { taskId: task.id });

  try {
    let result;
    if (config.collector.dryRun) {
      result = await mockCollect(task.url, task.id, salesFilter);
    } else {
      result = await collectCreatorProducts(task.url, config, {
        shouldStop: () => state.stopRequested,
        onCreator: (creator) => {
          updateTask(task.id, { creatorName: creator.name });
        },
        onStep: (step) => {
          updateTask(task.id, { step });
          log("INFO", step, { taskId: task.id });
        },
        onProgress: (products, round) => {
          const filteredProducts = filterProductsBySales(products, salesFilter);
          updateTask(task.id, {
            sourceProductCount: products.length,
            productCount: filteredProducts.length,
            step: salesFilter.enabled
              ? `已发现 ${products.length} 个，符合筛选 ${filteredProducts.length} 个（第 ${round} 页/轮）`
              : `已采集商品 ${products.length} 个（第 ${round} 页/轮）`,
          });
          setProductsPreview(filteredProducts, task.id);
        },
        onDiagnostic: (diagnostic) => {
          log("WARN", `未解析到商品：${diagnostic.reason}。诊断文件：${diagnostic.debugDir}`, { taskId: task.id });
        },
      });
    }

    const sourceProducts = result.products;
    const filteredProducts = filterProductsBySales(sourceProducts, salesFilter);
    result = { ...result, products: filteredProducts };

    if (state.stopRequested) {
      updateTask(task.id, { status: "stopped", step: "用户停止", finishedAt: new Date().toISOString() });
      return;
    }

    updateTask(task.id, {
      creatorName: result.creator.name,
      sourceProductCount: sourceProducts.length,
      productCount: result.products.length,
      step: salesFilter.enabled && result.products.length === 0
        ? "筛选后无商品，未写入"
        : result.products.length === 0 && !result.safeToOverwriteEmpty
          ? "未发现可写入商品"
          : "写入飞书多维表格",
    });
    setProductsPreview(result.products, task.id);

    if (salesFilter.enabled && result.products.length === 0) {
      updateTask(task.id, {
        status: "done",
        step: "筛选后无商品，未写入",
        writtenCount: 0,
        finishedAt: new Date().toISOString(),
      });
      log("WARN", `任务完成：${result.creator.name} 共发现 ${sourceProducts.length} 个商品，没有商品符合“${describeSalesFilter(salesFilter)}”，已跳过写入`, {
        taskId: task.id,
      });
      return;
    }

    if (result.products.length === 0 && !result.safeToOverwriteEmpty) {
      updateTask(task.id, {
        status: "done",
        step: "无店铺商品，未写入",
        writtenCount: 0,
        finishedAt: new Date().toISOString(),
      });
      log("WARN", `任务完成：${result.creator.name} 没有可确认的店铺商品，已跳过覆盖写入，避免误删旧记录`, {
        taskId: task.id,
      });
      return;
    }

    const writeResult = await writeProductsForCreator(config, result.creator, result.products, {
      dryRun: config.collector.dryRun,
      mode: task.writeMode || (task.overwrite ? "overwrite" : "append"),
    });

    updateTask(task.id, {
      status: "done",
      step: writeResult.skipped ? "已有记录，已跳过写入" : writeResult.dryRun ? "模拟写入完成" : "写入完成",
      writtenCount: writeResult.written,
      finishedAt: new Date().toISOString(),
    });
    log("INFO", `任务完成：${result.creator.name}，商品 ${result.products.length} 个，写入 ${writeResult.written} 条${writeResult.skipped ? "，已有记录已跳过" : ""}`, {
      taskId: task.id,
    });
  } catch (error) {
    if (/飞书用户授权已失效|重新授权飞书/.test(error.message)) {
      setConnection("feishu", "error", "用户授权已失效，请在连接配置中重新授权");
    }
    updateTask(task.id, {
      status: "failed",
      step: "执行失败",
      error: error.message,
      finishedAt: new Date().toISOString(),
    });
    log("ERROR", `任务失败：${error.message}`, { taskId: task.id });
  }
}

async function mockCollect(url, taskId, salesFilter) {
  const creator = {
    name: mockCreatorName(url),
    url,
    shopUrl: /\/shop\//.test(url) ? url.split(/[?#]/)[0] : "",
  };
  updateTask(taskId, { creatorName: creator.name, step: "模拟打开博主主页" });
  const products = [];
  const samples = [
    ["原创设计感肌理感衬衫女春季新款宽松百搭", "2,389", "¥129"],
    ["日系简约通勤单肩包大容量托特包", "1,560", "¥199"],
    ["法式复古高腰显瘦牛仔裤女直筒裤", "3,124", "¥159"],
    ["清新碎花连衣裙女夏季新款收腰长裙", "2,015", "¥189"],
    ["冰丝防晒开衫女夏季薄款外套", "1,782", "¥79"],
  ];
  for (let index = 0; index < samples.length; index += 1) {
    await delay(350);
    const [title, sales, price] = samples[index];
    products.push({
      title,
      sales: Number(sales.replace(/,/g, "")),
      price,
      url: `https://www.xiaohongshu.com/goods/mock-${index + 1}`,
      collectedAt: new Date().toISOString(),
    });
    const filteredProducts = filterProductsBySales(products, salesFilter);
    updateTask(taskId, {
      sourceProductCount: products.length,
      productCount: filteredProducts.length,
      step: salesFilter.enabled
        ? `模拟提取 ${products.length}/${samples.length}，符合筛选 ${filteredProducts.length} 个`
        : `模拟提取商品 ${products.length}/${samples.length}`,
    });
    setProductsPreview(filteredProducts, taskId);
  }
  return { creator, products };
}

function normalizeUrls(urls) {
  const input = Array.isArray(urls) ? urls.join("\n") : String(urls || "");
  const supportedHosts = /(?:xiaohongshu\.com|xhslink\.com)/;
  return Array.from(
    new Set(
      input
        .split(/\n|,|\s+/)
        .map((url) => url.trim())
        .filter(Boolean)
        .filter((url) => {
          try {
            const parsed = new URL(url);
            return /^https?:$/.test(parsed.protocol) && supportedHosts.test(parsed.hostname);
          } catch {
            return false;
          }
        })
    )
  );
}

function normalizeWriteMode(mode, overwrite) {
  if (["overwrite", "skip", "append"].includes(mode)) return mode;
  return overwrite === false ? "append" : "overwrite";
}

export function normalizeSalesFilter(value) {
  const enabled = Boolean(value?.enabled);
  const numericValue = Number(value?.minSales);
  const minSales = Number.isFinite(numericValue) ? Math.max(0, Math.floor(numericValue)) : 0;
  return { enabled, minSales };
}

export function filterProductsBySales(products, salesFilter) {
  const normalized = normalizeSalesFilter(salesFilter);
  if (!normalized.enabled) return products.slice();
  return products.filter((product) => Number(product.sales) > normalized.minSales);
}

function describeSalesFilter(salesFilter) {
  const normalized = normalizeSalesFilter(salesFilter);
  return normalized.enabled ? `销量 > ${normalized.minSales}` : "全部商品";
}

function mockCreatorName(url) {
  const tail = url.split("/").filter(Boolean).pop() || "demo";
  return `小红书博主 ${tail.slice(0, 8)}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

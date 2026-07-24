import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const larkCliRunner = "/usr/local/lib/node_modules/@larksuite/cli/scripts/run.js";
const requiredFeishuScopes = [
  "base:field:read",
  "base:record:read",
  "base:record:create",
  "base:record:update",
  "base:record:delete",
].join(" ");

let activeAuthorization = null;

export async function startFeishuUserAuthorization(callbacks = {}) {
  if (activeAuthorization) {
    return {
      verificationUrl: activeAuthorization.verificationUrl,
      expiresIn: activeAuthorization.expiresIn,
      pending: true,
    };
  }

  let started;
  try {
    const result = await runLarkCommand([
      "auth",
      "login",
      "--scope",
      requiredFeishuScopes,
      "--no-wait",
      "--json",
    ], { timeout: 30000 });
    started = parseJson(result.stdout);
  } catch (error) {
    throw new Error(explainAuthError(error));
  }

  if (!started.device_code || !started.verification_url) {
    throw new Error("飞书没有返回有效的授权链接，请稍后重试");
  }

  const authorization = {
    verificationUrl: started.verification_url,
    expiresIn: Number(started.expires_in) || 600,
  };
  activeAuthorization = authorization;

  void (async () => {
    try {
      await runLarkCommand([
        "auth",
        "login",
        "--device-code",
        started.device_code,
        "--json",
      ], { timeout: (authorization.expiresIn + 30) * 1000 });
      await callbacks.onComplete?.();
    } catch (error) {
      await callbacks.onError?.(new Error(explainAuthError(error)));
    } finally {
      if (activeAuthorization === authorization) activeAuthorization = null;
    }
  })();

  return { ...authorization, pending: true };
}

export async function testFeishuConnection(config) {
  ensureFeishuConfig(config);
  const fields = await listFields(config);
  const names = fields.map((field) => field.field_name || field.name || field.id).filter(Boolean);
  const missing = Object.values(config.feishu.fieldMap).filter((name) => !names.includes(name));
  return {
    ok: missing.length === 0,
    fieldCount: fields.length,
    missing,
    fields: names,
  };
}

export async function writeProductsForCreator(config, creator, products, options = {}) {
  const mode = normalizeWriteMode(options.mode);
  if (options.dryRun) {
    return { deleted: 0, written: products.length, dryRun: true, mode };
  }
  ensureFeishuConfig(config);

  const existing = await listAllRecords(config);
  const creatorField = config.feishu.fieldMap.creatorUrl;
  const creatorUrls = new Set([creator.url, ...(creator.aliasUrls || [])].map(normalizeCell).filter(Boolean));
  const toDelete = existing.filter((record) => {
    const fields = record.fields || record.record?.fields || {};
    return creatorUrls.has(normalizeCell(fields[creatorField]));
  });

  if (mode === "skip" && toDelete.length) {
    return { deleted: 0, written: 0, skipped: true, dryRun: false, mode };
  }

  if (mode === "overwrite") {
    for (const record of toDelete) {
      const recordId = record.record_id || record.id || record.record?.record_id;
      if (!recordId) continue;
      await deleteRecord(config, recordId);
      await wait(250);
    }
  }

  let written = 0;
  for (const product of products) {
    await upsertRecord(config, productToRecord(config.feishu.fieldMap, creator, product));
    written += 1;
    await wait(250);
  }

  return { deleted: mode === "overwrite" ? toDelete.length : 0, written, dryRun: false, mode };
}

export async function listFields(config) {
  const result = await runLark([
    "base",
    "+field-list",
    "--base-token",
    config.feishu.baseToken,
    "--table-id",
    config.feishu.tableId,
    "--offset",
    "0",
    "--limit",
    "200",
  ], config);
  const data = parseJson(result.stdout);
  return data.items || data.fields || data.data?.items || data.data?.fields || data.field_list || [];
}

async function listAllRecords(config) {
  const records = [];
  let offset = 0;
  const limit = 200;

  while (true) {
    const args = [
      "base",
      "+record-list",
      "--base-token",
      config.feishu.baseToken,
      "--table-id",
      config.feishu.tableId,
      "--offset",
      String(offset),
      "--limit",
      String(limit),
    ];
    const result = await runLark(args, config);
    const data = parseJson(result.stdout);
    const batch = normalizeRecords(data);
    records.push(...batch);
    const total = data.total ?? data.data?.total;
    const hasMore = data.has_more ?? data.data?.has_more;
    if (!batch.length || batch.length < limit || hasMore === false || (Number.isFinite(total) && records.length >= total)) break;
    offset += limit;
  }

  return records;
}

async function deleteRecord(config, recordId) {
  await runLark([
    "base",
    "+record-delete",
    "--base-token",
    config.feishu.baseToken,
    "--table-id",
    config.feishu.tableId,
    "--record-id",
    recordId,
    "--yes",
  ], config);
}

async function upsertRecord(config, payload) {
  await runLark([
    "base",
    "+record-upsert",
    "--base-token",
    config.feishu.baseToken,
    "--table-id",
    config.feishu.tableId,
    "--json",
    JSON.stringify(payload),
  ], config);
}

export function productToRecord(fieldMap, creator, product) {
  return {
    [fieldMap.creatorName]: creator.name,
    [fieldMap.creatorUrl]: creator.url,
    [fieldMap.shopUrl]: resolveShopUrl(creator),
    [fieldMap.productTitle]: product.title,
    [fieldMap.sales]: normalizeSalesValue(product.sales),
    [fieldMap.price]: normalizePriceValue(product.price),
    [fieldMap.productUrl]: product.url,
    [fieldMap.collectedAt]: formatDateTime(product.collectedAt || new Date()),
  };
}

function resolveShopUrl(creator) {
  if (creator.shopUrl) return creator.shopUrl;
  if (String(creator.url || "").includes("/shop/")) return creator.url;
  return (creator.aliasUrls || []).find((url) => String(url || "").includes("/shop/")) || "";
}

function ensureFeishuConfig(config) {
  if (!config.feishu.baseToken || !config.feishu.tableId) {
    throw new Error("请先填写飞书 Base Token 和 Table ID");
  }
}

async function runLark(args, config) {
  try {
    const commandArgs = withIdentity(args, config);
    return await runLarkCommand(commandArgs, { timeout: 120000 });
  } catch (error) {
    throw new Error(explainLarkError(collectCommandError(error)));
  }
}

async function runLarkCommand(args, options = {}) {
  const command = existsSync(larkCliRunner) ? findNodeExecutable() : "lark-cli";
  const finalArgs = existsSync(larkCliRunner) ? [larkCliRunner, ...args] : args;
  return execFileAsync(command, finalArgs, {
    maxBuffer: 1024 * 1024 * 20,
    timeout: options.timeout || 120000,
  });
}

function findNodeExecutable() {
  const candidates = [
    process.env.XHS_COLLECTOR_NODE,
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || "node";
}

function withIdentity(args, config) {
  const identity = normalizeIdentity(config?.feishu?.identity);
  if (!identity || identity === "auto" || args.includes("--as")) return args;
  return [...args, "--as", identity];
}

function normalizeIdentity(value) {
  return ["auto", "bot", "user"].includes(value) ? value : "auto";
}

function normalizeWriteMode(value) {
  return ["overwrite", "skip", "append"].includes(value) ? value : "overwrite";
}

function parseJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(trimmed.slice(first, last + 1));
    }
    throw new Error(`无法解析 lark-cli 返回：${trimmed.slice(0, 500)}`);
  }
}

function normalizeRecords(payload) {
  const direct = payload.items || payload.records || payload.data?.items || payload.data?.records;
  if (Array.isArray(direct)) return direct;

  const table = payload.data || payload;
  if (!Array.isArray(table.data) || !Array.isArray(table.fields)) return [];

  return table.data.map((row, index) => {
    const fields = {};
    table.fields.forEach((fieldName, fieldIndex) => {
      fields[fieldName] = row[fieldIndex];
    });
    return {
      record_id: table.record_id_list?.[index],
      id: table.record_id_list?.[index],
      fields,
    };
  });
}

function normalizeCell(value) {
  if (Array.isArray(value)) return value.map(normalizeCell).join(",");
  if (value && typeof value === "object") {
    if ("text" in value) return normalizeCell(value.text);
    if ("link" in value) return normalizeCell(value.link);
    if ("url" in value) return normalizeCell(value.url);
    return JSON.stringify(value);
  }
  const text = String(value || "").trim();
  const markdownLink = text.match(/^\[[^\]]*]\(([^)]+)\)$/);
  return (markdownLink?.[1] || text).replace(/\/$/, "");
}

function normalizeSalesValue(value) {
  const parsed = parseSalesCount(value);
  return parsed ?? 0;
}

function parseSalesCount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  const text = String(value || "").trim().replace(/\s+/g, " ");
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

function normalizePriceValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value || "").trim();
  const match = text.match(/([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/);
  if (!match) return "";
  const number = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(number) ? number : "";
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function explainLarkError(value) {
  const sanitized = sanitizeLarkOutput(value);
  if (/need_user_authorization|token does not exist|re-login:\s*lark-cli auth login/i.test(sanitized)) {
    return "飞书用户授权已失效。请打开“连接配置”，点击“重新授权飞书”，完成授权后再重试任务。";
  }
  if (/91403|you don't have permission|permission/i.test(sanitized)) {
    return [
      "飞书多维表格写入权限不足：当前执行身份可以读取字段/记录，但不能创建、更新或删除记录。",
      "请在飞书开放平台为应用开通 base:record:create、base:record:update、base:record:delete，并确认应用或当前用户对该多维表格有可编辑权限。",
    ].join("\n");
  }
  return `lark-cli 执行失败：${sanitized}`;
}

function explainAuthError(error) {
  const value = collectCommandError(error);
  if (/timed out|timeout|expired|authorization_pending/i.test(value)) {
    return "飞书授权未完成或已超时，请重新点击“重新授权飞书”";
  }
  return explainLarkError(value);
}

function collectCommandError(error) {
  const stderr = error?.stderr ? `\n${error.stderr}` : "";
  const stdout = error?.stdout ? `\n${error.stdout}` : "";
  return `${error?.message || error}${stderr}${stdout}`;
}

function sanitizeLarkOutput(value) {
  return String(value)
    .replace(/--base-token\s+\S+/g, "--base-token [hidden]")
    .replace(/--table-id\s+\S+/g, "--table-id [hidden]")
    .replace(/--view-id\s+\S+/g, "--view-id [hidden]")
    .replace(/--json\s+\{[\s\S]*?\}(?=\n|$)/g, "--json [hidden]")
    .replace(/(base-token|baseToken)[=:]\s*["']?[\w-]+/gi, "$1=[hidden]")
    .replace(/cli_[a-z0-9]+/gi, "cli_[hidden]")
    .replace(/ou_[a-z0-9]+/gi, "ou_[hidden]")
    .replace(/tbl[a-z0-9]+/gi, "tbl_[hidden]")
    .slice(0, 2000);
}

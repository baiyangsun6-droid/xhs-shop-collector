import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.XHS_COLLECTOR_DATA_DIR || path.join(rootDir, "data"));
const configPath = path.join(dataDir, "config.json");

export const defaultFieldMap = {
  creatorName: "博主名字",
  creatorUrl: "博主主页链接",
  shopUrl: "店铺链接",
  productTitle: "商品标题",
  sales: "商品销量",
  price: "商品价格",
  productUrl: "商品链接",
  collectedAt: "采集时间",
};

export const defaultConfig = {
  feishu: {
    baseToken: "",
    tableId: "",
    viewId: "",
    identity: "auto",
    fieldMap: defaultFieldMap,
  },
  collector: {
    maxScrollRounds: 40,
    stableRounds: 5,
    dryRun: false,
    useBrowserFallback: false,
    requestDelayMs: 3000,
  },
};

export async function loadConfig() {
  try {
    const raw = await readFile(configPath, "utf8");
    return mergeConfig(JSON.parse(raw));
  } catch {
    return defaultConfig;
  }
}

export async function saveConfig(nextConfig) {
  const merged = mergeConfig(nextConfig);
  await mkdir(dataDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

function mergeConfig(value) {
  return {
    ...defaultConfig,
    ...value,
    feishu: {
      ...defaultConfig.feishu,
      ...(value?.feishu || {}),
      fieldMap: {
        ...defaultFieldMap,
        ...(value?.feishu?.fieldMap || {}),
      },
    },
    collector: {
      ...defaultConfig.collector,
      ...(value?.collector || {}),
    },
  };
}

export { rootDir, dataDir, configPath };

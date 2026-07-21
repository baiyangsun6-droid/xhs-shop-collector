import { randomUUID } from "node:crypto";
import { emitEvent } from "./events.mjs";

export const state = {
  service: {
    startedAt: new Date().toISOString(),
    version: "0.1.0",
  },
  connections: {
    feishu: { status: "unknown", message: "未测试" },
    xhs: { status: "unknown", message: "未检查" },
    browser: { status: "idle", message: "未打开" },
  },
  tasks: [],
  selectedTaskId: null,
  currentTaskId: null,
  logs: [],
  productsPreview: [],
  productsPreviewTaskId: null,
  running: false,
  stopRequested: false,
};

export function snapshot(config) {
  return {
    ...state,
    config: sanitizeConfig(config),
  };
}

export function sanitizeConfig(config) {
  return {
    ...config,
    feishu: {
      ...config.feishu,
      baseToken: config.feishu.baseToken,
      tableId: config.feishu.tableId,
      viewId: config.feishu.viewId,
    },
  };
}

export function log(level, message, meta = {}) {
  const entry = {
    id: randomUUID(),
    time: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  state.logs.unshift(entry);
  state.logs = state.logs.slice(0, 300);
  emitEvent("log", entry);
  emitState();
  return entry;
}

export function setConnection(name, status, message) {
  state.connections[name] = {
    status,
    message,
    updatedAt: new Date().toISOString(),
  };
  emitState();
}

export function setProductsPreview(products, taskId = null) {
  state.productsPreview = products.slice(0, 12);
  state.productsPreviewTaskId = taskId;
  emitState();
}

export function createTasks(urls, writeMode = "overwrite", salesFilter = { enabled: false, minSales: 0 }) {
  const now = new Date().toISOString();
  const tasks = urls.map((url, index) => ({
    id: randomUUID(),
    row: state.tasks.length + index + 1,
    url,
    creatorName: "",
    status: "queued",
    step: "等待开始",
    productCount: 0,
    sourceProductCount: 0,
    writtenCount: 0,
    startedAt: "",
    finishedAt: "",
    error: "",
    writeMode,
    overwrite: writeMode === "overwrite",
    salesFilter: { ...salesFilter },
    createdAt: now,
  }));
  state.tasks.unshift(...tasks);
  state.selectedTaskId = tasks[0]?.id || state.selectedTaskId;
  emitState();
  return tasks;
}

export function updateTask(id, patch) {
  const index = state.tasks.findIndex((task) => task.id === id);
  if (index === -1) return null;
  state.tasks[index] = { ...state.tasks[index], ...patch };
  if (!state.selectedTaskId) state.selectedTaskId = id;
  emitEvent("task", state.tasks[index]);
  emitState();
  return state.tasks[index];
}

export function selectTask(id) {
  if (state.tasks.some((task) => task.id === id)) {
    state.selectedTaskId = id;
    emitState();
  }
}

export function deleteLocalTasks(ids) {
  const requestedIds = new Set((Array.isArray(ids) ? ids : []).filter(Boolean));
  const matchingTasks = state.tasks.filter((task) => requestedIds.has(task.id));
  if (!matchingTasks.length) return { deleted: 0 };

  const activeTask = matchingTasks.find((task) => task.status === "running" || task.id === state.currentTaskId);
  if (activeTask) {
    throw new Error("正在采集的任务不能删除，请先停止任务");
  }

  const deletedIds = new Set(matchingTasks.map((task) => task.id));
  state.tasks = state.tasks.filter((task) => !deletedIds.has(task.id));
  state.logs = state.logs.filter((entry) => !deletedIds.has(entry.taskId));

  if (deletedIds.has(state.selectedTaskId)) {
    state.selectedTaskId = state.tasks[0]?.id || null;
  }
  if (deletedIds.has(state.productsPreviewTaskId)) {
    state.productsPreview = [];
    state.productsPreviewTaskId = null;
  }

  emitState();
  return { deleted: deletedIds.size };
}

export function emitState() {
  emitEvent("state", state);
}

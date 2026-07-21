import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addEventClient } from "./events.mjs";
import { loadConfig, saveConfig } from "./config.mjs";
import { enqueueAndRun, openLogin, requestStop, retryTask, skipTask, testFeishu } from "./runner.mjs";
import { deleteLocalTasks, emitState, selectTask, snapshot, state } from "./state.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const publicDir = existsSync(distDir) ? distDir : rootDir;

let config = await loadConfig();
let server = null;

export async function startServer(options = {}) {
  if (server?.listening) {
    const address = server.address();
    const activePort = typeof address === "object" && address ? address.port : 0;
    return { server, port: activePort, url: `http://127.0.0.1:${activePort}` };
  }

  const port = options.port ?? Number(process.env.API_PORT || process.env.PORT || 3456);
  const host = options.host || "127.0.0.1";
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === "/api/events") return addEventClient(res);
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      return serveStatic(res, url.pathname);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${activePort}`;
  console.log(`API server listening on ${url}`);
  return { server, port: activePort, url };
}

export async function stopServer() {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server = null;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, snapshot(config));
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    return sendJson(res, 200, config);
  }

  if (req.method === "POST" && url.pathname === "/api/config") {
    config = await saveConfig(await readJson(req));
    return sendJson(res, 200, config);
  }

  if (req.method === "POST" && url.pathname === "/api/feishu/test") {
    return sendJson(res, 200, await testFeishu(config));
  }

  if (req.method === "POST" && url.pathname === "/api/xhs/login") {
    return sendJson(res, 200, await openLogin());
  }

  if (req.method === "POST" && url.pathname === "/api/tasks/start") {
    const body = await readJson(req);
    const tasks = await enqueueAndRun(body.urls || body.text || "", config, {
      mode: body.mode,
      overwrite: body.overwrite,
      salesFilter: body.salesFilter,
    });
    return sendJson(res, 200, { tasks });
  }

  if (req.method === "POST" && url.pathname === "/api/tasks/stop") {
    requestStop();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "DELETE" && url.pathname === "/api/tasks") {
    const body = await readJson(req);
    return sendJson(res, 200, deleteLocalTasks(body.ids));
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/retry")) {
    const taskId = url.pathname.split("/")[3];
    await retryTask(taskId, config);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/skip")) {
    const taskId = url.pathname.split("/")[3];
    skipTask(taskId);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/select")) {
    const taskId = url.pathname.split("/")[3];
    selectTask(taskId);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/logs/clear") {
    state.logs.length = 0;
    emitState();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "Not found" });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(payload));
}

async function serveStatic(res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(publicDir, cleanPath);
  const fallback = path.join(publicDir, "index.html");
  const target = existsSync(filePath) && !filePath.endsWith(path.sep) ? filePath : fallback;
  if (!existsSync(target)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType(target) });
  createReadStream(target).pipe(res);
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) await startServer();

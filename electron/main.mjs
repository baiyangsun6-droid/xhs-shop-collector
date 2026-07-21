import { access, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, Menu, shell } from "electron";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appName = "小红书商品采集器";

app.setName(appName);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow = null;
let stopEmbeddedServer = null;

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(launchDesktopApp).catch((error) => {
  dialog.showErrorBox("应用启动失败", error?.stack || error?.message || String(error));
  app.quit();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  void stopEmbeddedServer?.();
});

async function launchDesktopApp() {
  installApplicationMenu();

  const dataDir = path.join(app.getPath("userData"), "data");
  await mkdir(dataDir, { recursive: true });
  await migrateLegacyConfig(dataDir);
  process.env.XHS_COLLECTOR_DATA_DIR = dataDir;

  const serverModule = await import("../server/index.mjs");
  const serverResult = await serverModule.startServer({ port: 0 });
  stopEmbeddedServer = serverModule.stopServer;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    backgroundColor: "#f7f8fa",
    title: appName,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const appOrigin = new URL(serverResult.url).origin;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin !== appOrigin) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin === appOrigin) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(serverResult.url);
}

async function migrateLegacyConfig(dataDir) {
  const target = path.join(dataDir, "config.json");
  if (await fileExists(target)) return;

  const legacy = path.join(appRoot, "data", "config.json");
  if (!(await fileExists(legacy))) return;
  await copyFile(legacy, target);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function installApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: appName,
      submenu: [
        { role: "about", label: `关于${appName}` },
        { type: "separator" },
        { role: "hide", label: `隐藏${appName}` },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "全部显示" },
        { type: "separator" },
        { role: "quit", label: `退出${appName}` },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        { role: "front", label: "前置全部窗口" },
      ],
    },
  ]));
}

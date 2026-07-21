import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.mjs";
import { enqueueAndRun, openLogin } from "./runner.mjs";
import { state } from "./state.mjs";

const command = process.argv[2];
const config = await loadConfig();

if (command === "login") {
  await openLogin();
  console.log("已打开小红书手动浏览器。默认采集不会使用这份登录态。");
} else if (command === "collect") {
  const url = process.argv[3];
  if (!url) fail("用法：npm run collect -- \"https://www.xiaohongshu.com/user/profile/...\"");
  await enqueueAndRun(url, config, { overwrite: true });
  await waitForDone();
} else if (command === "collect-batch") {
  const filePath = process.argv[3];
  if (!filePath) fail("用法：npm run collect:batch -- urls.txt");
  const text = await readFile(filePath, "utf8");
  await enqueueAndRun(text, config, { overwrite: true });
  await waitForDone();
} else {
  fail("可用命令：login、collect、collect-batch");
}

async function waitForDone() {
  while (state.running || state.tasks.some((task) => task.status === "queued" || task.status === "running")) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const done = state.tasks.filter((task) => task.status === "done").length;
  const failed = state.tasks.filter((task) => task.status === "failed").length;
  console.log(`采集结束：成功 ${done}，失败 ${failed}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

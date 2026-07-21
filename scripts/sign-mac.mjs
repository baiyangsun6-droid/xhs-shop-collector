import path from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const appPath = path.join(rootDir, "release", "mac-arm64", "小红书商品采集器.app");

run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
run("codesign", ["--verify", "--deep", "--strict", appPath]);
console.log(`Signed ${appPath}`);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: rootDir, encoding: "utf8" });
  if (result.status === 0) return;
  throw new Error(`${command} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
}

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const buildDir = path.join(rootDir, "build");
const sourceSvg = path.join(buildDir, "app-icon.svg");
const sourcePng = `${sourceSvg}.png`;
const iconsetDir = path.join(buildDir, "app-icon.iconset");
const targetIcns = path.join(buildDir, "app-icon.icns");

await mkdir(buildDir, { recursive: true });
await rm(sourcePng, { force: true });
await rm(iconsetDir, { recursive: true, force: true });
await rm(targetIcns, { force: true });

run("qlmanage", ["-t", "-s", "1024", "-o", buildDir, sourceSvg]);
await mkdir(iconsetDir, { recursive: true });

const sizes = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];

for (const [size, fileName] of sizes) {
  run("sips", ["-z", String(size), String(size), sourcePng, "--out", path.join(iconsetDir, fileName)]);
}

run("iconutil", ["-c", "icns", iconsetDir, "-o", targetIcns]);
console.log(`Generated ${targetIcns}`);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: rootDir, encoding: "utf8" });
  if (result.status === 0) return;
  throw new Error(`${command} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
}

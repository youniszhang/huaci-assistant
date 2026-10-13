import { build } from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const base = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: false,
  external: ["electron"],
  logLevel: "info",
};

const targets = [
  {
    entryPoints: ["src/main/main.ts"],
    outfile: "dist/main/main.js",
  },
];

/** 递归拷贝目录（renderer 下有 assets/ 子目录，不能只拷顶层文件） */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

/** 把静态资源（preload / renderer / shared）拷进 dist，保证运行时相对路径一致 */
function copyStatic() {
  const jobs = [
    ["src/preload", "dist/preload"],
    ["src/renderer", "dist/renderer"],
    ["src/shared", "dist/shared"],
  ];
  for (const [from, to] of jobs) {
    copyDir(from, to);
  }
  console.log("[copy] preload / renderer / shared → dist/");
}

async function run() {
  for (const t of targets) {
    await build({ ...base, ...t });
  }
  copyStatic();
}

if (watch) {
  const { context } = await import("esbuild");
  const ctxs = [];
  for (const t of targets) {
    ctxs.push(await context({ ...base, ...t }));
  }
  await Promise.all(ctxs.map((c) => c.watch()));
  copyStatic();
  // 简单的静态资源监听（每 2s 比对 mtime）
  const snap = new Map();
  setInterval(() => {
    let dirty = false;
    for (const [from] of [
      ["src/preload", "dist/preload"],
      ["src/renderer", "dist/renderer"],
      ["src/shared", "dist/shared"],
    ]) {
      for (const f of fs.readdirSync(from)) {
        const full = path.join(from, f);
        const m = fs.statSync(full).mtimeMs;
        if (snap.get(full) !== m) {
          snap.set(full, m);
          dirty = true;
        }
      }
    }
    if (dirty) copyStatic();
  }, 2000);
  console.log("[esbuild] watching...");
} else {
  await run();
  console.log("[esbuild] build done");
}

#!/usr/bin/env node
/**
 * 测试用 mock SelectionHelper：实现 JSON-lines 协议子集。
 * 通过控制文件 /tmp/huaci-mock-ctrl 注入事件，模拟真实用户操作。
 */
const fs = require("fs");
const readline = require("readline");

const CTRL = process.env.MOCK_CTRL || "/tmp/huaci-mock-ctrl";
const args = process.argv.slice(2);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// 权限探测路径（capture.ts probePermissions 用一次性进程）
if (args.includes("--check-permissions")) {
  emit({ type: "perms", accessibilityTrusted: true, inputMonitoring: true, screenRecording: true });
  process.exit(0);
}

// 启动即就绪（忽略 --ignore-pid / --request-permissions 参数）
emit({ type: "ready", accessibilityTrusted: true, inputMonitoring: true, screenRecording: true, pid: process.pid });

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "quit") process.exit(0);
  if (msg.type === "region-select") {
    emit({ type: "region-begin" });
    setTimeout(() => emit({ type: "region-update", x: 600, y: 320, w: 420, h: 240 }), 120);
    setTimeout(() => emit({ type: "region", x: 600, y: 320, w: 420, h: 240 }), 260);
  }
  if (msg.type === "region-abort") emit({ type: "region-cancel" });
  if (msg.type === "ocr") {
    // 延迟 2.5s 回包：留出「卡片识别中」阶段供断言
    setTimeout(() => {
      emit({
        type: "ocr",
        payload: JSON.stringify({
          ok: true,
          text: "OCR 测试文本：这是一段模拟识别结果",
          count: 1,
          durationMs: 123,
          lines: [],
        }),
      });
    }, 2500);
  }
});
rl.on("close", () => process.exit(0));

// 控制文件轮询：注入鼠标/选区事件
setInterval(() => {
  let data = "";
  try { data = fs.readFileSync(CTRL, "utf8"); } catch { return; }
  if (!data.trim()) return;
  try { fs.writeFileSync(CTRL, ""); } catch { return; }
  for (const line of data.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t === "cleared") emit({ type: "cleared" });
    else if (t === "noselection") emit({ type: "selection", ok: false, reason: "no-selection" });
    else if (t.startsWith("selection ")) {
      emit({ type: "selection", ok: true, text: t.slice(10), x: 640, y: 360, h: 18, app: "MockApp" });
    } else if (t.startsWith("click ")) {
      const [x, y] = t.slice(6).split(" ").map(Number);
      emit({ type: "click", x, y });
    }
  }
}, 150);

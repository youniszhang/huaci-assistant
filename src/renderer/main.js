/**
 * 主窗口逻辑：状态 / 供应商 / 动作 / 划词记录 / 关于
 */
(function () {
  const api = window.huaci;
  const Icons = window.HuaciIcons;
  if (!api) return;

  const $ = (id) => document.getElementById(id);
  let settings = null;
  let providers = [];
  let activeId = "";
  let vaultPath = "";
  let actions = [];

  // ------------------------------------------------ 工具

  function toast(msg, ms) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add("hidden"), ms || 2200);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function icon(name, cls) {
    return Icons ? Icons.icon(name, cls || "ic ic-sm") : "";
  }

  function shortPath(p) {
    return String(p || "").replace(/^\/Users\/[^/]+/, "~");
  }

  /** 设置行的状态显示（文字 + 颜色） */
  function setRowValue(id, text, level) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = "row-value" + (level ? " " + level : "");
  }

  /** 设置行的图标状态 */
  function setRowIcon(id, name, level) {
    const el = $(id);
    if (!el || !Icons) return;
    el.className = "row-icon" + (level ? " " + level : "");
    el.innerHTML = Icons.icon(name, "ic ic-sm");
  }

  Icons && Icons.hydrate();


  // 导航
  $("nav").addEventListener("click", (e) => {
    const btn = e.target.closest(".nav-item");
    if (!btn) return;
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b === btn));
    document
      .querySelectorAll(".page")
      .forEach((p) => p.classList.toggle("active", p.id === "page-" + btn.dataset.page));
    if (btn.dataset.page === "notes") loadNotes();
    if (btn.dataset.page === "providers") loadProviders();
    if (btn.dataset.page === "history") loadHistory();
  });

  // ------------------------------------------------ 状态页

  async function loadStatus() {
    const [status, prov, vaults] = await Promise.all([
      api.getCaptureStatus(),
      api.getProviders(),
      api.listVaults(),
    ]);

    // 主横幅
    const running = !!status.enabled;
    const ok = running && status.available;
    $("heroPulse").className = "hero-pulse" + (ok ? "" : running ? " warn" : " off");
    $("heroTitle").textContent = ok ? "划词监听已开启" : running ? "划词监听异常" : "划词监听已关闭";
    // 提示按实际触发方式说明（自动弹 / 快捷键），避免文案与实际行为不符
    const autoPop = !!(settings && settings.autoPopup);
    const hkCapture = (settings && settings.hotkeyCapture) || "";
    $("heroSub").textContent = ok
      ? autoPop
        ? "在任意应用选中文字，工具条会自动浮出"
        : hkCapture
        ? `选中文字后按 ${prettyAccel(hkCapture)} 唤起工具条`
        : "未设置取词快捷键——请到「偏好」里设置，或开启「划词后自动弹出」"
      : running
      ? "未找到 SelectionHelper 可执行文件"
      : "点击右侧开关重新开启";
    $("toggleCapture").checked = running;

    // 运行环境
    setRowValue("stCapture", status.available ? "正常" : "不可用", status.available ? "ok" : "bad");
    $("stCaptureHint").textContent = status.available
      ? `Swift 助手运行中 · ${status.accessibilityTrusted ? "AX" : ""}${status.inputMonitoring ? " + 事件" : ""}`
      : "缺少 bin/SelectionHelper";

    setRowValue("stPerm", status.accessibilityTrusted ? "已授权" : "未授权",
      status.accessibilityTrusted ? "ok" : "bad");
    setRowIcon("rowIconPerm", status.accessibilityTrusted ? "check" : "close",
      status.accessibilityTrusted ? "ok" : "bad");

    setRowValue("stInputMon", status.inputMonitoring ? "已授权" : "未授权",
      status.inputMonitoring ? "ok" : "warn");
    setRowIcon("rowIconInput", status.inputMonitoring ? "marker" : "marker",
      status.inputMonitoring ? "ok" : "");

    setRowValue("stScreenRec", status.screenRecording ? "已授权" : "未授权",
      status.screenRecording ? "ok" : "warn");

    // 供应商
    const active = (prov.providers || []).find((p) => p.id === prov.activeId);
    $("stProvider").textContent = active ? active.name : "未找到供应商";
    $("stProviderHint").textContent = active
      ? (active.ptype === "dsweb" ? "DeepSeek 网页版 · " : "OpenAI 兼容 API · ") +
        (prov.activeModel || active.models?.[0] || "")
      : "请在 Obsidian 的 ai-explainer 插件里添加供应商";

    // 笔记库
    const v = vaults.active;
    $("stVault").textContent = v ? v.name : "未找到";
    $("stVaultHint").textContent = v ? shortPath(v.path) : "未检测到装有 ai-explainer 的 vault";
    vaultPath = v ? v.path : "";

    $("brandSub").textContent = active ? active.name : "未连接";
    $("aboutEnv").textContent =
      `划词进程 ${status.helperPath ? "就绪" : "缺失"} · 笔记库 ${vaultPath ? shortPath(vaultPath) : "未设置"}`;
  }

  $("toggleCapture").addEventListener("change", async (e) => {
    const res = await api.toggleCapture(e.target.checked);
    toast(res.enabled ? "已开启划词监听" : "已停止划词监听");
    loadStatus();
  });

  $("btnCaptureNow").addEventListener("click", async () => {
    await api.requestCapture();
    toast("已请求取词，请在 1 秒内完成划选");
  });

  $("btnScanNow").addEventListener("click", async () => {
    toast("请拖拽框选要分析的区域", 3000);
    await api.scanRegion();
  });

  $("btnPerm").addEventListener("click", () => api.openAccessibilitySettings());
  $("btnInputMon").addEventListener("click", () => api.openInputMonitoringSettings());
  $("btnScreenRec").addEventListener("click", () => api.openScreenRecordingSettings());

  $("btnTestProvider").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "测试中…";
    const prov = await api.getProviders();
    const res = await api.testProvider({ id: prov.activeId });
    btn.disabled = false;
    btn.textContent = "测试连通";
    toast(res.ok ? res.message : "失败：" + res.message, 4500);
  });

  $("btnPickVault").addEventListener("click", async () => {
    const res = await api.pickVault();
    if (res.ok) {
      toast("已选择：" + shortPath(res.path));
      loadStatus();
    }
  });

  // 关于页：项目主页
  $("aboutGithub").addEventListener("click", () => {
    api.openExternal("https://github.com/youniszhang/huaci-assistant");
  });

  $("btnOpenDir").addEventListener("click", () => {
    if (!vaultPath) return toast("未设置 vault");
    const dir = (settings && settings.captureDir) || "04-日常记录/AI划词解释";
    api.openExternal("file://" + vaultPath + "/" + dir);
  });

  $("inAutoPopup").addEventListener("change", saveSimple);
  $("inHeadless").addEventListener("change", saveSimple);

  async function saveSimple() {
    settings.autoPopup = $("inAutoPopup").checked;
    settings.dswebHeadless = $("inHeadless").checked;
    await api.saveSettings(settings);
    toast("已保存");
  }

  // ------------------------------------------------ 快捷键录制（按键即设置）
  //
  // 不用输入框手写 "CommandOrControl+Shift+E"（普通用户不会）：
  // 点按钮进入录制态 → 直接按组合键 → 转成 Electron accelerator 存盘。
  // 保存后主进程回传注册结果，被占用时按钮标红提示。

  /** 是否 macOS（显示 ⌘⌥⌃⇧ 符号，与系统习惯一致） */
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || "") || /Mac/.test(navigator.userAgent);

  /** 浏览器 KeyboardEvent → Electron accelerator 片段 */
  const MOD_KEYS = {
    Meta: "Command",
    Control: "Control",
    Alt: "Alt",
    Shift: "Shift",
  };

  /** 主键名映射（浏览器 key → accelerator 名） */
  function mainKeyName(e) {
    const k = e.key;
    if (!k) return "";
    if (k === " ") return "Space";
    if (k === "Escape" || k === "Enter" || k === "Tab" || k === "Backspace" || k === "Delete") return k;
    if (k === "ArrowUp") return "Up";
    if (k === "ArrowDown") return "Down";
    if (k === "ArrowLeft") return "Left";
    if (k === "ArrowRight") return "Right";
    if (/^[a-z]$/i.test(k)) return k.toUpperCase();
    if (/^[0-9]$/.test(k)) return k;
    if (/^F\d{1,2}$/.test(k)) return k;
    // 标点等单字符：Electron 要求用 keycode 名，常见的映射几个
    const PUNCT = { "`": "`", "-": "-", "=": "=", "[": "[", "]": "]", "\\": "\\", ";": ";", "'": "'", ",": ",", ".": ".", "/": "/" };
    if (PUNCT[k]) return PUNCT[k];
    return "";
  }

  /** 把按下的键转成 accelerator（至少一个修饰键 + 主键，或 F1-F20 单键） */
  function toAccelerator(e) {
    const mods = [];
    if (e.metaKey) mods.push("Command");
    if (e.ctrlKey) mods.push("Control");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    const key = mainKeyName(e);
    if (!key) return null;
    // 纯修饰键按下（还没按主键）→ 不完整，继续等待
    if (Object.keys(MOD_KEYS).includes(e.key)) return null;
    // 只按 F1-F20 可以无修饰键；其它键必须有修饰键（否则会吃掉日常输入）
    const isFn = /^F\d{1,2}$/.test(key);
    if (!mods.length && !isFn) return null;
    // Electron accelerator 顺序：修饰键在前，主键在后
    return [...mods, key].join("+");
  }

  /** accelerator → 显示文案（macOS 用符号） */
  function prettyAccel(acc) {
    if (!acc) return "未设置";
    if (!isMac) {
      return acc.replace(/CommandOrControl|Command|Cmd/g, "Ctrl").replace(/\+/g, " + ");
    }
    return acc
      .replace(/CommandOrControl|Command|Cmd/g, "⌘")
      .replace(/Control|Ctrl/g, "⌃")
      .replace(/Alt|Option/g, "⌥")
      .replace(/Shift/g, "⇧")
      .replace(/\+/g, "");
  }

  const hotkeyBtns = {
    capture: $("hotkeyCapture"),
    scan: $("hotkeyScan"),
  };
  let recordingKey = "";

  function renderHotkeyBtn(which, acc, conflict) {
    const btn = hotkeyBtns[which];
    if (!btn) return;
    btn.querySelector(".hotkey-text").textContent = prettyAccel(acc);
    btn.classList.toggle("empty", !acc);
    btn.classList.toggle("conflict", !!conflict && !!acc);
    btn.title = conflict && acc ? `注册失败：${conflict}` : acc ? "点击后按下新的组合键" : "点击后按下组合键";
  }

  function stopRecording() {
    if (!recordingKey) return;
    const which = recordingKey;
    const btn = hotkeyBtns[which];
    if (btn) btn.classList.remove("recording");
    recordingKey = "";
    document.removeEventListener("keydown", onRecordKey, true);
    document.removeEventListener("mousedown", onRecordClickOutside, true);
    // 恢复按钮显示（录制态把文案换成了「按下组合键…」，取消/结束后要还原原值）
    const acc = settings
      ? which === "capture"
        ? settings.hotkeyCapture
        : settings.hotkeyScan
      : "";
    renderHotkeyBtn(which, acc, "");
  }

  function onRecordClickOutside(e) {
    if (e.target.closest(".hotkey-btn")) return;
    stopRecording();
  }

  function onRecordKey(e) {
    if (!recordingKey) return;
    e.preventDefault();
    e.stopPropagation();
    const which = recordingKey;
    // Esc 单独按下 = 取消录制（不当作快捷键）
    if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      stopRecording();
      return;
    }
    if (e.key === "Backspace" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      // 退格 = 清除快捷键
      stopRecording();
      applyHotkey(which, "");
      return;
    }
    const acc = toAccelerator(e);
    if (!acc) return; // 只按了修饰键，继续等
    stopRecording();
    applyHotkey(which, acc);
  }

  /** 写入设置并保存快捷键；主进程返回注册结果 */
  async function applyHotkey(which, acc) {
    const otherKey = which === "capture" ? "hotkeyScan" : "hotkeyCapture";
    const otherVal = (settings[otherKey] || "").trim();
    if (acc && otherVal && acc === otherVal) {
      toast("与另一个快捷键重复，请换一个组合");
      return;
    }
    if (which === "capture") settings.hotkeyCapture = acc;
    else settings.hotkeyScan = acc;
    const res = await api.saveSettings(settings);
    const hs = (res && res.hotkeys) || {};
    const ok = which === "capture" ? hs.captureOk : hs.scanOk;
    const err = which === "capture" ? hs.captureError : hs.scanError;
    renderHotkeyBtn("capture", settings.hotkeyCapture, hs.captureOk === false ? hs.captureError : "");
    renderHotkeyBtn("scan", settings.hotkeyScan, hs.scanOk === false ? hs.scanError : "");
    if (acc && ok === false) {
      toast(`⚠️ ${prettyAccel(acc)} 注册失败：${err || "已被占用"}`, 6000);
    } else if (acc) {
      toast(`快捷键已设为 ${prettyAccel(acc)}`);
    } else {
      toast("已清除快捷键");
    }
  }

  Object.entries(hotkeyBtns).forEach(([which, btn]) => {
    if (!btn) return;
    btn.addEventListener("click", (e) => {
      // 点 × 清除
      if (e.target.closest(".hotkey-clear")) {
        e.stopPropagation();
        stopRecording();
        applyHotkey(which, "");
        return;
      }
      if (recordingKey === which) return stopRecording();
      stopRecording();
      recordingKey = which;
      btn.classList.add("recording");
      btn.querySelector(".hotkey-text").textContent = "按下组合键…";
      document.addEventListener("keydown", onRecordKey, true);
      document.addEventListener("mousedown", onRecordClickOutside, true);
    });
  });

  // ------------------------------------------------ 供应商页

  async function loadProviders() {
    const res = await api.getProviders();
    providers = res.providers || [];
    activeId = res.activeId || "";
    if (res.vaultPath) vaultPath = res.vaultPath;

    if (!providers.length) {
      $("providerList").innerHTML =
        '<div class="item"><div class="item-body">' +
        '<div class="item-title">未找到供应商</div>' +
        '<div class="item-meta">请在 Obsidian 里打开 ai-explainer 插件设置，添加一个供应商</div>' +
        "</div></div>";
      return;
    }

    $("providerList").innerHTML = providers
      .map((p) => {
        const isActive = p.id === activeId;
        const kind = p.ptype === "dsweb" ? "DeepSeek 网页版" : "OpenAI 兼容 API";
        const models = (p.models || []).join(" · ");
        const tags = [
          `<span class="tag${p.ptype === "dsweb" ? "" : " gray"}">${kind}</span>`,
          p.ptype === "dsweb" && p.expertMode !== false ? '<span class="tag gray">专家模式</span>' : "",
          p.ptype === "dsweb" && p.webSearch ? '<span class="tag gray">联网</span>' : "",
          p.vision ? '<span class="tag gray">视觉</span>' : "",
          isActive ? '<span class="tag">使用中</span>' : "",
          p.enabled ? "" : '<span class="tag warn">已禁用</span>',
        ]
          .filter(Boolean)
          .join("");
        const meta =
          p.ptype === "dsweb"
            ? `端口 ${p.dswebPort || 9223} · 免 Key（复用浏览器登录态）`
            : `${esc(p.baseURL)} · Key ${p.apiKey ? "已配置" : "缺失"}`;
        return `<div class="item ${isActive ? "active" : ""}">
        <div class="item-body">
          <div class="item-title">${esc(p.name)}${tags}</div>
          <div class="item-meta">${meta}<br>模型：${esc(models) || "—"}</div>
        </div>
        <div class="item-actions">
          <button class="btn quiet" data-test="${p.id}">测试</button>
          ${
            isActive
              ? '<button class="btn quiet" disabled>使用中</button>'
              : `<button class="btn" data-use="${p.id}">使用</button>`
          }
          <button class="btn quiet" data-edit="${p.id}">编辑</button>
          <button class="btn quiet danger" data-del="${p.id}" title="删除该供应商">删除</button>
        </div>
      </div>`;
      })
      .join("");

    // 配置里没有 DeepSeek 网页版条目 → 明确提示并可一键补建。
    // 供应商列表完全来自 Obsidian 插件配置（插件无任何预置条目），
    // 新机器上常见「只有 API 供应商」，此时登录网页版也选不到它。
    const hasDsweb = providers.some((p) => p.ptype === "dsweb");
    const hintEl = $("dswebMissingHint");
    if (hasDsweb || !providers.length) {
      hintEl.classList.add("hidden");
    } else {
      hintEl.classList.remove("hidden");
      hintEl.innerHTML =
        '<span class="hint-icon" data-icon="info" data-icon-class="ic ic-sm"></span>' +
        "<span>当前配置里没有「DeepSeek 网页版」供应商（免 API Key，复用网页登录态）。" +
        "点右侧按钮添加，或到 Obsidian 插件设置里手动添加。</span>" +
        '<button class="btn" id="btnAddDsweb">添加 DeepSeek 网页版</button>';
      Icons && Icons.hydrate(hintEl);
    }

    // 配置来源：本机 providers.json（不再依赖 Obsidian）
    const src2 = res.storePath ? shortPath(res.storePath) : "";
    const imported = res.importedFromVault ? `（首次从 ${shortPath(res.importedFromVault)} 导入）` : "";
    $("providerHint").textContent = src2 ? `配置来源：${src2}${imported} · 与 Obsidian 插件互不影响` : "";
  }

  // 补建 DeepSeek 网页版供应商（写回插件 data.json 并切为使用中）
  $("dswebMissingHint").addEventListener("click", async (e) => {
    if (!e.target.closest("#btnAddDsweb")) return;
    const btn = e.target.closest("#btnAddDsweb");
    btn.disabled = true;
    btn.textContent = "添加中…";
    const res = await api.addDswebProvider();
    toast(res.ok ? res.message : "失败：" + res.message, 6000);
    if (res.ok) {
      await loadProviders();
      await loadStatus();
    } else {
      btn.disabled = false;
      btn.textContent = "添加 DeepSeek 网页版";
    }
  });

  $("providerList").addEventListener("click", async (e) => {
    const useBtn = e.target.closest("[data-use]");
    if (useBtn) {
      await api.setProvider({ id: useBtn.dataset.use });
      toast("已切换供应商");
      loadProviders();
      loadStatus();
      return;
    }
    const testBtn = e.target.closest("[data-test]");
    if (testBtn) {
      testBtn.disabled = true;
      testBtn.textContent = "…";
      const res = await api.testProvider({ id: testBtn.dataset.test });
      testBtn.disabled = false;
      testBtn.textContent = "测试";
      toast(res.ok ? res.message : "失败：" + res.message, 5000);
      return;
    }
    const editBtn = e.target.closest("[data-edit]");
    if (editBtn) {
      openProviderModal(editBtn.dataset.edit);
      return;
    }
    const delBtn = e.target.closest("[data-del]");
    if (delBtn) {
      const id = delBtn.dataset.del;
      const p = providers.find((x) => x.id === id);
      const isActive = id === activeId;
      const msg = isActive
        ? `删除「${p ? p.name : id}」？它是当前使用中的供应商，删除后会自动切换到其它可用项。\n\n（配置来源是 Obsidian 插件的 data.json，会同步生效）`
        : `删除「${p ? p.name : id}」？\n\n（配置来源是 Obsidian 插件的 data.json，会同步生效）`;
      if (!confirm(msg)) return;
      delBtn.disabled = true;
      const res = await api.deleteProvider({ id });
      if (res.ok) {
        toast("已删除供应商");
        await loadProviders();
        await loadStatus();
      } else {
        delBtn.disabled = false;
        toast(res.message || "删除失败", 5000);
      }
    }
  });

  // ------------------------------------------------ 供应商弹窗（新增/编辑）

  /** 弹窗状态：editingId 为空 = 新增 */
  let pmEditingId = "";
  let pmPtype = "api";

  const PM = {
    modal: $("providerModal"),
    title: $("pmTitle"),
    type: $("pmType"),
    typeNote: $("pmTypeNote"),
    name: $("pmName"),
    url: $("pmURL"),
    key: $("pmKey"),
    models: $("pmModels"),
    urlField: $("pmUrlField"),
    keyField: $("pmKeyField"),
    modelsField: $("pmModelsField"),
    portField: $("pmPortField"),
    port: $("pmPort"),
    dswebOpts: $("pmDswebOpts"),
    expert: $("pmExpert"),
    webSearch: $("pmWebSearch"),
    activate: $("pmActivate"),
    activateRow: $("pmActivateRow"),
    msg: $("pmMsg"),
  };

  function pmSetType(ptype) {
    pmPtype = ptype === "dsweb" ? "dsweb" : "api";
    PM.type.querySelectorAll(".seg-item").forEach((b) => {
      b.classList.toggle("active", b.dataset.ptype === pmPtype);
    });
    const isDsweb = pmPtype === "dsweb";
    // API：地址 + Key + 模型必填；网页版：地址与模型可留空（用默认值），端口/开关可见
    PM.urlField.classList.toggle("hidden", isDsweb);
    PM.keyField.classList.toggle("hidden", isDsweb);
    PM.portField.classList.toggle("hidden", !isDsweb);
    PM.dswebOpts.classList.toggle("hidden", !isDsweb);
    PM.modelsField.classList.remove("hidden");
    PM.typeNote.textContent = isDsweb
      ? "免 API Key：复用专用浏览器里的 DeepSeek 网页登录态（登录态与 Obsidian 插件共用）"
      : "OpenAI 兼容接口：填中转站地址 + Key + 模型名";
    if (isDsweb) {
      PM.name.placeholder = "DeepSeek 网页版";
      PM.models.placeholder = "留空则用默认：DeepSeek-V4-Pro（专家模式）等";
    } else {
      PM.name.placeholder = "例如：aitry / 智谱 / 自建中转";
      PM.models.placeholder = "deepseek-v4-flash\n每行一个，也可用逗号分隔";
    }
    // 编辑已有条目时不允许改类型（避免把 API 改成网页版后 Key/模型错乱）
    PM.type.querySelectorAll(".seg-item").forEach((b) => {
      b.disabled = !!pmEditingId;
    });
  }

  PM.type.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-item");
    if (!btn || btn.disabled) return;
    pmSetType(btn.dataset.ptype);
  });

  function openProviderModal(editId) {
    pmEditingId = editId || "";
    const p = pmEditingId ? providers.find((x) => x.id === pmEditingId) : null;
    PM.msg.textContent = "";
    PM.title.textContent = pmEditingId ? "编辑供应商" : "新增供应商";
    if (p) {
      pmSetType(p.ptype === "dsweb" ? "dsweb" : "api");
      PM.name.value = p.name || "";
      PM.url.value = p.baseURL || "";
      PM.key.value = p.apiKey || "";
      PM.models.value = (p.models || []).join("\n");
      PM.port.value = String(p.dswebPort || 9223);
      PM.expert.checked = p.expertMode !== false;
      PM.webSearch.checked = !!p.webSearch;
      PM.activate.checked = false;
      PM.activateRow.classList.add("hidden"); // 编辑时不涉及「立即使用」
    } else {
      pmSetType("api");
      PM.name.value = "";
      PM.url.value = "";
      PM.key.value = "";
      PM.models.value = "";
      PM.port.value = "9223";
      PM.expert.checked = true;
      PM.webSearch.checked = false;
      PM.activate.checked = true;
      PM.activateRow.classList.remove("hidden");
    }
    PM.modal.classList.remove("hidden");
    // 焦点给第一个输入框，便于直接输入
    setTimeout(() => (pmEditingId ? PM.name : PM.name).focus(), 30);
  }

  function closeProviderModal() {
    PM.modal.classList.add("hidden");
    pmEditingId = "";
  }

  $("btnAddProvider").addEventListener("click", () => openProviderModal(""));
  $("pmClose").addEventListener("click", closeProviderModal);
  $("pmCancel").addEventListener("click", closeProviderModal);
  PM.modal.addEventListener("click", (e) => {
    if (e.target === PM.modal) closeProviderModal(); // 点遮罩关闭
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !PM.modal.classList.contains("hidden")) closeProviderModal();
  });

  $("pmSave").addEventListener("click", async () => {
    const name = PM.name.value.trim();
    const isDsweb = pmPtype === "dsweb";
    const models = PM.models.value
      .split(/[\n,，;；]/)
      .map((m) => m.trim())
      .filter(Boolean);

    // 前端先做一次校验，给出即时反馈（主进程还会再校验一次）
    if (!isDsweb) {
      if (!PM.url.value.trim()) return (PM.msg.textContent = "请填写 Base URL");
      if (!models.length) return (PM.msg.textContent = "请至少填写一个模型名");
    }
    PM.msg.textContent = "";
    const btn = $("pmSave");
    btn.disabled = true;
    btn.textContent = "保存中…";

    const payload = isDsweb
      ? {
          name: name || "DeepSeek 网页版",
          ptype: "dsweb",
          dswebPort: Number(PM.port.value) || 9223,
          expertMode: PM.expert.checked,
          webSearch: PM.webSearch.checked,
          models,
        }
      : {
          name,
          ptype: "api",
          baseURL: PM.url.value.trim(),
          apiKey: PM.key.value.trim(),
          models,
        };

    const res = pmEditingId
      ? await api.updateProvider(Object.assign({ id: pmEditingId }, payload))
      : await api.addProvider(Object.assign(payload, { activate: PM.activate.checked }));

    btn.disabled = false;
    btn.textContent = "保存";
    if (!res.ok) {
      PM.msg.textContent = res.message || "保存失败";
      return;
    }
    toast(pmEditingId ? "已更新供应商" : "已新增供应商" + (isDsweb ? "，请点「登录网页版」完成登录" : ""), 5000);
    closeProviderModal();
    await loadProviders();
    await loadStatus();
  });

  $("btnFollowPlugin").addEventListener("click", async () => {
    // 取消「手动指定」：用列表里当前 active 的供应商（本机配置里的 activeProviderId）
    const cur = providers.find((p) => p.id === activeId) || providers[0];
    if (!cur) return toast("没有可用供应商");
    await api.setProvider({ id: cur.id });
    toast("已取消手动指定");
    loadProviders();
    loadStatus();
  });

  $("btnRefreshProviders").addEventListener("click", () => {
    loadProviders();
    toast("已刷新");
  });

  $("btnDswebLogin").addEventListener("click", async () => {
    toast("正在打开专用浏览器登录页…", 4000);
    const res = await api.dswebLogin({});
    toast(res.ok ? res.message : "失败：" + res.message, 7000);
    // 登录流程可能自动补建了 dsweb 供应商条目 → 刷新列表与状态
    if (res.ok) {
      await loadProviders();
      await loadStatus();
    }
  });

  $("btnDswebLogout").addEventListener("click", async () => {
    await api.dswebLogout();
    toast("已关闭网页版专用浏览器");
  });

  $("btnDswebCheck").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "检查中…";
    const res = await api.checkDswebStatus();
    btn.disabled = false;
    btn.textContent = "检查登录状态";
    if (res.state === "logged-in") toast("✅ 已登录，可以正常使用网页版");
    else if (res.state === "logged-out") toast("未登录。请点「登录网页版」在专用浏览器里完成登录", 5000);
    else toast(res.message || "无法确认登录状态", 5000);
  });

  // 主进程推送：登录页打开后轮询探测，登录完成时提示
  api.onDswebStatus &&
    api.onDswebStatus((s) => {
      if (!s) return;
      if (s.state === "waiting") {
        startLoginPolling();
      } else if (s.state === "logged-in") {
        stopLoginPolling();
        toast("✅ DeepSeek 网页版登录成功", 5000);
      }
    });

  let loginPollTimer = null;
  function startLoginPolling() {
    stopLoginPolling();
    loginPollTimer = setInterval(async () => {
      const res = await api.checkDswebStatus();
      if (res.state === "logged-in") {
        stopLoginPolling();
        toast("✅ DeepSeek 网页版登录成功", 5000);
      }
    }, 4000);
    // 5 分钟后自动停（避免用户一直不登录时空转）
    setTimeout(stopLoginPolling, 300000);
  }
  function stopLoginPolling() {
    if (loginPollTimer) {
      clearInterval(loginPollTimer);
      loginPollTimer = null;
    }
  }

  // ------------------------------------------------ 动作页

  function renderActions() {
    $("actionList").innerHTML = actions
      .map(
        (a, i) => `<div class="item item-col" data-idx="${i}">
        <div class="action-row">
          <div class="icon-picker" data-idx="${i}">
            <button class="icon-picker-btn" data-icon-toggle title="选择图标">
              ${icon(a.icon, "ic")}
              <span class="icon-picker-caret" data-icon="chevronDown" data-icon-class="ic ic-sm"></span>
            </button>
            <div class="icon-picker-pop hidden">
              ${(Icons ? Icons.names : [])
                .map(
                  (n) =>
                    `<button class="icon-opt${n === a.icon ? " active" : ""}" data-icon-pick="${n}" title="${n}">${icon(n, "ic")}</button>`
                )
                .join("")}
            </div>
          </div>
          <input type="text" class="action-label-input" data-k="label" value="${esc(a.label)}" placeholder="按钮名称" />
          <span class="spacer"></span>
          <button class="btn quiet btn-tiny" data-del="${i}">删除</button>
        </div>
        <div class="field" style="margin:0">
          <textarea data-k="prompt" rows="4" spellcheck="false">${esc(a.prompt)}</textarea>
          <p class="field-note">{{selection}} 选中内容 · {{targetLang}} 翻译目标语言</p>
        </div>
      </div>`
      )
      .join("");
    Icons && Icons.hydrate($("actionList"));
  }

  $("actionList").addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-icon-toggle]");
    if (toggle) {
      const pop = toggle.parentElement.querySelector(".icon-picker-pop");
      const wasHidden = pop.classList.contains("hidden");
      document.querySelectorAll(".icon-picker-pop").forEach((p) => p.classList.add("hidden"));
      pop.classList.toggle("hidden", !wasHidden);
      e.stopPropagation();
      return;
    }
    const pick = e.target.closest("[data-icon-pick]");
    if (pick) {
      const picker = pick.closest(".icon-picker");
      const idx = Number(picker.dataset.idx);
      if (actions[idx]) actions[idx].icon = pick.dataset.iconPick;
      renderActions();
      e.stopPropagation();
      return;
    }
    const del = e.target.closest("[data-del]");
    if (del) {
      actions.splice(Number(del.dataset.del), 1);
      renderActions();
    }
  });
  document.addEventListener("click", () => {
    document.querySelectorAll(".icon-picker-pop").forEach((p) => p.classList.add("hidden"));
  });

  $("actionList").addEventListener("input", (e) => {
    const item = e.target.closest("[data-idx]");
    if (!item) return;
    const idx = Number(item.dataset.idx);
    const key = e.target.dataset.k;
    if (!key || !actions[idx]) return;
    actions[idx][key] = e.target.value;
  });

  $("btnAddAction").addEventListener("click", () => {
    actions.push({
      id: "custom" + Date.now().toString(36),
      label: "新动作",
      icon: "wand",
      prompt: "请处理以下内容：\n\n【内容】\n{{selection}}",
    });
    renderActions();
  });

  // 恢复预设动作的默认提示词（「结论置顶 + 关键词加粗」结构）。
  // 只覆盖 id 与预设相同的动作提示词，用户自建动作不受影响。
  $("btnResetActions").addEventListener("click", async () => {
    if (!confirm("把「解释 / 翻译 / 总结 / 意图分析 / 拟回复」的提示词恢复为默认？\n\n（只影响预设动作，你自己新增的动作不受影响；未保存前可取消）")) return;
    const defaults = (await api.getDefaultActions?.()) || [];
    if (!defaults.length) return toast("无法获取默认提示词");
    let n = 0;
    for (const d of defaults) {
      const hit = actions.find((a) => a.id === d.id);
      if (hit && hit.prompt !== d.prompt) {
        hit.prompt = d.prompt;
        hit.label = d.label; // 文案也一并复位（图标保留用户所选）
        n += 1;
      }
    }
    renderActions();
    toast(n ? `已恢复 ${n} 个动作的默认提示词，点「保存」生效` : "提示词已是默认，无需恢复", 4000);
  });

  $("btnSaveActions").addEventListener("click", async () => {
    settings.actions = actions.filter((a) => a.label && a.prompt);
    await api.saveSettings(settings);
    toast("已保存动作");
    loadStatus();
  });

  // ------------------------------------------------ 记录页

  async function loadNotes() {
    const res = await api.listNotes();
    const notes = res.notes || [];
    if (!notes.length) {
      $("noteList").innerHTML =
        '<div class="item"><div class="item-body"><div class="item-meta">还没有记录</div></div></div>';
      return;
    }
    $("noteList").innerHTML = notes
      .map(
        (n) =>
          `<div class="note-item" data-date="${esc(n.date)}">${esc(n.date)}<span class="size">${(n.size / 1024).toFixed(1)} KB</span></div>`
      )
      .join("");
    $("noteList").querySelectorAll(".note-item").forEach((el) => {
      el.addEventListener("click", async () => {
        $("noteList")
          .querySelectorAll(".note-item")
          .forEach((x) => x.classList.toggle("active", x === el));
        const r = await api.readNote({ date: el.dataset.date });
        $("notePreview").textContent = r.content || "（空）";
      });
    });
  }

  // ------------------------------------------------ 生成记录页

  let historyRecords = [];
  let historySelectedId = "";
  let historyLoadedOnce = false;

  function fmtTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function loadHistory() {
    const res = await api.listHistory({ limit: 300 });
    historyRecords = res.records || [];
    renderHistoryList();
    // 选中项被删除/清空后回退到第一条
    if (historySelectedId && historyRecords.some((r) => r.id === historySelectedId)) {
      await showHistoryDetail(historySelectedId);
    } else if (historyRecords.length) {
      await selectHistoryItem(historyRecords[0].id);
    } else {
      historySelectedId = "";
      $("hdQuote").classList.add("hidden");
      $("hdQuestion").classList.add("hidden");
      $("hdBody").textContent = "还没有生成记录";
      $("hdBody").classList.add("empty");
    }
    historyLoadedOnce = true;
  }

  function renderHistoryList() {
    if (!historyRecords.length) {
      $("historyList").innerHTML =
        '<div class="item"><div class="item-body"><div class="item-meta">还没有生成记录</div></div></div>';
      return;
    }
    $("historyList").innerHTML = historyRecords
      .map(
        (r) => `<button class="history-item" data-id="${esc(r.id)}">
        <span class="history-item-top">
          <span class="history-item-time">${fmtTime(r.ts)}</span>
          ${r.saved ? '<span class="history-item-mark saved" title="已录入笔记">已录入</span>' : ""}
          ${r.hasError ? '<span class="history-item-mark err" title="生成失败">失败</span>' : ""}
          <span class="history-item-action">${esc(r.action || "生成")}</span>
        </span>
        <span class="history-item-preview${r.question ? " has-question" : ""}">${esc(r.question || r.selectionPreview || "")}</span>
        <span class="history-item-preview">${esc(r.contentPreview || "")}</span>
      </button>`
      )
      .join("");
  }

  async function selectHistoryItem(id) {
    historySelectedId = id;
    $("historyList")
      .querySelectorAll(".history-item")
      .forEach((el) => el.classList.toggle("active", el.dataset.id === id));
    await showHistoryDetail(id);
  }

  async function showHistoryDetail(id) {
    const rec = await api.getHistory({ id });
    if (!rec) {
      $("hdBody").textContent = "记录不存在（可能已被删除）";
      $("hdBody").classList.add("empty");
      return;
    }
    $("hdQuote").classList.toggle("hidden", !rec.selection);
    $("hdQuote").textContent = rec.selection || "";
    $("hdQuestion").classList.toggle("hidden", !rec.question);
    $("hdQuestion").textContent = rec.question || "";
    const body = $("hdBody");
    body.classList.remove("empty");
    // 失败记录：错误信息置顶显示，正文（若有）跟随其后
    if (rec.error) {
      body.textContent = `⚠️ ${rec.error}` + (rec.content ? "\n\n—— 已生成的部分 ——\n\n" + rec.content : "");
      body.classList.add("empty");
      return;
    }
    // 正文用 Markdown 渲染（与悬浮卡片同一渲染器；main.html 也引入 md.js）
    body.innerHTML = window.HuaciMd ? window.HuaciMd.render(rec.content || "") : esc(rec.content || "");
    if (!rec.content) body.textContent = "（无输出内容）";
    // 元信息行（时间 / 来源 / 模型）
    const meta = document.createElement("div");
    meta.className = "hd-meta";
    const t = new Date(rec.ts);
    const pad = (n) => String(n).padStart(2, "0");
    meta.textContent =
      `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ` +
      `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}` +
      (rec.app ? ` · 来自 ${rec.app}` : "") +
      (rec.provider ? ` · ${rec.provider}${rec.model ? " " + rec.model : ""}` : "");
    body.prepend(document.createElement("br"));
    body.prepend(meta);
  }

  $("historyList").addEventListener("click", (e) => {
    const el = e.target.closest(".history-item");
    if (el) void selectHistoryItem(el.dataset.id);
  });

  $("btnRefreshHistory").addEventListener("click", () => void loadHistory());

  $("btnDeleteHistory").addEventListener("click", async () => {
    if (!historySelectedId) return toast("未选择记录");
    const res = await api.deleteHistory({ id: historySelectedId });
    if (res.ok) {
      toast("已删除");
      historySelectedId = "";
      await loadHistory();
    } else {
      toast("删除失败");
    }
  });

  $("btnClearHistory").addEventListener("click", async () => {
    if (!confirm("确定清空全部生成记录？此操作不可恢复。")) return;
    const res = await api.clearHistory();
    toast(`已清空 ${res.deleted ?? 0} 条`);
    historySelectedId = "";
    await loadHistory();
  });

  // ------------------------------------------------ 启动

  (async function init() {
    settings = await api.getSettings();
    actions = JSON.parse(JSON.stringify(settings.actions || []));
    // 快捷键：显示当前值 + 从主进程取注册结果（被占用时标红）
    const hs = (await api.getHotkeyState?.()) || {};
    renderHotkeyBtn("capture", settings.hotkeyCapture, hs.captureOk === false ? hs.captureError : "");
    renderHotkeyBtn("scan", settings.hotkeyScan, hs.scanOk === false ? hs.scanError : "");
    $("inAutoPopup").checked = !!settings.autoPopup;
    $("inHeadless").checked = !!settings.dswebHeadless;
    $("notesDir").textContent = settings.captureDir;
    renderActions();
    await loadStatus();

    api.onState &&
      api.onState((s) => {
        if (!s) return;
        if (s.captureEnabled !== undefined) $("toggleCapture").checked = !!s.captureEnabled;
        if (s.accessibilityTrusted !== undefined) {
          setRowValue("stPerm", s.accessibilityTrusted ? "已授权" : "未授权", s.accessibilityTrusted ? "ok" : "bad");
        }
        if (s.inputMonitoring !== undefined) {
          setRowValue("stInputMon", s.inputMonitoring ? "已授权" : "未授权", s.inputMonitoring ? "ok" : "warn");
        }
        if (s.screenRecording !== undefined) {
          setRowValue("stScreenRec", s.screenRecording ? "已授权" : "未授权", s.screenRecording ? "ok" : "warn");
        }
        // helper 就绪广播（含 helperPath）说明完整状态已可用，整体刷新一次
        if (s.helperPath !== undefined) void loadStatus();
      });
  })();
})();

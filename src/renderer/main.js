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
    $("heroSub").textContent = ok
      ? "在任意应用选中文字，工具条会自动浮出"
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

  $("btnOpenDir").addEventListener("click", () => {
    if (!vaultPath) return toast("未设置 vault");
    const dir = (settings && settings.captureDir) || "04-日常记录/AI划词解释";
    api.openExternal("file://" + vaultPath + "/" + dir);
  });

  $("inHotkey").addEventListener("change", saveSimple);
  $("inHotkeyScan").addEventListener("change", saveSimple);
  $("inAutoPopup").addEventListener("change", saveSimple);
  $("inHeadless").addEventListener("change", saveSimple);

  async function saveSimple() {
    settings.hotkeyCapture = $("inHotkey").value.trim();
    settings.hotkeyScan = $("inHotkeyScan").value.trim();
    settings.autoPopup = $("inAutoPopup").checked;
    settings.dswebHeadless = $("inHeadless").checked;
    await api.saveSettings(settings);
    toast("已保存");
  }

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
        </div>
      </div>`;
      })
      .join("");

    $("providerHint").textContent = vaultPath
      ? `配置来源：${shortPath(vaultPath)}/.obsidian/plugins/ai-explainer/data.json`
      : "";
  }

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
    }
  });

  $("btnFollowPlugin").addEventListener("click", async () => {
    await api.setProvider({ id: "" });
    toast("已改为跟随插件设置");
    loadProviders();
    loadStatus();
  });

  $("btnRefreshProviders").addEventListener("click", () => {
    loadProviders();
    toast("已刷新");
  });

  $("btnDswebLogin").addEventListener("click", async () => {
    toast("正在启动专用浏览器…", 4000);
    const res = await api.dswebLogin({});
    toast(res.ok ? res.message : "失败：" + res.message, 6000);
  });

  $("btnDswebLogout").addEventListener("click", async () => {
    await api.dswebLogout();
    toast("已关闭网页版专用浏览器");
  });

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

  // ------------------------------------------------ 启动

  (async function init() {
    settings = await api.getSettings();
    actions = JSON.parse(JSON.stringify(settings.actions || []));
    $("inHotkey").value = settings.hotkeyCapture || "";
    $("inHotkeyScan").value = settings.hotkeyScan || "";
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

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

    $("providerHint").textContent = vaultPath
      ? `配置来源：${shortPath(vaultPath)}/.obsidian/plugins/ai-explainer/data.json`
      : "";
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

/**
 * 悬浮窗逻辑：工具条 → 结果卡片（流式渲染 → 追问 → 录入笔记）
 */
(function () {
  const api = window.huaci;
  const Icons = window.HuaciIcons;
  if (!api) {
    console.error("[overlay] preload 桥未加载");
    return;
  }

  const $ = (id) => document.getElementById(id);
  const root = $("root");
  const toolbar = $("toolbar");
  const card = $("card");
  const tbQuote = $("tbQuote");
  const tbActions = $("tbActions");
  const headIcon = $("headIcon");
  const actionLabel = $("actionLabel");
  const providerLabel = $("providerLabel");
  const quote = $("quote");
  const body = $("body");
  const errBox = $("err");
  const thinkingWrap = $("thinkingWrap");
  const thinkingBody = $("thinkingBody");
  const thinkingLabel = $("thinkingLabel");
  const thinkingHead = $("thinkingToggle");
  const thinkingChevron = thinkingHead.querySelector(".thinking-chevron");
  const askInput = $("askInput");
  const btnSend = $("btnSend");
  const btnSave = $("btnSave");
  const btnCopy = $("btnCopy");
  const btnRetry = $("btnRetry");
  const btnStop = $("btnStop");
  const btnClose = $("btnClose");
  const btnTbClose = $("btnTbClose");
  const toast = $("toast");

  const state = {
    mode: "toolbar",
    selection: "",
    content: "",
    thinking: "",
    running: false,
    actions: [],
    actionId: "",
    actionIcon: "sparkles",
  };
  let thinkingOpen = false;
  let toastTimer = null;

  // ------------------------------------------------ 工具

  function showToast(msg, ms) {
    toast.textContent = msg;
    toast.classList.remove("hidden");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), ms || 2200);
  }

  /** Markdown → HTML（共享渲染器，支持 GFM 表格；见 md.js） */
  function mdToHtml(md) {
    return window.HuaciMd ? window.HuaciMd.render(md) : String(md || "");
  }

  function render() {
    body.innerHTML = mdToHtml(state.content);
    body.classList.toggle("streaming", state.running);
    if (state.running) body.scrollTop = body.scrollHeight;
    autoResize();
  }

  /** 让主进程把窗口调到合适高度（卡片）/ 宽度（工具条） */
  function autoResize() {
    if (state.mode === "toolbar") {
      // 工具条：动作项数量由用户配置决定，窗口宽度必须按内容自适应，
      // 否则超宽的动作（如第 4、5 项）会被固定宽度直接裁掉。
      requestAnimationFrame(() => {
        // toolbar 是 width:100% 的 flex item：临时放开为 max-content 量自然宽度
        const prev = toolbar.style.width;
        toolbar.style.width = "max-content";
        const natural = toolbar.offsetWidth;
        toolbar.style.width = prev;
        // #root 左右各 6px 的阴影留白
        api.resizeOverlay({ width: natural + 12 });
      });
      return;
    }
    requestAnimationFrame(() => {
      // #root 高度恒为 100vh，body.scrollHeight 量到的永远是「当前窗口高度」，
      // 窗口只能每次 +2px 缓慢爬升。改为临时把卡片放开成 max-content，
      // 量出内容自然高度后立即恢复（同一帧内完成，不会闪烁）。
      const prev = card.style.height;
      card.style.height = "max-content";
      const natural = card.offsetHeight;
      card.style.height = prev;
      // 加 #root 上下各 6px 的阴影留白
      const wanted = Math.min(natural + 12, 660);
      api.resizeOverlay({ height: Math.max(68, wanted) });
    });
  }

  function setMode(mode) {
    state.mode = mode;
    root.className = mode === "card" ? "mode-card" : "mode-toolbar";
    toolbar.classList.toggle("hidden", mode !== "toolbar");
    card.classList.toggle("hidden", mode !== "card");
    autoResize();
  }

  function setHeadIcon(name) {
    if (Icons) headIcon.innerHTML = Icons.icon(name, "ic");
  }

  // ------------------------------------------------ 交互

  Icons && Icons.hydrate();

  tbActions.addEventListener("click", (e) => {
    const btn = e.target.closest(".tb-btn");
    if (!btn) return;
    api.runAction({ actionId: btn.dataset.id, text: state.selection });
  });

  // 框选屏幕区域 → OCR → 分析（聊天/图片/PDF 场景入口）
  $("btnScan").addEventListener("click", () => {
    api.scanRegion();
  });

  tbQuote.addEventListener("click", () => showToast(state.selection, 4000));

  quote.addEventListener("click", () => {
    quote.classList.toggle("expanded");
    autoResize();
  });
  // 展开/收起带 max-height 过渡，过渡中量到的是中间值 → 结束后再校正一次
  quote.addEventListener("transitionend", (e) => {
    if (e.propertyName === "max-height") autoResize();
  });

  thinkingHead.addEventListener("click", () => {
    thinkingOpen = !thinkingOpen;
    thinkingBody.classList.toggle("hidden", !thinkingOpen);
    thinkingChevron.classList.toggle("open", thinkingOpen);
    autoResize();
  });

  btnStop.addEventListener("click", () => api.abort());
  btnClose.addEventListener("click", () => api.hideOverlay());
  // 工具条关闭：选区消失会收起工具条，这里也提供手动关闭
  btnTbClose.addEventListener("click", () => api.hideOverlay());

  /**
   * 复制到剪贴板。走主进程 —— 渲染层的 navigator.clipboard 在窗口无焦点时
   * 会被拒绝（悬浮窗默认 focusable:false），表现为「点了没反应」。
   */
  async function copyText(text) {
    if (!text) return false;
    if (api.writeClipboard) {
      const res = await api.writeClipboard(text);
      return !!(res && res.ok);
    }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------ 交互态焦点
  //
  // 悬浮窗默认 focusable:false（不抢前台应用焦点）。但不可聚焦的窗口**收不到
  // 键盘事件** —— 卡片里选中文字按 ⌘C 会毫无反应（用户实际反馈的问题）。
  // 方案：鼠标进入悬浮窗时临时可聚焦（用户正在与它交互，符合预期），
  // 离开即释放，恢复「不打扰前台应用」的默认状态。
  (function setupInteractiveFocus() {
    let inside = false;
    const enter = () => {
      if (inside) return;
      inside = true;
      api.setOverlayInteractive && api.setOverlayInteractive({ focused: true });
    };
    const leave = () => {
      if (!inside) return;
      inside = false;
      api.setOverlayInteractive && api.setOverlayInteractive({ focused: false });
    };
    document.addEventListener("mouseenter", enter);
    document.addEventListener("mouseleave", leave);
    // mouseleave 在窗口内移动时可能不触发，用坐标兜底（移出窗口边界）
    document.addEventListener("mousemove", (e) => {
      const out = e.clientX <= 0 || e.clientY <= 0 ||
                  e.clientX >= window.innerWidth - 1 || e.clientY >= window.innerHeight - 1;
      if (out) leave();
      else enter();
    });
    // 窗口隐藏时释放（主进程侧也会重置，这里保持两端一致）
    window.addEventListener("blur", () => { inside = false; });
  })();

  // ------------------------------------------------ 右键菜单（自绘）
  //
  // 悬浮窗 focusable:false，macOS 不把它当 key window，原生菜单弹不出来
  // （右键毫无反应）。故在渲染层自绘：不依赖 key window，也不抢焦点。
  const ctxMenu = $("ctxMenu");

  function hideCtxMenu() {
    ctxMenu.classList.add("hidden");
  }

  function selectedText() {
    return window.getSelection ? String(window.getSelection().toString() || "") : "";
  }

  /** 打开菜单：位置贴近光标，超出窗口则回收到边界内 */
  function openCtxMenu(x, y) {
    const hasSel = selectedText().trim().length > 0;
    ctxMenu.querySelector('[data-ctx="copy"]').disabled = !hasSel;
    ctxMenu.classList.remove("hidden");
    // 量出尺寸后收敛到窗口内（悬浮窗很小，菜单不能溢出）
    const rect = ctxMenu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 6;
    const maxY = window.innerHeight - rect.height - 6;
    ctxMenu.style.left = Math.max(6, Math.min(x, maxX)) + "px";
    ctxMenu.style.top = Math.max(6, Math.min(y, maxY)) + "px";
  }

  document.addEventListener("contextmenu", (e) => {
    // 只在我们自己的界面内响应（工具条/卡片），并阻止默认（默认也没菜单，但保持一致）
    e.preventDefault();
    e.stopPropagation();
    openCtxMenu(e.clientX, e.clientY);
  });

  // 点击别处/滚动/按键 → 关闭菜单
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#ctxMenu")) hideCtxMenu();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideCtxMenu();
  });
  window.addEventListener("blur", hideCtxMenu);

  // 用 mousedown 而非 click 触发：click 需要「按下与抬起都不被系统吞掉」，
  // 而悬浮窗在聚焦状态切换的间隙里 click 可能丢失（表现为「菜单点了没反应」）。
  // mousedown 更早、更可靠。用 e.detail 防止同一次操作被 fire 两次。
  ctxMenu.addEventListener("mousedown", async (e) => {
    const btn = e.target.closest("[data-ctx]");
    if (!btn) return;
    const action = btn.dataset.ctx;
    hideCtxMenu();
    if (action === "copy") {
      const text = selectedText();
      if (!text) return showToast("没有选中内容");
      showToast((await copyText(text)) ? "已复制选中内容" : "复制失败");
    } else if (action === "copyAll") {
      if (!state.content) return showToast("还没有内容");
      showToast((await copyText(state.content)) ? "已复制全部内容" : "复制失败");
    } else if (action === "selectAll") {
      // 选中结果正文，便于用户再按 ⌘C
      const body = document.getElementById("body");
      if (!body) return;
      const range = document.createRange();
      range.selectNodeContents(body);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      showToast("已全选，按 ⌘C 复制");
    }
  });

  // ------------------------------------------------ JS 拖动
  //
  // 不用 -webkit-app-region：透明 + focusable:false 窗口上行为不稳定，
  // 且 drag 区域会吞掉子元素点击（曾导致卡片 ✕ 失灵）。
  // 这里只上报起止，跟随由主进程 16ms 定时器完成（见 overlay.ts drag()）。
  // 注意：window 里的 mouseup 可能落在窗口外而丢失，mouseup 阶段改监听 document，
  // 配合主进程 30s 兜底停表。
  (function setupDrag() {
    // 工具条：整条可拖；卡片：仅头部可拖。
    // 命中按钮/输入框等交互元素时不启动拖动（避免吞掉点击）。
    function dragTarget(e) {
      if (e.button !== 0) return null;
      const t = e.target;
      if (t.closest("button, input, textarea, select, a, .icon-picker-pop")) return null;
      if (state.mode === "toolbar" && t.closest("#toolbar")) return toolbar;
      if (state.mode === "card" && t.closest(".card-head")) return card;
      return null;
    }
    window.addEventListener("mousedown", (e) => {
      if (!dragTarget(e)) return;
      e.preventDefault();
      api.dragOverlay("start");
      const stop = () => {
        api.dragOverlay("end");
        document.removeEventListener("mouseup", stop);
      };
      document.addEventListener("mouseup", stop);
    });
  })();

  btnCopy.addEventListener("click", async () => {
    if (!state.content) return showToast("还没有内容");
    showToast((await copyText(state.content)) ? "已复制" : "复制失败");
  });

  btnSave.addEventListener("click", async () => {
    if (!state.content) {
      showToast("还没有内容");
      return;
    }
    const res = await api.saveToNote({});
    if (res.ok) {
      btnSave.disabled = true;
      btnSave.innerHTML = (Icons ? Icons.icon("check", "ic ic-sm") : "") + "已录入";
      showToast(res.replaced ? "已更新笔记中的同条目" : "已录入笔记");
    } else {
      showToast(res.message || "录入失败");
    }
  });

  btnRetry.addEventListener("click", () => {
    if (!state.actionId) return;
    api.runAction({ actionId: state.actionId, text: state.selection });
  });

  // 追问
  function sendFollowup() {
    const q = askInput.value.trim();
    if (!q) return;
    askInput.value = "";
    askInput.style.height = "auto";
    api.followup({ question: q });
  }
  btnSend.addEventListener("click", sendFollowup);

  askInput.addEventListener("focus", () => api.focusOverlay({ focusable: true }));
  askInput.addEventListener("blur", () => {
    askInput.style.height = "auto";
    api.focusOverlay({ focusable: false });
  });
  askInput.addEventListener("input", () => {
    askInput.style.height = "auto";
    askInput.style.height = Math.min(askInput.scrollHeight, 74) + "px";
    autoResize();
  });
  askInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendFollowup();
    } else if (e.key === "Escape") {
      e.preventDefault();
      askInput.blur();
      api.hideOverlay();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.activeElement !== askInput) {
      api.hideOverlay();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      btnSave.click();
    }
    // ⌘C / Ctrl+C：有选中内容时复制它；没选中则复制整篇结果。
    // 显式接管而不是依赖系统默认行为 —— 悬浮窗的焦点状态与普通窗口不同，
    // 系统默认复制在 focusable 切换的边缘场景下不可靠。
    if ((e.metaKey || e.ctrlKey) && e.key === "c") {
      const sel = window.getSelection ? String(window.getSelection().toString() || "") : "";
      const text = sel.trim() ? sel : state.content;
      if (!text) return;
      e.preventDefault();
      copyText(text).then((ok) =>
        showToast(ok ? (sel.trim() ? "已复制选中内容" : "已复制全部内容") : "复制失败")
      );
    }
  });

  // ------------------------------------------------ 主进程推送

  api.onState((s) => {
    if (!s) return;
    if (s.mode) setMode(s.mode);

    if (s.actions) {
      state.actions = s.actions;
      tbActions.innerHTML = "";
      for (const a of s.actions) {
        const b = document.createElement("button");
        b.className = "tb-btn";
        b.dataset.id = a.id;
        b.innerHTML = (Icons ? Icons.icon(a.icon) : "") + a.label;
        tbActions.appendChild(b);
      }
      autoResize();
    }

    if (s.selection !== undefined) {
      state.selection = s.selection;
      tbQuote.textContent = s.selection.replace(/\s+/g, " ");
      quote.textContent = s.selection;
      quote.classList.remove("expanded");
    }

    if (s.icon) {
      state.actionIcon = s.icon;
      setHeadIcon(s.icon);
    }
    if (s.action !== undefined) {
      actionLabel.textContent = s.action || "解释";
      const hit = state.actions.find((a) => a.label === s.action);
      if (hit) state.actionId = hit.id;
    }
    if (s.provider || s.model) {
      providerLabel.textContent = [s.provider, s.model].filter(Boolean).join(" · ");
    }

    if (s.mode === "card" && s.running) {
      state.content = "";
      state.thinking = "";
      btnSave.disabled = false;
      btnSave.innerHTML =
        (Icons ? Icons.icon("download", "ic ic-sm") : "") + "录入笔记";
      errBox.classList.add("hidden");
      thinkingWrap.classList.add("hidden");
      thinkingBody.classList.add("hidden");
      thinkingBody.textContent = "";
      thinkingChevron.classList.remove("open");
      thinkingHead.classList.remove("streaming");
      thinkingOpen = false;
      render();
    }
    if (s.running === false) body.classList.remove("streaming");
  });

  api.onChunk((c) => {
    if (!c) return;
    if (c.kind === "reset") {
      state.content = "";
      state.thinking = "";
      render();
      return;
    }
    if (c.kind === "content") {
      state.content += c.delta || "";
      render();
    } else if (c.kind === "thinking") {
      state.thinking += c.delta || "";
      thinkingWrap.classList.remove("hidden");
      thinkingBody.textContent = state.thinking;
      thinkingBody.scrollTop = thinkingBody.scrollHeight;
      thinkingHead.classList.add("streaming");
      thinkingLabel.textContent = "思考中";
      autoResize();
    }
  });

  api.onDone((d) => {
    state.running = false;
    if (d && d.content) state.content = d.content;
    if (d && d.thinking) state.thinking = d.thinking;
    render();
    body.classList.remove("streaming");
    thinkingHead.classList.remove("streaming");
    if (state.thinking) thinkingLabel.textContent = "思考过程";
    if (d && d.question) {
      const q = document.createElement("div");
      q.className = "quote";
      q.textContent = d.question;
      body.insertBefore(q, body.firstChild);
    }
    autoResize();
  });

  api.onError((e) => {
    state.running = false;
    body.classList.remove("streaming");
    thinkingHead.classList.remove("streaming");
    errBox.textContent = (e && e.message) || "出错了";
    errBox.classList.remove("hidden");
    autoResize();
  });

  api.onClick(() => askInput.blur());

  setMode("toolbar");
  setHeadIcon("sparkles");
})();

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

  /** 极简 Markdown → HTML */
  function mdToHtml(md) {
    if (!md) return "";
    md = md.replace(/^\*{2,}\s*([：:])\s*/gm, "$1").replace(/^\*{2,}\s*$/gm, "");
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const blocks = [];
    let text = md.replace(/```([a-zA-Z0-9]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
      const i = blocks.length;
      blocks.push(`<pre><code data-lang="${esc(lang || "")}">${esc(code.replace(/\n$/, ""))}</code></pre>`);
      return `\u0000BLOCK${i}\u0000`;
    });

    text = esc(text);

    const inline = (s) =>
      s
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');

    const lines = text.split("\n");
    const out = [];
    let listType = null;
    let para = [];

    const flushPara = () => {
      if (para.length) {
        out.push(`<p>${inline(para.join("<br>"))}</p>`);
        para = [];
      }
    };
    const closeList = () => {
      if (listType) {
        out.push(`</${listType}>`);
        listType = null;
      }
    };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      const t = line.trim();

      if (/^\u0000BLOCK\d+\u0000$/.test(t)) {
        flushPara();
        closeList();
        out.push(t);
        continue;
      }
      if (!t) {
        flushPara();
        closeList();
        continue;
      }
      const h = t.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara();
        closeList();
        out.push(`<h${Math.min(h[1].length + 1, 4)}>${inline(h[2])}</h${Math.min(h[1].length + 1, 4)}>`);
        continue;
      }
      if (t.startsWith(">")) {
        flushPara();
        closeList();
        out.push(`<blockquote>${inline(t.replace(/^>\s?/, ""))}</blockquote>`);
        continue;
      }
      const ul = t.match(/^[-*+]\s+(.*)$/);
      if (ul) {
        flushPara();
        if (listType !== "ul") {
          closeList();
          out.push("<ul>");
          listType = "ul";
        }
        out.push(`<li>${inline(ul[1])}</li>`);
        continue;
      }
      const ol = t.match(/^\d+[.)]\s+(.*)$/);
      if (ol) {
        flushPara();
        if (listType !== "ol") {
          closeList();
          out.push("<ol>");
          listType = "ol";
        }
        out.push(`<li>${inline(ol[1])}</li>`);
        continue;
      }
      if (/^[-=_*~]{3,}$/.test(t)) {
        flushPara();
        closeList();
        out.push("<hr>");
        continue;
      }
      para.push(line);
    }
    flushPara();
    closeList();

    let html = out.join("");
    html = html.replace(/\u0000BLOCK(\d+)\u0000/g, (_m, i) => blocks[Number(i)] || "");
    return html;
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

  btnCopy.addEventListener("click", async () => {
    if (!state.content) return;
    try {
      await navigator.clipboard.writeText(state.content);
      showToast("已复制");
    } catch {
      showToast("复制失败");
    }
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

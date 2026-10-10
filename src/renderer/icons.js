/**
 * 内联 SVG 图标集（Lucide 风格：1.5px 细线、圆头、跟随 currentColor）
 * 用内联 SVG 替代 emoji —— emoji 跨版本渲染不一致，且与 macOS 系统审美冲突。
 */
(function () {
  const PATHS = {
    // AI / 解释
    sparkles: '<path d="M12 3l1.9 4.8L18.7 9.7l-4.8 1.9L12 16.4l-1.9-4.8L5.3 9.7l4.8-1.9L12 3z"/><path d="M19 15l.8 2.1 2.2.9-2.2.9L19 21l-.8-2.1-2.2-.9 2.2-.9L19 15z"/>',
    // 翻译
    languages:
      '<path d="M4 5h7"/><path d="M7 5c0 4.5-2 7-5 9"/><path d="M6 11c1.5 2.5 3.5 4 6 5"/><path d="M14 20l4-9 4 9"/><path d="M15.5 17h5"/>',
    // 总结
    alignLeft:
      '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="10" x2="14" y2="10"/><line x1="4" y1="14" x2="20" y2="14"/><line x1="4" y1="18" x2="12" y2="18"/>',
    // 录入笔记
    download:
      '<path d="M12 3v12"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
    refresh: '<path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 4v7h-7"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    chevronRight: '<path d="M9 6l6 6-6 6"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    // 思考过程
    bulb: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 00-3.5 10.9c.4.3.5.8.5 1.1h6c0-.3.1-.8.5-1.1A6 6 0 0012 3z"/>',
    // 设置 / 状态
    activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
    plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v3a6 6 0 01-12 0V8h12z"/>',
    wand: '<path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8L19 13"/><path d="M15 9h0"/><path d="M17.8 6.2L19 5"/><path d="M3 21l9-9"/><path d="M12.2 6.2L11 5"/>',
    notebook: '<path d="M4 4a2 2 0 012-2h12a2 2 0 012 2v16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"/><path d="M8 2v20"/><path d="M12 7h5"/><path d="M12 11h5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h0"/>',
    // 状态指示
    check: '<path d="M20 6L9 17l-5-5"/>',
    marker: '<path d="M12 22s8-4.5 8-11a8 8 0 10-16 0c0 6.5 8 11 8 11z"/><circle cx="12" cy="11" r="2.5"/>',
    send: '<path d="M4 12l16-8-7 18-2-7-7-3z"/>',
    // 聊天分析
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    message: '<path d="M21 12a8 8 0 01-8 8H7l-4 3v-6.5A8 8 0 0113 4a8 8 0 018 8z"/>',
    scan: '<path d="M4 8V6a2 2 0 012-2h2"/><path d="M16 4h2a2 2 0 012 2v2"/><path d="M20 16v2a2 2 0 01-2 2h-2"/><path d="M8 20H6a2 2 0 01-2-2v-2"/><path d="M4 12h16"/>',
  };

  /**
   * 生成图标 SVG 字符串
   * @param {string} name 图标名
   * @param {string} cls 附加 class（默认 ic）
   */
  function icon(name, cls) {
    const d = PATHS[name];
    if (!d) return "";
    return `<svg class="${cls || "ic"}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  }

  /** 把页面里所有 <i data-icon="name"> 替换为内联 SVG */
  function hydrate(root) {
    const host = root || document;
    host.querySelectorAll("[data-icon]").forEach((el) => {
      const name = el.getAttribute("data-icon");
      const cls = el.getAttribute("data-icon-class") || "ic";
      el.innerHTML = icon(name, cls);
      el.removeAttribute("data-icon");
    });
  }

  window.HuaciIcons = { icon, hydrate, names: Object.keys(PATHS) };
})();

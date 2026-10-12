/**
 * 无 Electron 时的 mock 桥（浏览器里调 UI 用）。
 * 真实 preload 存在时静默退出。
 */
(function () {
  if (window.huaci && !window.huaci.isMock) return;

  const noop = () => () => {};

  const mockProviders = [
    {
      id: "demo-api",
      name: "示例 API 供应商",
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-demo",
      models: ["deepseek-v4-flash"],
      enabled: true,
      ptype: "api",
      usable: true,
      sourceVault: "/Users/demo/Documents/Note",
    },
    {
      id: "demo-dsweb",
      name: "DeepSeek 网页版",
      baseURL: "https://chat.deepseek.com",
      apiKey: "",
      models: ["DeepSeek-V4-Pro（专家模式）", "DeepSeek-V4-Flash（快速模式）"],
      enabled: true,
      ptype: "dsweb",
      vision: true,
      dswebPort: 9223,
      expertMode: true,
      usable: true,
      sourceVault: "/Users/demo/Documents/Note",
    },
  ];

  const mockSettings = {
    vaultPath: "/Users/demo/Documents/Note",
    preferredProviderId: "",
    captureDir: "04-日常记录/AI划词解释",
    calloutType: "note",
    autoPopup: true,
    hotkeyCapture: "CommandOrControl+Shift+E",
    actions: [
      { id: "explain", label: "解释", icon: "✨", prompt: "解释 {{selection}}" },
      { id: "translate", label: "翻译", icon: "🌐", prompt: "翻译 {{selection}}" },
      { id: "summarize", label: "总结", icon: "📝", prompt: "总结 {{selection}}" },
    ],
    dswebHeadless: true,
    maxSelectionChars: 3000,
  };

  let timer = null;
  const listeners = {};

  function fire(channel, payload) {
    (listeners[channel] || []).forEach((cb) => cb(payload));
  }

  window.huaci = {
    isMock: true,
    getCaptureStatus: async () => ({
      enabled: true,
      available: true,
      accessibilityTrusted: true,
      inputMonitoring: true,
      helperPath: "/mock/SelectionHelper",
    }),
    toggleCapture: async () => ({ enabled: true }),
    requestCapture: async () => true,
    openAccessibilitySettings: async () => true,
    openInputMonitoringSettings: async () => true,
    openScreenRecordingSettings: async () => true,
    scanRegion: async () => {
      fire("overlay:state", {
        mode: "toolbar",
        selection: "（mock）从聊天记录识别到的文字内容……",
        app: "屏幕区域",
        actions: mockSettings.actions.map((a) => ({ id: a.id, label: a.label, icon: a.icon })),
      });
      return true;
    },
    regionUpdate: () => () => {},

    runAction: async ({ actionId, text }) => {
      const demo =
        "这段话讲的是 **RoPE（旋转位置编码）**，它把位置信息通过旋转矩阵注入到注意力计算中。\n\n" +
        "- **核心思路**：用复数旋转表示相对位置\n" +
        "- **优点**：外推到更长序列时更稳定\n\n" +
        "```python\nq = rotate(q, pos * theta)\n```\n";
      fire("overlay:chunk", { kind: "thinking", delta: "先分析选区语义，再给出术语解释……" });
      let i = 0;
      clearInterval(timer);
      timer = setInterval(() => {
        if (i >= demo.length) {
          clearInterval(timer);
          fire("overlay:done", { content: demo, provider: "mock", model: "demo" });
          return;
        }
        fire("overlay:chunk", { kind: "content", delta: demo.slice(i, i + 6) });
        i += 6;
      }, 40);
      return true;
    },
    followup: async () => {
      fire("overlay:chunk", { kind: "reset", delta: "" });
      fire("overlay:done", { content: "这是 mock 追问回答。", question: "追问示例" });
      return true;
    },
    abort: async () => {
      clearInterval(timer);
      return true;
    },
    saveToNote: async () => ({ ok: true, file: "/mock/note.md", replaced: false }),
    hideOverlay: async () => true,
    dragOverlay: async () => true,
    resizeOverlay: async () => true,
    focusOverlay: async () => true,
    openMain: async () => true,

    listVaults: async () => ({
      vaults: [
        { path: "/Users/demo/Documents/Note", name: "Note", hasExplainer: true, hasConfig: true },
      ],
      active: { path: "/Users/demo/Documents/Note", name: "Note", hasExplainer: true, hasConfig: true },
    }),
    getProviders: async () => ({
      providers: mockProviders,
      activeId: "demo-dsweb",
      activeModel: "DeepSeek-V4-Pro（专家模式）",
      vaultPath: "/Users/demo/Documents/Note",
    }),
    setProvider: async () => ({ ok: true }),
    testProvider: async () => ({ ok: true, message: "连通 · 320ms（mock）" }),
    dswebLogin: async () => ({ ok: true, message: "mock 登录" }),
    dswebLogout: async () => ({ ok: true }),
    checkDswebStatus: async () => ({ state: "logged-in", ok: true }),
    onDswebStatus: () => () => {},
    addDswebProvider: async () => ({ ok: true, created: true, message: "已添加「DeepSeek 网页版」供应商（mock）" }),

    listHistory: async () => ({
      records: [
        {
          id: "mock-1",
          ts: Date.now() - 3600e3,
          action: "解释",
          app: "Safari",
          provider: "DeepSeek 网页版",
          model: "DeepSeek-V4-Pro（专家模式）",
          selectionPreview: "RoPE 旋转位置编码把位置信息通过旋转矩阵注入注意力计算",
          contentPreview: "这段话讲的是 RoPE（旋转位置编码），核心思路是用复数旋转表示相对位置……",
          saved: false,
          hasError: false,
        },
        {
          id: "mock-2",
          ts: Date.now() - 86400e3,
          action: "追问",
          provider: "示例 API 供应商",
          model: "deepseek-v4-flash",
          selectionPreview: "RoPE 旋转位置编码的基本原理",
          contentPreview: "相对位置编码的优势在于外推到更长序列时更稳定……",
          saved: true,
          hasError: false,
        },
      ],
    }),
    getHistory: async (p) => ({
      id: p.id,
      ts: Date.now(),
      action: "解释",
      selection: "RoPE 旋转位置编码的基本原理",
      content: "（mock）这是该条记录的完整正文。",
      saved: false,
    }),
    deleteHistory: async () => ({ ok: true }),
    clearHistory: async () => ({ ok: true }),

    getSettings: async () => mockSettings,
    saveSettings: async (s) => ({ ok: true, settings: Object.assign(mockSettings, s) }),
    pickVault: async () => ({ ok: false }),
    openExternal: async () => true,

    listNotes: async () => ({
      notes: [{ date: "2026-10-07", file: "/mock/2026-10-07.md", size: 1024 }],
      vaultPath: "/mock",
    }),
    readNote: async () => ({ content: "> [!note]- ✨ 解释：mock 内容\n> 示例正文" }),
    openNote: async () => ({ ok: true }),

    diag: () => {},

    onSelection: (cb) => {
      (listeners["capture:selection"] ||= []).push(cb);
      return () => {};
    },
    onClick: (cb) => {
      (listeners["capture:click"] ||= []).push(cb);
      return () => {};
    },
    onChunk: (cb) => {
      (listeners["overlay:chunk"] ||= []).push(cb);
      return () => {};
    },
    onDone: (cb) => {
      (listeners["overlay:done"] ||= []).push(cb);
      return () => {};
    },
    onError: (cb) => {
      (listeners["overlay:error"] ||= []).push(cb);
      return () => {};
    },
    onState: (cb) => {
      (listeners["overlay:state"] ||= []).push(cb);
      return () => {};
    },
  };

  // 触发一次示例状态，方便调 UI
  setTimeout(() => {
    fire("overlay:state", {
      mode: "toolbar",
      selection: "RoPE 旋转位置编码的基本原理",
      actions: mockSettings.actions.map((a) => ({ id: a.id, label: a.label, icon: a.icon })),
    });
  }, 120);
})();

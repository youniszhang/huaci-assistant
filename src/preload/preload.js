/**
 * Preload 桥：暴露 window.huaci（与 md2备忘录 的 window.md2notes 同模式）
 */
const { contextBridge, ipcRenderer } = require("electron");
const { API } = require("../shared/api");

/** 事件订阅统一返回退订函数 */
function subscribe(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const bridge = {
  isMock: false,

  // ---- 划词 ----
  getCaptureStatus: () => ipcRenderer.invoke(API["capture:status"]),
  toggleCapture: (enabled) => ipcRenderer.invoke(API["capture:toggle"], { enabled }),
  requestCapture: () => ipcRenderer.invoke(API["capture:request"]),
  openAccessibilitySettings: () => ipcRenderer.invoke(API["capture:open-permission"]),
  openInputMonitoringSettings: () => ipcRenderer.invoke(API["capture:open-input-monitoring"]),
  openScreenRecordingSettings: () => ipcRenderer.invoke(API["capture:open-screen-recording"]),
  scanRegion: () => ipcRenderer.invoke(API["capture:scan-region"]),
  regionUpdate: (cb) => subscribe("region:update", cb),
  onSelection: (cb) => subscribe(API["capture:selection"], cb),
  onClick: (cb) => subscribe(API["capture:click"], cb),

  // ---- 悬浮窗 ----
  runAction: (payload) => ipcRenderer.invoke(API["overlay:action"], payload),
  followup: (payload) => ipcRenderer.invoke(API["overlay:followup"], payload),
  abort: () => ipcRenderer.invoke(API["overlay:abort"]),
  saveToNote: (payload) => ipcRenderer.invoke(API["overlay:save"], payload),
  hideOverlay: () => ipcRenderer.invoke(API["overlay:hide"]),
  dragOverlay: (phase) => ipcRenderer.invoke(API["overlay:drag"], { phase }),
  resizeOverlay: (payload) => ipcRenderer.invoke(API["overlay:resize"], payload),
  focusOverlay: (payload) => ipcRenderer.invoke(API["overlay:focus"], payload),
  openMain: () => ipcRenderer.invoke(API["overlay:open-main"]),
  onChunk: (cb) => subscribe(API["overlay:chunk"], cb),
  onDone: (cb) => subscribe(API["overlay:done"], cb),
  onError: (cb) => subscribe(API["overlay:error"], cb),
  onState: (cb) => subscribe(API["overlay:state"], cb),

  // ---- 配置 ----
  listVaults: () => ipcRenderer.invoke(API["config:vaults"]),
  getProviders: () => ipcRenderer.invoke(API["config:providers"]),
  setProvider: (payload) => ipcRenderer.invoke(API["config:set-provider"], payload),
  testProvider: (payload) => ipcRenderer.invoke(API["config:test-provider"], payload),
  dswebLogin: (payload) => ipcRenderer.invoke(API["config:dsweb-login"], payload),
  dswebLogout: () => ipcRenderer.invoke(API["config:dsweb-logout"]),
  checkDswebStatus: () => ipcRenderer.invoke(API["config:dsweb-status"]),
  onDswebStatus: (cb) => subscribe(API["config:dsweb-status"], cb),
  addDswebProvider: () => ipcRenderer.invoke(API["config:add-dsweb-provider"]),
  addProvider: (payload) => ipcRenderer.invoke(API["config:add-provider"], payload),
  updateProvider: (payload) => ipcRenderer.invoke(API["config:update-provider"], payload),
  deleteProvider: (payload) => ipcRenderer.invoke(API["config:delete-provider"], payload),

  // ---- 生成历史 ----
  listHistory: (payload) => ipcRenderer.invoke(API["history:list"], payload),
  getHistory: (payload) => ipcRenderer.invoke(API["history:get"], payload),
  deleteHistory: (payload) => ipcRenderer.invoke(API["history:delete"], payload),
  clearHistory: () => ipcRenderer.invoke(API["history:clear"]),

  // ---- 设置 ----
  getSettings: () => ipcRenderer.invoke(API["settings:get"]),
  saveSettings: (payload) => ipcRenderer.invoke(API["settings:save"], payload),
  getHotkeyState: () => ipcRenderer.invoke(API["settings:hotkey-state"]),
  getDefaultActions: () => ipcRenderer.invoke(API["settings:default-actions"]),
  pickVault: () => ipcRenderer.invoke(API["system:pick-vault"]),
  openExternal: (url) => ipcRenderer.invoke(API["system:open-external"], { url }),

  // ---- 笔记 ----
  listNotes: () => ipcRenderer.invoke(API["notes:list"]),
  readNote: (payload) => ipcRenderer.invoke(API["notes:read"], payload),
  openNote: (payload) => ipcRenderer.invoke(API["notes:open"], payload),

  diag: (msg) => ipcRenderer.send(API["system:diag"], msg),
};

contextBridge.exposeInMainWorld("huaci", bridge);

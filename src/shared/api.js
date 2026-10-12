/**
 * IPC 通道常量（main 与 preload 共用）。
 * 命名规范：域:动作（小写连字符），与 md2备忘录 一致。
 */
const API = {
  // 划词
  'capture:status': 'capture:status',
  'capture:toggle': 'capture:toggle',
  'capture:request': 'capture:request',
  'capture:open-permission': 'capture:open-permission',
  'capture:open-input-monitoring': 'capture:open-input-monitoring',
  'capture:open-screen-recording': 'capture:open-screen-recording',
  'capture:scan-region': 'capture:scan-region',
  'capture:ocr-selection': 'capture:ocr-selection',
  'capture:selection': 'capture:selection',      // main → renderer 推送
  'capture:click': 'capture:click',              // main → renderer 推送

  // 悬浮窗
  'overlay:action': 'overlay:action',
  'overlay:followup': 'overlay:followup',
  'overlay:abort': 'overlay:abort',
  'overlay:save': 'overlay:save',
  'overlay:hide': 'overlay:hide',
  'overlay:drag': 'overlay:drag',                // 渲染层 → main：卡片/工具条拖动
  'overlay:resize': 'overlay:resize',
  'overlay:focus': 'overlay:focus',              // 追问输入时临时获取焦点
  'overlay:open-main': 'overlay:open-main',
  'overlay:chunk': 'overlay:chunk',              // main → renderer 推送
  'overlay:done': 'overlay:done',
  'overlay:error': 'overlay:error',
  'overlay:state': 'overlay:state',

  // 配置
  'config:vaults': 'config:vaults',
  'config:providers': 'config:providers',
  'config:set-provider': 'config:set-provider',
  'config:test-provider': 'config:test-provider',
  'config:dsweb-login': 'config:dsweb-login',
  'config:dsweb-logout': 'config:dsweb-logout',
  'config:dsweb-status': 'config:dsweb-status',  // main → renderer 推送：登录状态变化
  'config:add-dsweb-provider': 'config:add-dsweb-provider',  // 补建网页版供应商条目
  'config:add-provider': 'config:add-provider',              // 新增供应商（API/网页版）
  'config:update-provider': 'config:update-provider',        // 更新供应商
  'config:delete-provider': 'config:delete-provider',        // 删除供应商

  // 生成历史
  'history:list': 'history:list',
  'history:get': 'history:get',
  'history:delete': 'history:delete',
  'history:clear': 'history:clear',

  // 应用设置
  'settings:get': 'settings:get',
  'settings:save': 'settings:save',
  'settings:hotkey-state': 'settings:hotkey-state',  // 快捷键注册结果（是否被占用）
  'settings:default-actions': 'settings:default-actions',  // 预设动作默认提示词

  // 笔记
  'notes:list': 'notes:list',
  'notes:read': 'notes:read',
  'notes:open': 'notes:open',

  // 系统
  'system:pick-vault': 'system:pick-vault',
  'system:open-external': 'system:open-external',
  'system:diag': 'system:diag',
}

module.exports = { API }

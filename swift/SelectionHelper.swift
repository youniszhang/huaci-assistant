// SelectionHelper — 系统级划词捕获助手
//
// 目标：在任何 macOS 应用里检测"划词"动作并读到选中文本。
//
// 现实约束（实测结论）：
//   • 原生 App（TextEdit/预览/Safari 部分控件）：AX 直接暴露 AXSelectedText → 轮询即可
//   • Electron/Chromium 系（Obsidian、VS Code、Chrome…）：AX 树里没有选区文本
//     → 只能靠 Cmd+C；绝不能高频调用（会污染剪贴板、打断用户）
//
// 因此采用「事件驱动」为主、轮询为辅：
//   1) 事件通道（需「输入监控」权限）：鼠标拖拽结束 / Cmd+A / Shift+方向键
//      → 触发一次取词：先 AX，失败则 Cmd+C（读后还原剪贴板）
//      鼠标捕获用 CGEventTap（listenOnly）：硬件事件与注入/远程事件都能收到；
//      键盘用 NSEvent 全局监听；CGEventTap 创建失败时鼠标退回 NSEvent。
//   2) 轮询通道（需「辅助功能」权限）：只读 AX，不产生任何副作用，
//      用于兜住"事件通道没权限时"的原生 App 场景
//
// 协议（JSON lines，UTF-8）：
//   stdout ↑  {"type":"ready","accessibilityTrusted":bool,"inputMonitoring":bool,"pid":n}
//             {"type":"selection","ok":true,"text":"...","x":n,"y":n,"app":"Safari","via":"ax|clipboard"}
//             {"type":"selection","ok":false,"reason":"no-selection"}
//             {"type":"cleared"}
//             {"type":"click","x":n,"y":n}
//             {"type":"pong"}
//   stdin  ↓  {"type":"capture"}  立即取词（强制，忽略去抖）
//             {"type":"ping"}
//             {"type":"quit"}

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// MARK: - 常量

/// 这些 app 里 Cmd+C 是中断信号，绝不能用它取词
let termBundleIDs: Set<String> = [
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp-Stable",
    "net.kovidgoyal.kitty",
    "co.zeit.hyper",
    "com.github.wez.wezterm",
    "org.alacritty",
]

let selectionSettleDelay: TimeInterval = 0.08
let pollInterval: TimeInterval = 0.4
let repeatSuppressInterval: TimeInterval = 1.5
let minSelectionLength = 2

/// 宿主应用 PID（忽略它们窗口里的选区）
var ignorePids: Set<pid_t> = []

/// 事件通道是否真的收到过事件（即「输入监控」权限是否生效）
var eventChannelActive = false
/// 是否真的收到过至少一个事件（与 tap 是否创建成功无关）
var receivedAnyEvent = false

/// 「输入监控」权限：用 CGPreflightListenEventAccess 探测（macOS 10.15+）
func hasInputMonitoring() -> Bool {
    if #available(macOS 10.15, *) {
        return CGPreflightListenEventAccess()
    }
    return false
}

/// 「屏幕录制」权限：用 CGPreflightScreenCaptureAccess 探测（macOS 10.15+）
func hasScreenRecording() -> Bool {
    if #available(macOS 10.15, *) {
        return CGPreflightScreenCaptureAccess()
    }
    return false
}

// MARK: - 区域框选模式

/// 框选状态：等待用户拖拽一个矩形（用于聊天记录等非文本场景）
var regionSelectActive = false
var regionStart: (x: CGFloat, y: CGFloat)?
/// 框选兜底计时器：超时未完成自动退出，避免 helper 永久停留在 region 模式吞掉划词
var regionWatchdog: DispatchWorkItem?

func beginRegionSelect() {
    regionSelectActive = true
    regionStart = nil
    emit(["type": "region-begin"])
    // 120s 兜底：用户长时间不操作（或 main 侧异常）也不会卡死划词流程
    regionWatchdog?.cancel()
    let task = DispatchWorkItem {
        guard regionSelectActive else { return }
        endRegionSelect(rect: nil)
    }
    regionWatchdog = task
    DispatchQueue.main.asyncAfter(deadline: .now() + 120, execute: task)
}

func endRegionSelect(rect: (x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat)?) {
    regionWatchdog?.cancel()
    regionWatchdog = nil
    regionSelectActive = false
    regionStart = nil
    if let r = rect {
        emit(["type": "region", "x": r.x, "y": r.y, "w": r.w, "h": r.h])
    } else {
        emit(["type": "region-cancel"])
    }
}
/// 命令行强制指定：--force-clipboard（跳过 AX，直接 Cmd+C）
var forceClipboard = false

// MARK: - 协议输出

let stdoutHandle = FileHandle.standardOutput
let outQueue = DispatchQueue(label: "helper.stdout")

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    outQueue.async {
        if let d = line.data(using: .utf8) { stdoutHandle.write(d) }
    }
}

func emitSelection(_ text: String, x: CGFloat, y: CGFloat, h: CGFloat, app: String, via: String) {
    emit([
        "type": "selection", "ok": true, "text": text,
        "x": x, "y": y, "h": h, "app": app, "via": via,
    ])
}

func emitNoSelection(_ reason: String) {
    emit(["type": "selection", "ok": false, "reason": reason])
}

// MARK: - 权限与信息

func ensureAccessibility() -> Bool {
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false] as CFDictionary
    return AXIsProcessTrustedWithOptions(opts)
}

/// 主动请求三项权限：
///  - 未授权时弹系统对话框，并把本应用（responsible process）加入对应设置列表 ——
///    adhoc 签名时 TCC 按 cdhash 匹配，覆盖安装后授权会静默失效；
///    若从不带 prompt 请求，用户在系统设置里连条目都看不到，无从手动修复。
///  - 已授权时调用无副作用；已拒绝过则静默返回（需去系统设置手动勾选）。
var requestedAccessibility = false
var requestedInputMonitoring = false
var requestedScreenRecording = false

func requestPermissions(ax: Bool, input: Bool, screen: Bool) {
    if ax, !requestedAccessibility, !AXIsProcessTrusted() {
        requestedAccessibility = true
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
    }
    if #available(macOS 10.15, *) {
        if input, !requestedInputMonitoring, !CGPreflightListenEventAccess() {
            requestedInputMonitoring = true
            _ = CGRequestListenEventAccess()
        }
        if screen, !requestedScreenRecording, !CGPreflightScreenCaptureAccess() {
            requestedScreenRecording = true
            _ = CGRequestScreenCaptureAccess()
        }
    }
}

/// 缓存三项权限状态（用于变化检测）
var lastPermAccessibility = false
var lastPermInputMonitoring = false
var lastPermScreenRecording = false

func permissionSnapshot() -> (Bool, Bool, Bool) {
    (ensureAccessibility(), hasInputMonitoring(), hasScreenRecording())
}

/// 权限可能在运行期间被用户改变（去系统设置勾选/取消）→ 变化时补发 ready，
/// 让状态页无需重启即变绿（之前只能重启才能刷新）。
func startPermissionMonitor() {
    // 用启动时的真实状态初始化缓存，避免首个 tick 把「启动时已授权」
    // 误判为「刚刚授权」而多余重建 CGEventTap、打印误导日志。
    let (a0, i0, s0) = permissionSnapshot()
    lastPermAccessibility = a0
    lastPermInputMonitoring = i0
    lastPermScreenRecording = s0
    let timer = Timer(timeInterval: 5, repeats: true) { _ in
        let (a, i, s) = permissionSnapshot()
        if a != lastPermAccessibility || i != lastPermInputMonitoring || s != lastPermScreenRecording {
            let inputJustGranted = i && !lastPermInputMonitoring
            lastPermAccessibility = a
            lastPermInputMonitoring = i
            lastPermScreenRecording = s
            emit([
                "type": "ready",
                "accessibilityTrusted": a,
                "inputMonitoring": i,
                "screenRecording": s,
                "pid": ProcessInfo.processInfo.processIdentifier,
            ])
            // 关键：CGEventTap 创建时若「输入监控」未授权，tap 会存在但收不到任何
            // 硬件事件；用户随后在系统设置里授权，旧 tap 不会追溯生效。
            // 必须销毁并重建 tap，否则「授权后仍不能用，得重启 app」。
            if inputJustGranted {
                rebuildEventTap()
            }
        }
    }
    RunLoop.main.add(timer, forMode: .common)
}

/// 「输入监控」授权后重建 CGEventTap（旧 tap 不会追溯生效）
func rebuildEventTap() {
    if let old = eventTapRef {
        CGEvent.tapEnable(tap: old, enable: false)
        eventTapRef = nil
    }
    receivedAnyEvent = false
    if setupEventTap() {
        emit(["type": "log", "message": "输入监控已授权 → 已重建 CGEventTap"])
    } else {
        emit(["type": "log", "message": "输入监控已授权，但重建 CGEventTap 失败，继续使用 NSEvent 通道"])
        installNSEventFallback()
    }
}

func frontmostApp() -> NSRunningApplication? { NSWorkspace.shared.frontmostApplication }
func frontmostAppName() -> String { frontmostApp()?.localizedName ?? "" }
func frontmostBundleID() -> String { frontmostApp()?.bundleIdentifier ?? "" }

/// 鼠标位置（**左上原点**，与 Electron setBounds / System Events 一致）
/// 注意：CGEvent.location 本身就是左上原点坐标，不要做纵向翻转——
/// 之前翻成 AppKit 坐标导致悬浮窗出现在垂直镜像的位置。
func mouseLocation() -> (x: CGFloat, y: CGFloat) {
    if let e = CGEvent(source: nil) {
        let p = e.location
        return (p.x, p.y)
    }
    return (0, 0)
}

/// 触发来源，决定锚点策略
enum Trigger {
    case mouse      // 鼠标拖拽划词 → 紧贴鼠标
    case keyboard   // Cmd+A / Shift+方向键 → 元素顶部
    case manual     // 快捷键强制取词 → 鼠标
}

/// 选区锚点（左上原点）。返回 (x, y, h)：
///   x = 水平锚点
///   y = 垂直锚点（工具条摆在此位置下方，放不下则上方）
///   h = 锚点高度；0 表示"以 (x,y) 为点的紧贴式锚点"
///
/// 策略：
///   • 鼠标触发 → 紧贴鼠标（用户视线就在这里，且元素可能极大）
///   • 键盘触发（Cmd+A / Shift+方向键 / 轮询兜底）：
///       - 元素尺寸合理（像一行字/一个小输入框）→ 元素底部居中，贴合内容
///       - 元素过大（整页文本区）→ 退回鼠标位置，避免工具条飞到屏幕边缘
func anchorPosition(trigger: Trigger) -> (x: CGFloat, y: CGFloat, h: CGFloat) {
    let (mx, my) = mouseLocation() // 左上原点

    if trigger == .mouse || trigger == .manual {
        return (mx, my, 0)
    }

    guard let el = focusedElement() else { return (mx, my, 0) }

    var posRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRef) == .success,
          let v = posRef else { return (mx, my, 0) }
    var pt = CGPoint.zero
    guard AXValueGetValue(v as! AXValue, .cgPoint, &pt) else { return (mx, my, 0) }

    var sizeRef: CFTypeRef?
    var sz = CGSize.zero
    if AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRef) == .success,
       let sv = sizeRef {
        AXValueGetValue(sv as! AXValue, .cgSize, &sz)
    }

    let elemW = max(sz.width, 0)
    let elemH = max(sz.height, 0)

    // 元素过大（横跨半屏或纵跨半屏）→ 锚点用鼠标位置更贴近用户操作处
    let tooBig = elemW > 1200 || elemH > 600
    if tooBig {
        return (mx, my, 0)
    }

    // 尺寸合理 → 元素底部居中：工具条出现在内容正下方
    let anchorW = min(max(elemW, 40), 700)
    return (pt.x + anchorW / 2, pt.y + elemH, 0)
}

// MARK: - AX 读取

func focusedElement() -> AXUIElement? {
    let sys = AXUIElementCreateSystemWide()
    var value: CFTypeRef?
    if AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &value) == .success,
       let el = value { return (el as! AXUIElement) }

    guard let front = frontmostApp() else { return nil }
    let appEl = AXUIElementCreateApplication(front.processIdentifier)
    var feRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(appEl, kAXFocusedUIElementAttribute as CFString, &feRef) == .success,
       let el = feRef { return (el as! AXUIElement) }

    var winRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, &winRef) == .success,
       let w = winRef {
        var sub: CFTypeRef?
        if AXUIElementCopyAttributeValue(w as! AXUIElement, kAXFocusedUIElementAttribute as CFString, &sub) == .success,
           let el = sub { return (el as! AXUIElement) }
    }
    return nil
}

func readSelectedText(_ el: AXUIElement) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXSelectedTextAttribute as CFString, &value) == .success,
          let s = value as? String else { return nil }
    return s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : s
}

/// 向下探子元素（浅层，避免性能问题）
func searchSelection(_ el: AXUIElement, depth: Int) -> String? {
    if depth >= 3 { return nil }
    var childrenRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenRef) == .success,
          let children = childrenRef as? [AXUIElement] else { return nil }
    for child in children.prefix(25) {
        if let s = readSelectedText(child) { return s }
    }
    for child in children.prefix(10) {
        if let s = searchSelection(child, depth: depth + 1) { return s }
    }
    return nil
}

func axSelectedText() -> String? {
    guard let el = focusedElement() else { return nil }
    if let s = readSelectedText(el) { return s }
    return searchSelection(el, depth: 0)
}

// MARK: - Cmd+C 取词（读后还原剪贴板）

func clipboardSelectedText(bundleID: String) -> String? {
    if termBundleIDs.contains(bundleID) { return nil }

    let pb = NSPasteboard.general
    // 保存全部类型内容
    var saved: [(NSPasteboard.PasteboardType, Data)] = []
    for t in pb.types ?? [] {
        if let d = pb.data(forType: t) { saved.append((t, d)) }
    }
    let savedCount = pb.changeCount

    guard let src = CGEventSource(stateID: .hidSystemState) else { return nil }
    let keyC: CGKeyCode = 0x08
    let down = CGEvent(keyboardEventSource: src, virtualKey: keyC, keyDown: true)
    let up = CGEvent(keyboardEventSource: src, virtualKey: keyC, keyDown: false)
    down?.flags = .maskCommand
    up?.flags = .maskCommand
    down?.post(tap: .cghidEventTap)
    usleep(18_000)
    up?.post(tap: .cghidEventTap)

    var copied: String? = nil
    let deadline = Date().addingTimeInterval(0.45)
    while Date() < deadline {
        usleep(18_000)
        if pb.changeCount != savedCount {
            usleep(35_000) // 等数据落盘
            copied = pb.string(forType: .string)
            break
        }
    }

    // 还原剪贴板（只有在确实被改动时才还原）
    if pb.changeCount != savedCount, !saved.isEmpty {
        pb.clearContents()
        for (t, d) in saved { pb.setData(d, forType: t) }
    }

    guard let s = copied, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return s
}

// MARK: - 上报与去抖

var lastReported = ""
var lastReportedAt = Date.distantPast

/// 取词并上报。force=true 时忽略去抖（快捷键/手动触发）
func captureSelection(force: Bool = false, trigger: Trigger = .mouse) {
    let appName = frontmostAppName()
    let bundleID = frontmostBundleID()

    var text: String? = nil
    var via = "ax"
    if !forceClipboard {
        text = axSelectedText()
    }
    if text == nil {
        text = clipboardSelectedText(bundleID: bundleID)
        via = "clipboard"
    }
    guard let t = text else {
        if force { emitNoSelection("no-selection") }
        return
    }
    let trimmed = t.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.count < minSelectionLength { return }

    let now = Date()
    if !force, trimmed == lastReported, now.timeIntervalSince(lastReportedAt) < repeatSuppressInterval {
        return
    }
    lastReported = trimmed
    lastReportedAt = now
    let (x, y, h) = anchorPosition(trigger: trigger)
    emitSelection(trimmed, x: x, y: y, h: h, app: appName, via: via)
}

// MARK: - 通道 1：事件监听

var mouseDownPoint: (x: CGFloat, y: CGFloat) = (0, 0)
var mouseDownTime = Date()
var isDragging = false

/// 把两个点规范成左上原点的正矩形
func normalizeRect(_ a: (x: CGFloat, y: CGFloat), _ b: (x: CGFloat, y: CGFloat))
    -> (x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat) {
    let x = min(a.x, b.x)
    let y = min(a.y, b.y)
    return (x, y, abs(b.x - a.x), abs(b.y - a.y))
}

/// NSEvent.mouseLocation 是 AppKit 坐标（左下原点）→ 转成左上原点
func nsToTopLeft(_ p: CGPoint) -> (x: CGFloat, y: CGFloat) {
    let screenH = NSScreen.screens.first?.frame.height ?? 0
    return (p.x, screenH - p.y)
}

// MARK: - 鼠标事件统一处理
//
// 鼠标事件来源有两路（二选一，避免双发）：
//   • CGEventTap（优先）：能收到硬件与注入/远程事件（listenOnly 不拦截）
//   • NSEvent 全局监听（CGEventTap 创建失败时回退）
// 坐标统一为「左上原点」全局坐标（与 Electron setBounds 一致）。

enum MouseEventKind {
    case down, dragged, up
}

/// 双通道（CGEventTap + NSEvent 兜底）可能对同一物理事件各投递一次。
/// 100ms 内「同类型 + 同坐标」视为重复，去重后处理（跨通道投递通常亚毫秒级，
/// 但系统繁忙时可能拉开；真实用户不可能在完全相同像素上 100ms 内重复同一动作）。
var lastMouseEvent: (kind: MouseEventKind, x: CGFloat, y: CGFloat, t: Date)?

func handleMouse(_ kind: MouseEventKind, at p: (x: CGFloat, y: CGFloat)) {
    let now = Date()
    if let last = lastMouseEvent, last.kind == kind,
       abs(last.x - p.x) < 0.5, abs(last.y - p.y) < 0.5,
       now.timeIntervalSince(last.t) < 0.1 {
        return
    }
    lastMouseEvent = (kind, p.x, p.y, now)

    // 框选模式：只处理鼠标，用于圈定屏幕区域
    if regionSelectActive {
        switch kind {
        case .down:
            regionStart = p
            emit(["type": "region-update", "x": p.x, "y": p.y, "w": 0, "h": 0])
        case .dragged:
            guard let s = regionStart else { break }
            let rect = normalizeRect(s, p)
            emit(["type": "region-update", "x": rect.x, "y": rect.y, "w": rect.w, "h": rect.h])
        case .up:
            guard let s = regionStart else { endRegionSelect(rect: nil); return }
            let rect = normalizeRect(s, p)
            if rect.w < 8 || rect.h < 8 {
                endRegionSelect(rect: nil) // 太小视为误触，取消
            } else {
                endRegionSelect(rect: rect)
            }
        }
        return
    }

    switch kind {
    case .down:
        mouseDownPoint = p
        mouseDownTime = Date()
        isDragging = false
    case .dragged:
        if abs(p.x - mouseDownPoint.x) > 3 || abs(p.y - mouseDownPoint.y) > 3 { isDragging = true }
    case .up:
        let moved = abs(p.x - mouseDownPoint.x) > 3 || abs(p.y - mouseDownPoint.y) > 3
        if isDragging || moved {
            scheduleCapture(delay: selectionSettleDelay, trigger: .mouse)
        } else if Date().timeIntervalSince(mouseDownTime) < 0.35 {
            emit(["type": "click", "x": p.x, "y": p.y])
        }
        isDragging = false
    }
}

func handleKey(_ e: NSEvent) {
    // 框选模式：Esc 取消（RegionOverlay 窗口不可聚焦，收不到键盘，这里兜住）
    if regionSelectActive {
        if Int(e.keyCode) == 53 { endRegionSelect(rect: nil) }
        return
    }
    let cmd = e.modifierFlags.contains(.command)
    let shift = e.modifierFlags.contains(.shift)
    if cmd && e.charactersIgnoringModifiers?.lowercased() == "a" {
        scheduleCapture(delay: 0.12, trigger: .keyboard)
    } else if shift, [123, 124, 125, 126].contains(Int(e.keyCode)) {
        scheduleCapture(delay: 0.22, trigger: .keyboard)
    }
}

// MARK: - CGEventTap（鼠标 + 键盘主通道）
//
// 键盘也走 CGEventTap：NSEvent 全局监听收不到注入/远程事件
// （向日葵/VNC/自动化），会导致 Esc 取消失效、快捷键划词在远程场景失灵。
// 与鼠标同理：tap 创建成功时键盘只走 tap，避免双发。

var eventTapRef: CFMachPort?

func setupEventTap() -> Bool {
    let mask: CGEventMask =
        (1 << CGEventType.leftMouseDown.rawValue) |
        (1 << CGEventType.leftMouseDragged.rawValue) |
        (1 << CGEventType.leftMouseUp.rawValue) |
        (1 << CGEventType.keyDown.rawValue)
    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: mask,
        callback: { _, type, event, _ in
            eventTapHandler(type: type, event: event)
            return Unmanaged.passUnretained(event)
        },
        userInfo: nil
    ) else { return false }
    eventTapRef = tap
    let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    return true
}

/// CGEvent 键盘事件 → handleKeyCG（与 NSEvent 回退共用判定逻辑）
func handleKeyCG(_ event: CGEvent) {
    let keyCode = Int(event.getIntegerValueField(.keyboardEventKeycode))
    let flags = event.flags
    // 框选模式：Esc 取消（CGEventTap 能看到注入事件，远程/自动化也能取消）
    if regionSelectActive {
        if keyCode == 53 { endRegionSelect(rect: nil) }
        return
    }
    let cmd = flags.contains(.maskCommand)
    let shift = flags.contains(.maskShift)
    // 用 NSEvent 还原字符，兼容非 ANSI 布局（Cmd+A 判定）
    let chars = NSEvent(cgEvent: event)?.charactersIgnoringModifiers?.lowercased()
    if cmd, chars == "a" {
        scheduleCapture(delay: 0.12, trigger: .keyboard)
    } else if shift, [123, 124, 125, 126].contains(keyCode) {
        scheduleCapture(delay: 0.22, trigger: .keyboard)
    }
}

func eventTapHandler(type: CGEventType, event: CGEvent) {
    // tap 被系统临时禁用（超时/用户输入）→ 重新启用
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = eventTapRef { CGEvent.tapEnable(tap: tap, enable: true) }
        return
    }
    eventChannelActive = true
    receivedAnyEvent = true
    switch type {
    case .leftMouseDown:
        let p = event.location // CGEvent.location 已是左上原点全局坐标
        handleMouse(.down, at: (p.x, p.y))
    case .leftMouseDragged:
        let p = event.location
        handleMouse(.dragged, at: (p.x, p.y))
    case .leftMouseUp:
        let p = event.location
        handleMouse(.up, at: (p.x, p.y))
    case .keyDown:
        handleKeyCG(event)
    default:
        break
    }
}

var fallbackInstalled = false

/// 安装 NSEvent 全局/本地监听兜底（CGEventTap 不可用时）
func installNSEventFallback() {
    if fallbackInstalled { return }
    fallbackInstalled = true
    let masked: NSEvent.EventTypeMask = [.keyDown, .leftMouseDown, .leftMouseUp, .leftMouseDragged]
    NSEvent.addGlobalMonitorForEvents(matching: masked) { e in
        eventChannelActive = true
        if e.type == .keyDown {
            handleKey(e)
        } else {
            // NSEvent.mouseLocation 是左下原点 → 转左上原点
            let p = nsToTopLeft(NSEvent.mouseLocation)
            switch e.type {
            case .leftMouseDown: handleMouse(.down, at: p)
            case .leftMouseDragged: handleMouse(.dragged, at: p)
            case .leftMouseUp: handleMouse(.up, at: p)
            default: break
            }
        }
    }
    NSEvent.addLocalMonitorForEvents(matching: masked) { e in
        eventChannelActive = true
        if e.type != .keyDown {
            let p = nsToTopLeft(NSEvent.mouseLocation)
            switch e.type {
            case .leftMouseDown: handleMouse(.down, at: p)
            case .leftMouseDragged: handleMouse(.dragged, at: p)
            case .leftMouseUp: handleMouse(.up, at: p)
            default: break
            }
        } else {
            handleKey(e)
        }
        return e
    }
}

func setupMonitors() {
    // 主通道：CGEventTap（鼠标 + 键盘）；失败则 NSEvent 全局监听兜底
    let tapOK = setupEventTap()
    eventChannelActive = eventChannelActive || tapOK

    if !tapOK {
        installNSEventFallback()
        return
    }
    // 健康检查：tap 创建成功 ≠ 真能收到事件（登录早期/权限边缘态会出现）。
    // 启动 8s 后若一个事件都没收到，补装 NSEvent 兜底（重复事件由去抖吸收）。
    DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
        if !receivedAnyEvent {
            emit(["type": "log", "message": "CGEventTap 创建成功但 8s 内未收到任何事件，启用 NSEvent 兜底"])
            installNSEventFallback()
        }
    }
}

var captureToken = 0
let captureQueue = DispatchQueue(label: "helper.capture")

func scheduleCapture(delay: TimeInterval, trigger: Trigger = .mouse) {
    captureToken += 1
    let token = captureToken
    captureQueue.asyncAfter(deadline: .now() + delay) {
        guard token == captureToken else { return }
        captureSelection(trigger: trigger)
    }
}

// MARK: - 通道 2：轮询（纯 AX，无副作用）

var pollPrev = ""
var pollStable = 0
var pollLastEmitted = ""

func pollTick() {
    guard AXIsProcessTrusted() else { return }
    if let front = frontmostApp(), ignorePids.contains(front.processIdentifier) { return }

    let current = axSelectedText()?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if current.isEmpty {
        if !pollLastEmitted.isEmpty {
            pollLastEmitted = ""
            lastReported = ""
            emit(["type": "cleared"])
        }
        pollPrev = ""
        pollStable = 0
        return
    }
    if current == pollPrev { pollStable += 1 } else { pollPrev = current; pollStable = 1 }
    guard pollStable >= 2, current != pollLastEmitted, current.count >= minSelectionLength else { return }

    pollLastEmitted = current
    lastReported = current
    lastReportedAt = Date()
    // 轮询是兜底通道：鼠标位置通常已不在选区上，用键盘策略（元素顶部）更稳
    let (x, y, h) = anchorPosition(trigger: .keyboard)
    emitSelection(current, x: x, y: y, h: h, app: frontmostAppName(), via: "ax")
}

func startPolling() {
    let timer = Timer(timeInterval: pollInterval, repeats: true) { _ in
        captureQueue.async { pollTick() }
    }
    RunLoop.main.add(timer, forMode: .common)
}

// MARK: - stdin

func setupStdinLoop() {
    DispatchQueue.global(qos: .userInitiated).async {
        while true {
            guard let line = readLine(strippingNewline: true) else { exit(0) }
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            guard let data = trimmed.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = obj["type"] as? String else { continue }
            switch type {
            case "capture":
                captureQueue.async { captureSelection(force: true, trigger: .manual) }
            case "region-select":
                DispatchQueue.main.async { beginRegionSelect() }
            case "region-abort":
                // main 侧超时/中止框选（如 Esc 由渲染层捕获、或 selectRegion 超时）
                // 必须让 helper 退出 region 模式，否则后续鼠标拖拽会被当作框选吞掉，
                // 表现为「划词整体失效」。
                DispatchQueue.main.async {
                    if regionSelectActive { endRegionSelect(rect: nil) }
                }
            case "ocr":
                // 区域截屏 + OCR。参数：x, y, w, h（屏幕绝对坐标，左上原点）
                let rect: CGRect? = {
                    guard let x = obj["x"] as? Double, let y = obj["y"] as? Double,
                          let w = obj["w"] as? Double, let h = obj["h"] as? Double, w > 4, h > 4
                    else { return nil }
                    return CGRect(x: x, y: y, width: w, height: h)
                }()
                let langs = (obj["langs"] as? [String]) ?? ["zh-Hans", "en-US"]
                let result = ScreenOCR.run(rect: rect, languages: langs)
                emit(["type": "ocr", "payload": result])
            case "ping":
                emit(["type": "pong"])
            case "quit":
                exit(0)
            default:
                break
            }
        }
    }
}

// MARK: - 入口

func parseArgs() {
    var i = 1
    let args = CommandLine.arguments
    while i < args.count {
        if args[i] == "--ignore-pid", i + 1 < args.count, let p = pid_t(args[i + 1]) {
            ignorePids.insert(p)
            i += 2
            continue
        }
        if args[i] == "--force-clipboard" { forceClipboard = true }
        if args[i] == "--request-permissions" { requestPermissionsOnStart = true }
        if args[i] == "--check-permissions" { checkPermissionsOnly = true }
        i += 1
    }
}

/// 由宿主 app 传入：启动时主动请求缺失的权限（弹系统对话框 + 注册到设置列表）
var requestPermissionsOnStart = false

/// 一次性权限探测模式：打印三项权限的实时状态后立即退出。
/// 用途：CGPreflightListenEventAccess / CGPreflightScreenCaptureAccess 的结果
/// 在进程内被缓存（实测：用户在设置里新授权后，旧进程永远读到 false），
/// 因此宿主 app 必须用新进程探测，发现授权后自动重启长驻 helper 使其生效。
var checkPermissionsOnly = false
// MARK: - 入口
//
// 多文件编译时 Swift 不允许顶层可执行语句，因此包一层 @main。
// 单文件编译（swiftc 单文件）时 @main 也能正常工作。

@main
struct SelectionHelperMain {
    static func main() {
        parseArgs()
        // 一次性探测：不走常驻流程，打印后立刻退出（见 checkPermissionsOnly 注释）
        if checkPermissionsOnly {
            let a = ensureAccessibility()
            let i = hasInputMonitoring()
            let s = hasScreenRecording()
            emit([
                "type": "perms",
                "accessibilityTrusted": a,
                "inputMonitoring": i,
                "screenRecording": s,
                "pid": ProcessInfo.processInfo.processIdentifier,
            ])
            // emit 是异步写 stdout，等待写入完成再退出
            outQueue.sync {}
            exit(0)
        }
        let trusted = ensureAccessibility()
        let inputMon = hasInputMonitoring()
        let screenRec = hasScreenRecording()
        setupMonitors()
        startPolling()
        setupStdinLoop()
        emit([
            "type": "ready",
            "accessibilityTrusted": trusted,
            "inputMonitoring": inputMon,
            "screenRecording": screenRec,
            "pid": ProcessInfo.processInfo.processIdentifier,
        ])
        // 宿主要求时主动请求缺失权限（默认行为，见 main.ts）
        if requestPermissionsOnStart && (!trusted || !inputMon || !screenRec) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                requestPermissions(ax: true, input: true, screen: true)
            }
        }
        startPermissionMonitor()
        RunLoop.main.run()
    }
}

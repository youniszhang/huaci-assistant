// SelectionHelper（Windows）— 系统级划词捕获助手
//
// 目标：在任何 Windows 应用里检测「划词」动作并读到选中文本。
// 与 macOS 版（swift/SelectionHelper.swift）保持**完全相同的 JSON-lines 协议**，
// 因此 Electron 主进程（src/main/capture.ts）无需区分平台即可驱动。
//
// 现实约束（与 macOS 类似，但 Windows 的坑不同）：
//   • 原生应用 / WPF / WinForms / UWP：UI Automation 的 TextPattern 直接暴露
//     GetSelection() → 轮询即可
//   • Chromium 系（Chrome / Obsidian / VS Code）：UIA 树里通常拿不到选区文本
//     （Chrome 对 UIA 的支持有限）→ 只能靠 Ctrl+C；绝不能高频调用
//     （会污染剪贴板、打断用户）
//
// 因此采用「事件驱动」为主、轮询为辅：
//   1) 事件通道：低级鼠标钩子（WH_MOUSE_LL）检测拖拽结束 / 双击选词，
//      低级键盘钩子（WH_KEYBOARD_LL）检测 Ctrl+A / Shift+方向键
//      → 触发一次取词：先 UIA，失败则 Ctrl+C（读后还原剪贴板）
//   2) 轮询通道：只读 UIA，不产生任何副作用，兜住事件通道漏掉的场景
//
// 协议（JSON lines，UTF-8）：
//   stdout ↑  {"type":"ready","accessibilityTrusted":bool,"inputMonitoring":bool,"screenRecording":bool,"pid":n}
//             {"type":"selection","ok":true,"text":"...","x":n,"y":n,"h":n,"app":"Chrome","via":"uia|clipboard"}
//             {"type":"selection","ok":false,"reason":"no-selection"}
//             {"type":"cleared"}
//             {"type":"click","x":n,"y":n}
//             {"type":"ocr","payload":"{...}"}
//             {"type":"region-begin"} / {"type":"region-update","x":..,"y":..,"w":..,"h":..} / {"type":"region","x":..}
//             {"type":"region-cancel"}
//             {"type":"perms","accessibilityTrusted":bool,...}
//             {"type":"pong"}
//   stdin  ↓  {"type":"capture"}        立即取词（强制，忽略去抖）
//             {"type":"region-select"}  进入框选模式
//             {"type":"region-abort"}   退出框选
//             {"type":"ocr","x":..,"y":..,"w":..,"h":..,"langs":[..]}
//             {"type":"ping"} / {"type":"quit"}
//
// 坐标约定：与 macOS 版一致，统一为**屏幕左上原点**的物理像素。
//   Windows 的 UIA 返回物理像素（左上原点），与 Electron 的 setBounds 一致，
//   无需像 macOS 那样做坐标翻转 —— 这是两个平台的主要差异之一。

using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Automation;

namespace SelectionHelper;

internal static class Program
{
    // ---------------------------------------------------------------- 常量

    /// 划词动作到取词的稳定延迟（等应用把选区提交到 UIA/剪贴板）
    private const int SelectionSettleMs = 80;
    /// 轮询间隔（兜底通道）
    private const int PollIntervalMs = 400;
    /// 同一段文本的重复上报抑制窗口
    private const int RepeatSuppressMs = 1500;
    /// 过短视为误触
    private const int MinSelectionLength = 2;
    /// Ctrl+C 后等待剪贴板更新的上限
    private const int ClipboardWaitMs = 450;

    /// 这些进程里 Ctrl+C 是中断信号，绝不能用它取词
    private static readonly HashSet<string> TermProcessNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "WindowsTerminal", "wt", "conhost", "cmd", "powershell", "pwsh",
        "mintty", "alacritty", "wezterm-gui", "Hyper", "ConEmu64", "ConEmu",
    };

    // ---------------------------------------------------------------- 状态

    /// 宿主应用 PID（忽略它们窗口里的选区）
    private static readonly HashSet<uint> IgnorePids = new();
    /// 事件通道是否已激活（钩子安装成功）
    private static bool _eventChannelActive;
    /// 强制走剪贴板通道（--force-clipboard）
    private static bool _forceClipboard;
    /// 启动时主动请求权限
    private static bool _requestPermissionsOnStart;
    /// 一次性权限探测模式
    private static bool _checkPermissionsOnly;

    private static string _lastReported = "";
    private static DateTime _lastReportedAt = DateTime.MinValue;
    private static string _pollLastEmitted = "";

    /// 鼠标状态（拖拽检测）
    private static Point _mouseDownPoint;
    private static DateTime _mouseDownAt = DateTime.MinValue;
    private static bool _isDragging;
    private static DateTime _lastClickAt = DateTime.MinValue;
    private static Point _lastClickPoint;

    /// 选区可能已清空的判定窗口（用于上报 cleared）
    private static DateTime _lastSelectionAt = DateTime.MinValue;
    private static bool _hadSelection;

    /// 框选模式
    private static bool _regionSelectActive;
    private static Point _regionStart;
    private static bool _regionDragging;

    /// stdout 写入锁（多线程 emit）
    private static readonly object OutLock = new();

    // ---------------------------------------------------------------- 入口

    private static void Main(string[] args)
    {
        ParseArgs(args);
        Console.OutputEncoding = Encoding.UTF8;
        Console.InputEncoding = Encoding.UTF8;

        if (_checkPermissionsOnly)
        {
            Emit(new Dictionary<string, object?>
            {
                ["type"] = "perms",
                ["accessibilityTrusted"] = HasAccessibility(),
                ["inputMonitoring"] = _eventChannelActive,
                ["screenRecording"] = HasScreenRecording(),
                ["pid"] = Environment.ProcessId,
            });
            return;
        }

        SetupHooks();
        StartPolling();
        StartStdinLoop();

        Emit(new Dictionary<string, object?>
        {
            ["type"] = "ready",
            ["accessibilityTrusted"] = HasAccessibility(),
            ["inputMonitoring"] = _eventChannelActive,
            ["screenRecording"] = HasScreenRecording(),
            ["pid"] = Environment.ProcessId,
        });

        if (_requestPermissionsOnStart)
        {
            // Windows 没有「一键弹窗授权」的统一入口：辅助功能（UIA）通常开箱可用，
            // 屏幕录制（截图）在部分应用/受保护内容上受限。这里只做提示，不阻断。
            Thread.Sleep(500);
        }

        // 阻塞主线程（钩子需要消息循环；钩子是全局的，此处仅保持进程存活）
        Thread.Sleep(Timeout.Infinite);
    }

    private static void ParseArgs(string[] args)
    {
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--ignore-pid" when i + 1 < args.Length && uint.TryParse(args[i + 1], out var pid):
                    IgnorePids.Add(pid);
                    i++;
                    break;
                case "--force-clipboard":
                    _forceClipboard = true;
                    break;
                case "--request-permissions":
                    _requestPermissionsOnStart = true;
                    break;
                case "--check-permissions":
                    _checkPermissionsOnly = true;
                    break;
            }
        }
    }

    // ---------------------------------------------------------------- 协议输出

    private static void Emit(Dictionary<string, object?> obj)
    {
        var json = JsonSerializer.Serialize(obj, new JsonSerializerOptions
        {
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        });
        lock (OutLock)
        {
            Console.Out.Write(json);
            Console.Out.Write('\n');
            Console.Out.Flush();
        }
    }

    private static void EmitSelection(string text, int x, int y, int h, string app, string via)
    {
        Emit(new Dictionary<string, object?>
        {
            ["type"] = "selection",
            ["ok"] = true,
            ["text"] = text,
            ["x"] = x,
            ["y"] = y,
            ["h"] = h,
            ["app"] = app,
            ["via"] = via,
        });
        _lastSelectionAt = DateTime.UtcNow;
        _hadSelection = true;
    }

    private static void EmitNoSelection(string reason)
    {
        Emit(new Dictionary<string, object?> { ["type"] = "selection", ["ok"] = false, ["reason"] = reason });
    }

    private static void EmitCleared()
    {
        Emit(new Dictionary<string, object?> { ["type"] = "cleared" });
        _hadSelection = false;
    }

    // ---------------------------------------------------------------- stdin 命令

    private static void StartStdinLoop()
    {
        var t = new Thread(() =>
        {
            while (true)
            {
                var line = Console.In.ReadLine();
                if (line == null) Environment.Exit(0);
                line = line.Trim();
                if (line.Length == 0) continue;
                Dictionary<string, JsonElement>? obj;
                try
                {
                    obj = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(line);
                }
                catch
                {
                    continue;
                }
                if (obj == null || !obj.TryGetValue("type", out var typeEl)) continue;
                var type = typeEl.GetString();
                switch (type)
                {
                    case "capture":
                        Task.Run(() => CaptureSelection(force: true, trigger: Trigger.Manual));
                        break;
                    case "region-select":
                        BeginRegionSelect();
                        break;
                    case "region-abort":
                        // 主进程超时/中止框选：必须退出 region 模式，
                        // 否则后续鼠标拖拽会被当作框选吞掉（表现为「划词整体失效」）
                        if (_regionSelectActive) EndRegionSelect(null);
                        break;
                    case "ocr":
                        Task.Run(() => HandleOcr(obj));
                        break;
                    case "ping":
                        Emit(new Dictionary<string, object?> { ["type"] = "pong" });
                        break;
                    case "quit":
                        Environment.Exit(0);
                        break;
                }
            }
        })
        { IsBackground = true };
        t.Start();
    }

    // ---------------------------------------------------------------- 取词主流程

    private enum Trigger { Mouse, Keyboard, Manual }

    /// 取词并上报。force=true 时忽略去抖（快捷键/手动触发）
    private static void CaptureSelection(bool force = false, Trigger trigger = Trigger.Mouse)
    {
        var app = FrontmostAppName();
        var pid = FrontmostPid();
        // 忽略宿主应用自身窗口里的选区（与 macOS 版 --ignore-pid 行为一致）
        if (pid != 0 && IgnorePids.Contains(pid)) return;

        string? text = null;
        var via = "uia";
        if (!_forceClipboard)
        {
            text = UiaSelectedText();
        }
        if (text == null)
        {
            text = ClipboardSelectedText(pid);
            via = "clipboard";
        }
        if (text == null)
        {
            if (force) EmitNoSelection("no-selection");
            return;
        }

        var trimmed = text.Trim();
        if (trimmed.Length < MinSelectionLength) return;

        var now = DateTime.UtcNow;
        if (!force && trimmed == _lastReported && (now - _lastReportedAt).TotalMilliseconds < RepeatSuppressMs)
        {
            return;
        }
        _lastReported = trimmed;
        _lastReportedAt = now;
        _pollLastEmitted = trimmed;

        var (x, y, h) = AnchorPosition(trigger);
        EmitSelection(trimmed, x, y, h, app, via);
    }

    /// 选区锚点（左上原点，物理像素）。返回 (x, y, h)：
    ///   x = 水平锚点；y = 垂直锚点（工具条摆在此位置下方，放不下则上方）；h = 锚点高度
    ///
    /// 策略（与 macOS 版一致）：
    ///   • 鼠标触发 → 紧贴鼠标（用户视线在此，且元素可能极大）
    ///   • 键盘触发 → 元素底部居中；元素过大（整页文本区）则退回鼠标位置
    private static (int x, int y, int h) AnchorPosition(Trigger trigger)
    {
        var (mx, my) = MouseLocation();
        if (trigger is Trigger.Mouse or Trigger.Manual) return (mx, my, 0);

        var rect = FocusedElementRect();
        if (rect == null) return (mx, my, 0);

        var elemW = rect.Value.Width;
        var elemH = rect.Value.Height;
        // 元素过大（横跨半屏或纵跨半屏）→ 锚点用鼠标位置更贴近用户操作处
        if (elemW > 1200 || elemH > 600) return (mx, my, 0);

        var anchorW = Math.Clamp(elemW, 40, 700);
        return (rect.Value.X + anchorW / 2, rect.Value.Y + elemH, 0);
    }

    // ---------------------------------------------------------------- UI Automation 读取

    /// 前台窗口的 UIA 元素（用于找选区与元素位置）
    private static AutomationElement? FocusedElement()
    {
        try
        {
            var hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return null;
            return AutomationElement.FromHandle(hwnd);
        }
        catch
        {
            return null;
        }
    }

    /// 读选中文本：先看焦点元素，再向下浅层探测
    private static string? UiaSelectedText()
    {
        try
        {
            var root = FocusedElement();
            if (root == null) return null;

            // 1) 焦点元素
            var focused = AutomationElement.FocusedElement;
            if (focused != null)
            {
                var s = ReadSelection(focused);
                if (s != null) return s;
            }

            // 2) 从根向下浅层探测（深度 3，避免性能问题）
            return SearchSelection(root, 0);
        }
        catch
        {
            return null;
        }
    }

    private static string? ReadSelection(AutomationElement el)
    {
        try
        {
            if (!el.TryGetCurrentPattern(TextPattern.Pattern, out var pat)) return null;
            var ranges = ((TextPattern)pat).GetSelection();
            if (ranges == null || ranges.Length == 0) return null;
            var sb = new StringBuilder();
            foreach (var r in ranges) sb.Append(r.GetText(-1));
            var s = sb.ToString().Trim();
            return s.Length == 0 ? null : s;
        }
        catch
        {
            return null;
        }
    }

    private static string? SearchSelection(AutomationElement el, int depth)
    {
        if (depth >= 3) return null;
        try
        {
            var children = el.FindAll(TreeScope.Children, Condition.TrueCondition);
            var count = Math.Min(children.Count, 25);
            for (var i = 0; i < count; i++)
            {
                var s = ReadSelection(children[i]);
                if (s != null) return s;
            }
            var deeper = Math.Min(children.Count, 10);
            for (var i = 0; i < deeper; i++)
            {
                var s = SearchSelection(children[i], depth + 1);
                if (s != null) return s;
            }
        }
        catch
        {
            // 元素树遍历失败（权限/时序）时忽略
        }
        return null;
    }

    /// 焦点元素的屏幕矩形（物理像素，左上原点）
    private static Rectangle? FocusedElementRect()
    {
        try
        {
            var el = AutomationElement.FocusedElement ?? FocusedElement();
            if (el == null) return null;
            var r = el.Current.BoundingRectangle;
            if (r.IsEmpty || r.Width <= 0 || r.Height <= 0) return null;
            return new Rectangle((int)r.X, (int)r.Y, (int)r.Width, (int)r.Height);
        }
        catch
        {
            return null;
        }
    }

    // ---------------------------------------------------------------- Ctrl+C 取词（读后还原剪贴板）

    private static string? ClipboardSelectedText(uint pid)
    {
        // 终端类应用里 Ctrl+C 是中断信号，绝不能用
        var name = ProcessNameOf(pid);
        if (name != null && TermProcessNames.Contains(name)) return null;

        string? saved = null;
        var hadText = false;
        try
        {
            if (Clipboard.ContainsText())
            {
                saved = Clipboard.GetText();
                hadText = true;
            }
        }
        catch
        {
            // 剪贴板被其它进程占用时忽略
        }

        // 发送 Ctrl+C
        SendCtrlC();

        // 轮询剪贴板变化
        string? copied = null;
        var deadline = Environment.TickCount64 + ClipboardWaitMs;
        while (Environment.TickCount64 < deadline)
        {
            Thread.Sleep(18);
            try
            {
                if (!Clipboard.ContainsText()) continue;
                var cur = Clipboard.GetText();
                // 与保存值不同 → 说明复制成功
                if (!hadText || cur != saved)
                {
                    Thread.Sleep(35);
                    copied = cur;
                    break;
                }
            }
            catch
            {
                // 剪贴板竞争，继续等
            }
        }

        // 还原剪贴板（仅当确实被改动）
        if (copied != null && hadText && saved != null)
        {
            try
            {
                Clipboard.SetText(saved);
            }
            catch
            {
                // 还原失败不影响取词结果
            }
        }

        return string.IsNullOrWhiteSpace(copied) ? null : copied;
    }

    private static void SendCtrlC()
    {
        const byte VK_CONTROL = 0x11;
        const byte VK_C = 0x43;
        const uint KEYEVENTF_KEYUP = 0x0002;
        keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
        Thread.Sleep(8);
        keybd_event(VK_C, 0, 0, UIntPtr.Zero);
        Thread.Sleep(18);
        keybd_event(VK_C, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        Thread.Sleep(8);
        keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    // ---------------------------------------------------------------- 轮询（兜底通道）

    private static void StartPolling()
    {
        var t = new Thread(() =>
        {
            while (true)
            {
                Thread.Sleep(PollIntervalMs);
                try
                {
                    PollTick();
                }
                catch
                {
                    // 轮询异常不影响主流程
                }
            }
        })
        { IsBackground = true };
        t.Start();
    }

    private static void PollTick()
    {
        var pid = FrontmostPid();
        if (pid != 0 && IgnorePids.Contains(pid)) return;

        var current = UiaSelectedText();
        if (current == null || current.Trim().Length < MinSelectionLength)
        {
            // 选区消失 → 通知主进程收起工具条（与 macOS 版 cleared 语义一致）
            if (_hadSelection && (DateTime.UtcNow - _lastSelectionAt).TotalMilliseconds > 600)
            {
                EmitCleared();
            }
            _pollLastEmitted = "";
            return;
        }

        var trimmed = current.Trim();
        if (trimmed == _pollLastEmitted) return;
        if (trimmed == _lastReported && (DateTime.UtcNow - _lastReportedAt).TotalMilliseconds < RepeatSuppressMs) return;

        _pollLastEmitted = trimmed;
        _lastReported = trimmed;
        _lastReportedAt = DateTime.UtcNow;
        // 轮询是兜底通道：鼠标通常已不在选区上，用键盘策略（元素顶部）更稳
        var (x, y, h) = AnchorPosition(Trigger.Keyboard);
        EmitSelection(trimmed, x, y, h, FrontmostAppName(), "uia");
    }

    // ---------------------------------------------------------------- 钩子（事件通道）

    private static void SetupHooks()
    {
        try
        {
            _mouseHookProc = MouseHookCallback;
            _mouseHook = SetWindowsHookEx(WH_MOUSE_LL, _mouseHookProc, GetModuleHandle(null), 0);
            _keyboardHookProc = KeyboardHookCallback;
            _keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, _keyboardHookProc, GetModuleHandle(null), 0);
            _eventChannelActive = _mouseHook != IntPtr.Zero || _keyboardHook != IntPtr.Zero;
            // 钩子回调需要消息循环才能被派发（低级钩子由安装线程的队列驱动）
            var t = new Thread(() =>
            {
                while (true)
                {
                    if (GetMessage(out var msg, IntPtr.Zero, 0, 0) == 0) break;
                    TranslateMessage(ref msg);
                    DispatchMessage(ref msg);
                }
            })
            { IsBackground = true };
            t.Start();
        }
        catch
        {
            _eventChannelActive = false;
        }
    }

    private static IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var info = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
            var msg = wParam.ToInt32();
            switch (msg)
            {
                case WM_LBUTTONDOWN:
                    _mouseDownPoint = new Point(info.pt.X, info.pt.Y);
                    _mouseDownAt = DateTime.UtcNow;
                    _isDragging = false;
                    break;
                case WM_MOUSEMOVE:
                    if (!_isDragging && _mouseDownAt != DateTime.MinValue)
                    {
                        var dx = Math.Abs(info.pt.X - _mouseDownPoint.X);
                        var dy = Math.Abs(info.pt.Y - _mouseDownPoint.Y);
                        if (dx > 4 || dy > 4) _isDragging = true;
                    }
                    break;
                case WM_LBUTTONUP:
                    HandleMouseUp(new Point(info.pt.X, info.pt.Y));
                    break;
            }
        }
        return CallNextHookEx(_mouseHook, nCode, wParam, lParam);
    }

    private static void HandleMouseUp(Point pt)
    {
        var now = DateTime.UtcNow;
        var isDrag = _isDragging;
        var downAt = _mouseDownAt;
        _mouseDownAt = DateTime.MinValue;
        _isDragging = false;

        if (_regionSelectActive)
        {
            // 框选模式：把这次拖拽当作选区
            _regionDragging = false;
            var rect = NormalizeRect(_regionStart, pt);
            if (rect.Width > 4 && rect.Height > 4)
            {
                EndRegionSelect(rect);
            }
            else
            {
                EndRegionSelect(null);
            }
            return;
        }

        // 双击选词：两次点击在 500ms、8px 内
        var isDoubleClick = (now - _lastClickAt).TotalMilliseconds < 500 &&
                            Math.Abs(pt.X - _lastClickPoint.X) < 8 &&
                            Math.Abs(pt.Y - _lastClickPoint.Y) < 8;
        _lastClickAt = now;
        _lastClickPoint = pt;

        if (isDrag || isDoubleClick)
        {
            // 等应用把选区提交出来再取词
            Task.Run(() =>
            {
                Thread.Sleep(SelectionSettleMs);
                CaptureSelection(trigger: Trigger.Mouse);
            });
        }
        else
        {
            // 无拖拽的短点击 → 上报 click（主进程据此收起工具条）
            Emit(new Dictionary<string, object?> { ["type"] = "click", ["x"] = pt.X, ["y"] = pt.Y });
        }
    }

    private static IntPtr KeyboardHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var info = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            var msg = wParam.ToInt32();
            if (msg is WM_KEYDOWN or WM_SYSKEYDOWN)
            {
                HandleKeyDown(info);
            }
        }
        return CallNextHookEx(_keyboardHook, nCode, wParam, lParam);
    }

    private static void HandleKeyDown(KBDLLHOOKSTRUCT info)
    {
        // 框选模式：Esc 取消
        if (_regionSelectActive && info.vkCode == VK_ESCAPE)
        {
            EndRegionSelect(null);
            return;
        }

        var ctrl = (info.flags & LLKHF_ALTDOWN) == 0 && IsKeyDown(VK_CONTROL);
        var shift = IsKeyDown(VK_SHIFT);

        // Ctrl+A：全选
        if (ctrl && info.vkCode == VK_A)
        {
            Task.Run(() =>
            {
                Thread.Sleep(SelectionSettleMs);
                CaptureSelection(trigger: Trigger.Keyboard);
            });
            return;
        }

        // Shift+方向键：扩展选择
        if (shift && info.vkCode is VK_LEFT or VK_RIGHT or VK_UP or VK_DOWN)
        {
            Task.Run(() =>
            {
                Thread.Sleep(SelectionSettleMs);
                CaptureSelection(trigger: Trigger.Keyboard);
            });
        }
    }

    private static bool IsKeyDown(int vk)
    {
        return (GetAsyncKeyState(vk) & 0x8000) != 0;
    }

    // ---------------------------------------------------------------- 框选（区域选择）

    private static void BeginRegionSelect()
    {
        _regionSelectActive = true;
        _regionDragging = false;
        Emit(new Dictionary<string, object?> { ["type"] = "region-begin" });
    }

    private static void EndRegionSelect(Rectangle? rect)
    {
        _regionSelectActive = false;
        if (rect == null)
        {
            Emit(new Dictionary<string, object?> { ["type"] = "region-cancel" });
            return;
        }
        Emit(new Dictionary<string, object?>
        {
            ["type"] = "region",
            ["x"] = rect.Value.X,
            ["y"] = rect.Value.Y,
            ["w"] = rect.Value.Width,
            ["h"] = rect.Value.Height,
        });
    }

    private static Rectangle NormalizeRect(Point a, Point b)
    {
        var x = Math.Min(a.X, b.X);
        var y = Math.Min(a.Y, b.Y);
        return new Rectangle(x, y, Math.Abs(b.X - a.X), Math.Abs(b.Y - a.Y));
    }

    // ---------------------------------------------------------------- OCR（Windows.Media.Ocr）

    private static void HandleOcr(Dictionary<string, JsonElement> obj)
    {
        Rectangle? rect = null;
        if (obj.TryGetValue("x", out var xEl) && obj.TryGetValue("y", out var yEl) &&
            obj.TryGetValue("w", out var wEl) && obj.TryGetValue("h", out var hEl) &&
            wEl.GetInt32() > 4 && hEl.GetInt32() > 4)
        {
            rect = new Rectangle(xEl.GetInt32(), yEl.GetInt32(), wEl.GetInt32(), hEl.GetInt32());
        }

        var result = ScreenOcr.Run(rect);
        Emit(new Dictionary<string, object?> { ["type"] = "ocr", ["payload"] = result });
    }

    // ---------------------------------------------------------------- 权限探测

    /// Windows 没有「辅助功能」这种显式授权；UIA 在普通桌面应用上开箱可用。
    /// 这里返回 true 表示"可尝试读取"，真实可用性由取词结果体现。
    private static bool HasAccessibility() => true;

    /// 屏幕录制：Windows 没有系统级开关；受保护内容（DRM/部分 UWP）截不到。
    private static bool HasScreenRecording() => true;

    // ---------------------------------------------------------------- 前台应用信息

    private static uint FrontmostPid()
    {
        try
        {
            var hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return 0;
            GetWindowThreadProcessId(hwnd, out var pid);
            return pid;
        }
        catch
        {
            return 0;
        }
    }

    private static string FrontmostAppName()
    {
        try
        {
            var pid = FrontmostPid();
            if (pid == 0) return "";
            using var p = Process.GetProcessById((int)pid);
            return p.ProcessName;
        }
        catch
        {
            return "";
        }
    }

    private static string? ProcessNameOf(uint pid)
    {
        try
        {
            using var p = Process.GetProcessById((int)pid);
            return p.ProcessName;
        }
        catch
        {
            return null;
        }
    }

    /// 鼠标位置（屏幕左上原点，物理像素）
    private static (int x, int y) MouseLocation()
    {
        return GetCursorPos(out var pt) ? (pt.X, pt.Y) : (0, 0);
    }

    // ---------------------------------------------------------------- Win32 互操作

    private const int WH_MOUSE_LL = 14;
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_MOUSEMOVE = 0x0200;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int LLKHF_ALTDOWN = 0x20;
    private const byte VK_ESCAPE = 0x1B;
    private const byte VK_CONTROL = 0x11;
    private const byte VK_SHIFT = 0x10;
    private const byte VK_A = 0x41;
    private const byte VK_LEFT = 0x25;
    private const byte VK_UP = 0x26;
    private const byte VK_RIGHT = 0x27;
    private const byte VK_DOWN = 0x28;

    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
    private static HookProc? _mouseHookProc;
    private static HookProc? _keyboardHookProc;
    private static IntPtr _mouseHook = IntPtr.Zero;
    private static IntPtr _keyboardHook = IntPtr.Zero;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    [DllImport("user32.dll")]
    private static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}

/**
 * ScreenOCR —— 区域截屏 + Vision 文字识别（macOS 原生，无需联网/依赖）
 *
 * 用途：聊天场景下读取消息内容（微信等自定义 UI 应用不暴露 AX 文本）
 *
 * 输出（JSON）：
 *   { text, lines: [{text, confidence, x, y, w, h}], count, durationMs }
 *   x/y/w/h 为**屏幕绝对坐标**（左上原点，与 Electron setBounds 一致）
 */

import AppKit
import Foundation
import Vision
import ScreenCaptureKit

enum ScreenOCR {
    struct Line {
        let text: String
        let confidence: Double
        /// 屏幕绝对坐标（左上原点）
        let x: CGFloat
        let y: CGFloat
        let w: CGFloat
        let h: CGFloat
    }

    /// 截取屏幕区域（左上原点坐标）。rect 为空则全区。
    ///
    /// macOS 14+ 必须用 ScreenCaptureKit：macOS 15 中旧的 CGWindowListCreateImage
    /// 被标记 obsoleted，实际走 replayd 兼容层，未应答授权弹窗时 30s 超时返回空图
    /// （实测 2026-10-09：同区域 SCScreenshotManager 60ms 成功）。
    /// macOS 13 回退旧 API（该版本上它仍直接可用）。
    static func captureScreen(rect: CGRect?) -> CGImage? {
        if #available(macOS 14.0, *) {
            return captureViaSCK(rect: rect)
        }
        if let r = rect {
            return CGWindowListCreateImage(r, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution])
        }
        return CGWindowListCreateImage(.infinite, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution])
    }

    @available(macOS 14.0, *)
    private static func captureViaSCK(rect: CGRect?) -> CGImage? {
        let sem = DispatchSemaphore(value: 0)
        var result: CGImage?
        var failed = false

        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, _ in
            guard let content, !content.displays.isEmpty else {
                failed = true
                sem.signal()
                return
            }
            // 目标区域中心决定用哪块屏（全局左上原点坐标，与 CGDisplayBounds 一致）
            let center = rect.map { CGPoint(x: $0.midX, y: $0.midY) }
            let display = content.displays.first(where: { d in
                guard let c = center else { return false }
                return CGDisplayBounds(d.displayID).contains(c)
            }) ?? content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays[0]

            let dBounds = CGDisplayBounds(display.displayID)
            // 全局坐标 → 该屏局部坐标（sourceRect 相对 display）
            let local: CGRect
            if let r = rect {
                local = r.offsetBy(dx: -dBounds.origin.x, dy: -dBounds.origin.y)
            } else {
                local = CGRect(origin: .zero, size: dBounds.size)
            }

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let cfg = SCStreamConfiguration()
            cfg.sourceRect = local
            // 2x 采样（Retina），与旧 API .bestResolution 等价
            cfg.width = Int(local.width * 2)
            cfg.height = Int(local.height * 2)
            cfg.showsCursor = false
            cfg.captureResolution = .best
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { img, _ in
                result = img
                sem.signal()
            }
        }

        // OCR 是交互路径，超过 10s 视为失败（正常情况下 <500ms）
        if sem.wait(timeout: .now() + 10) == .timedOut || failed {
            return nil
        }
        // 调试：HUACI_OCR_DUMP=/path/prefix 时把截到的图存盘（排查空图问题）
        if let dump = ProcessInfo.processInfo.environment["HUACI_OCR_DUMP"], let img = result {
            let rep = NSBitmapImageRep(cgImage: img)
            if let d = rep.representation(using: .png, properties: [:]) {
                try? d.write(to: URL(fileURLWithPath: "\(dump).png"))
            }
        }
        return result
    }

    /// 识别图片中的文字。region 是图片在屏幕上的位置（用于换算绝对坐标）
    static func recognize(_ image: CGImage, region: CGRect, languages: [String]) -> [Line] {
        let request = VNRecognizeTextRequest()
        request.recognitionLanguages = languages
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        if #available(macOS 13.0, *) {
            request.revision = VNRecognizeTextRequestRevision3
        }

        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return []
        }

        let imgW = CGFloat(image.width)
        let imgH = CGFloat(image.height)
        // 图片实际像素与屏幕点的比例（Retina 屏 2x）
        let scaleX = region.width / imgW
        let scaleY = region.height / imgH

        var out: [Line] = []
        for obs in (request.results ?? []) {
            guard let top = obs.topCandidates(1).first else { continue }
            let bb = obs.boundingBox // 归一化，原点左下
            // 转成屏幕绝对坐标（左上原点）
            let sx = region.origin.x + bb.origin.x * region.width
            let sy = region.origin.y + (1 - bb.origin.y - bb.size.height) * region.height
            out.append(
                Line(
                    text: top.string,
                    confidence: Double(top.confidence),
                    x: sx,
                    y: sy,
                    w: bb.size.width * region.width,
                    h: bb.size.height * region.height
                )
            )
        }
        // 按阅读顺序排序（先上后下，同行按左到右）
        out.sort { a, b in
            if abs(a.y - b.y) > max(a.h, b.h) * 0.6 { return a.y < b.y }
            return a.x < b.x
        }
        _ = scaleX
        _ = scaleY
        return out
    }

    /// 把行合并成便于 LLM 阅读的文本（保留段落感）
    static func linesToText(_ lines: [Line]) -> String {
        var out: [String] = []
        var lastY: CGFloat = -1000
        var lastH: CGFloat = 0
        for l in lines {
            // 行间距大于 1.6 倍行高 → 认为换段
            if lastY > -999, l.y - lastY > max(l.h, lastH) * 1.7 {
                out.append("")
            }
            out.append(l.text)
            lastY = l.y
            lastH = l.h
        }
        return out.joined(separator: "\n")
    }

    /// 主入口：截屏 + 识别，返回 JSON 字符串
    static func run(rect: CGRect?, languages: [String]) -> String {
        let started = Date()
        guard let img = captureScreen(rect: rect) else {
            return errorJSON("截屏失败（可能缺少「屏幕录制」权限）")
        }
        let region = rect ?? CGRect(
            x: 0, y: 0,
            width: CGFloat(img.width) / 2, height: CGFloat(img.height) / 2
        )
        let lines = recognize(img, region: region, languages: languages)
        let text = linesToText(lines)
        let payload: [String: Any] = [
            "ok": true,
            "text": text,
            "count": lines.count,
            "durationMs": Int(Date().timeIntervalSince(started) * 1000),
            "lines": lines.map {
                [
                    "text": $0.text,
                    "confidence": $0.confidence,
                    "x": Double($0.x), "y": Double($0.y),
                    "w": Double($0.w), "h": Double($0.h),
                ] as [String: Any]
            },
        ]
        guard let d = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              let s = String(data: d, encoding: .utf8) else {
            return errorJSON("序列化失败")
        }
        return s
    }

    static func errorJSON(_ msg: String) -> String {
        let payload: [String: Any] = ["ok": false, "error": msg]
        if let d = try? JSONSerialization.data(withJSONObject: payload),
           let s = String(data: d, encoding: .utf8) {
            return s
        }
        return "{\"ok\":false,\"error\":\"unknown\"}"
    }
}

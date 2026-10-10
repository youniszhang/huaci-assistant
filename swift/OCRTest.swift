// OCRTest — 验证 macOS Vision 框架的中文识别能力
// 用法：OCRTest <图片路径> [语言代码，默认 zh-Hans+en-US]
// 输出：JSON { text, lines: [{text, confidence, box}], durationMs }

import AppKit
import Foundation
import Vision

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("用法: OCRTest <图片路径> [lang]\n".data(using: .utf8)!)
    exit(1)
}
let imagePath = args[1]
let langs: [String] = args.count > 2 ? args[2].split(separator: ",").map(String.init) : ["zh-Hans", "en-US"]

guard let image = NSImage(contentsOfFile: imagePath),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("无法读取图片: \(imagePath)\n".data(using: .utf8)!)
    exit(1)
}

let started = Date()

let request = VNRecognizeTextRequest { req, err in
    guard err == nil, let observations = req.results as? [VNRecognizedTextObservation] else {
        let msg = ["error": err?.localizedDescription ?? "no results"]
        if let d = try? JSONSerialization.data(withJSONObject: msg) {
            FileHandle.standardOutput.write(d)
        }
        exit(1)
    }

    var lines: [[String: Any]] = []
    var full: [String] = []
    for obs in observations {
        guard let top = obs.topCandidates(1).first else { continue }
        full.append(top.string)
        let bb = obs.boundingBox // 归一化坐标，原点左下
        lines.append([
            "text": top.string,
            "confidence": Double(top.confidence),
            "x": Double(bb.origin.x),
            "y": Double(bb.origin.y),
            "w": Double(bb.size.width),
            "h": Double(bb.size.height),
        ])
    }

    let out: [String: Any] = [
        "text": full.joined(separator: "\n"),
        "lines": lines,
        "count": lines.count,
        "durationMs": Int(Date().timeIntervalSince(started) * 1000),
    ]
    if let d = try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(d)
    }
    exit(0)
}

request.recognitionLanguages = langs
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write("OCR 失败: \(error)\n".data(using: .utf8)!)
    exit(1)
}

// ScreenOcr（Windows）— 区域截屏 + Windows.Media.Ocr 识别
//
// 与 macOS 版（swift/ScreenOCR.swift）输出**完全相同的 JSON 结构**，
// 供主进程统一解析（见 src/main/capture.ts 的 OcrResult）。
//
// 输出：
//   {
//     "ok": true,
//     "text": "识别到的文字（按行拼接）",
//     "count": 行数,
//     "durationMs": 耗时,
//     "lines": [{ "text": "...", "confidence": 1.0, "x": .., "y": .., "w": .., "h": .. }]
//   }
//
// 关于 confidence：Windows.Media.Ocr 不提供逐行置信度（API 限制），
// 统一填 1.0。macOS 版会给真实置信度 —— 主进程目前只用它做「识别质量提示」，
// 因此 Windows 上该提示会偏乐观，属已知差异。

using System.Drawing;
using System.Drawing.Imaging;
using System.Text.Json;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

namespace SelectionHelper;

internal static class ScreenOcr
{
    public static string Run(Rectangle? rect)
    {
        var started = Environment.TickCount64;
        try
        {
            // 1) 截屏（rect 为 null 则全屏；坐标是屏幕左上原点物理像素）
            using var bmp = CaptureScreen(rect);
            if (bmp == null)
            {
                return Error("截屏失败（可能受保护内容限制）", started);
            }

            // 2) 转成 WinRT SoftwareBitmap 后交给 OCR
            using var ms = new MemoryStream();
            bmp.Save(ms, ImageFormat.Png);
            ms.Position = 0;

            var text = Task.Run(() => RecognizeAsync(ms)).GetAwaiter().GetResult();
            if (text == null)
            {
                return Error("OCR 失败（未安装对应语言包或图像无法识别）", started);
            }

            var (fullText, lines) = text.Value;
            return JsonSerializer.Serialize(new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["text"] = fullText,
                ["count"] = lines.Count,
                ["durationMs"] = (int)(Environment.TickCount64 - started),
                ["lines"] = lines,
            }, JsonOpts);
        }
        catch (Exception ex)
        {
            return Error(ex.Message, started);
        }
    }

    private static string Error(string message, long started)
    {
        return JsonSerializer.Serialize(new Dictionary<string, object?>
        {
            ["ok"] = false,
            ["text"] = "",
            ["count"] = 0,
            ["durationMs"] = (int)(Environment.TickCount64 - started),
            ["lines"] = Array.Empty<object>(),
            ["error"] = message,
        }, JsonOpts);
    }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>截取屏幕区域（左上原点物理像素）。rect 为 null 时截全屏。</summary>
    private static Bitmap? CaptureScreen(Rectangle? rect)
    {
        var bounds = rect ?? new Rectangle(
            0, 0,
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN));

        if (bounds.Width <= 0 || bounds.Height <= 0) return null;

        var bmp = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(bmp);
        g.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
        return bmp;
    }

    /// <summary>
    /// 用 Windows.Media.Ocr 识别。
    /// 返回 (按行拼接的全文, 行信息列表)；失败返回 null。
    /// </summary>
    private static async Task<(string text, List<Dictionary<string, object?>> lines)?> RecognizeAsync(Stream png)
    {
        // Stream → WinRT RandomAccessStream
        var ras = new InMemoryRandomAccessStream();
        using (var input = png.AsRandomAccessStream())
        {
            await input.CopyToAsync(ras);
        }
        ras.Seek(0);

        var decoder = await BitmapDecoder.CreateAsync(ras);
        using var softwareBitmap = await decoder.GetSoftwareBitmapAsync();

        // 优先用简体中文引擎，失败则退回系统默认语言
        var engine = OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("zh-Hans"))
                     ?? OcrEngine.TryCreateFromUserProfileLanguages();
        if (engine == null) return null;

        var result = await engine.RecognizeAsync(softwareBitmap);

        var lines = new List<Dictionary<string, object?>>();
        var all = new List<string>();
        foreach (var line in result.Lines)
        {
            all.Add(line.Text);
            // Windows OCR 的 Words 带包围盒；按行取并集作为行框
            var minX = double.MaxValue;
            var minY = double.MaxValue;
            var maxX = double.MinValue;
            var maxY = double.MinValue;
            foreach (var word in line.Words)
            {
                var r = word.BoundingRect;
                minX = Math.Min(minX, r.X);
                minY = Math.Min(minY, r.Y);
                maxX = Math.Max(maxX, r.X + r.Width);
                maxY = Math.Max(maxY, r.Y + r.Height);
            }
            var hasBox = minX != double.MaxValue;
            lines.Add(new Dictionary<string, object?>
            {
                ["text"] = line.Text,
                // Windows.Media.Ocr 不提供逐行置信度，统一 1.0（见文件头说明）
                ["confidence"] = 1.0,
                ["x"] = hasBox ? (int)minX : 0,
                ["y"] = hasBox ? (int)minY : 0,
                ["w"] = hasBox ? (int)(maxX - minX) : 0,
                ["h"] = hasBox ? (int)(maxY - minY) : 0,
            });
        }

        return (string.Join("\n", all), lines);
    }

    private const int SM_CXVIRTUALSCREEN = 78;
    private const int SM_CYVIRTUALSCREEN = 79;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);
}

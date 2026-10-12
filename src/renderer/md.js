/**
 * 共享 Markdown → HTML 渲染器（悬浮卡片 / 主窗口历史详情共用）
 *
 * 支持：标题、列表、引用、代码块、行内代码 / 粗体 / 斜体 / 删除线 / 链接、
 *       分隔线、GFM 表格（| a | b | + |---|---|，含对齐标记）。
 */
(function () {
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /** 行首的空粗体前缀（LLM 常见输出瑕疵）清理 */
  function stripLooseBold(md) {
    return md.replace(/^\*{2,}\s*([：:])\s*/gm, "$1").replace(/^\*{2,}\s*$/gm, "");
  }

  /** 表格分隔行判定：|---|---| / |:--:| 等 */
  function isTableSeparator(line) {
    const t = line.trim();
    if (!t.includes("-")) return false;
    const s = t.replace(/^\|/, "").replace(/\|$/, "");
    const cells = s.split("|");
    return cells.length > 0 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
  }

  /** 拆单元格：去掉首尾管道，按 | 切分 */
  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|");
  }

  function mdToHtml(md) {
    if (!md) return "";
    md = stripLooseBold(String(md));

    // 代码块先抽出来占位，避免内部内容被后续行解析污染
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
        .replace(/~~([^~]+)~~/g, "<del>$1</del>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');

    const lines = text.split("\n");
    const out = [];
    let listType = null;
    let para = [];
    /** 是否已输出过首个内容块（用于给「结论段」加视觉标记，见下方 lead 处理） */
    let sawFirstBlock = false;

    const flushPara = () => {
      if (para.length) {
        // 第一个段落视为「结论段」：加 lead 标记，样式上做视觉区分
        // （配合系统提示词要求「第一行先给一句话结论」，让最重要内容一眼可见）
        const isLead = !sawFirstBlock;
        out.push(`<p${isLead ? ' class="lead"' : ""}>${inline(para.join("<br>"))}</p>`);
        sawFirstBlock = true;
        para = [];
      }
    };
    const closeList = () => {
      if (listType) {
        out.push(`</${listType}>`);
        listType = null;
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.replace(/\s+$/, "");
      const t = line.trim();

      if (/^\u0000BLOCK\d+\u0000$/.test(t)) {
        flushPara();
        closeList();
        out.push(t);
        sawFirstBlock = true;
        continue;
      }
      if (!t) {
        flushPara();
        closeList();
        continue;
      }

      // GFM 表格：当前行含 | 且下一行是分隔行
      if (t.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        flushPara();
        closeList();
        const head = splitRow(t);
        const aligns = splitRow(lines[i + 1]).map((c) => {
          const s = c.trim();
          const left = s.startsWith(":");
          const right = s.endsWith(":");
          return left && right ? "center" : right ? "right" : left ? "left" : "";
        });
        const bodyRows = [];
        let j = i + 2;
        while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
          bodyRows.push(splitRow(lines[j]));
          j++;
        }
        const alignAttr = (k) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : "");
        const th = head
          .map((c, k) => `<th${alignAttr(k)}>${inline(c.trim())}</th>`)
          .join("");
        const tb = bodyRows
          .map((r) => `<tr>${r.map((c, k) => `<td${alignAttr(k)}>${inline(c.trim())}</td>`).join("")}</tr>`)
          .join("");
        out.push(
          `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`
        );
        sawFirstBlock = true;
        i = j - 1;
        continue;
      }

      const h = t.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara();
        closeList();
        const lvl = Math.min(h[1].length + 1, 4);
        out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
        sawFirstBlock = true;
        continue;
      }
      if (t.startsWith(">")) {
        flushPara();
        closeList();
        out.push(`<blockquote>${inline(t.replace(/^>\s?/, ""))}</blockquote>`);
        sawFirstBlock = true;
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
        sawFirstBlock = true;
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
        sawFirstBlock = true;
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

  window.HuaciMd = { render: mdToHtml, esc };
})();

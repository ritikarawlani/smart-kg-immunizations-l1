// Positioned text out of a PDF, via poppler's `pdftohtml -xml`.
//
// Plain pdftotext loses the two things these sources need: which column a line sits in (the
// summary-table notes are set in two columns, and a bullet often runs from the foot of one into
// the head of the next), and where a phrase links to (each footnote names its position paper by
// hyperlink, not by printed URL). The XML keeps both, plus font colour and weight, which is how a
// footnote heading (white on a coloured bar) is told apart from body text.

import { execFileSync } from "node:child_process";

const decode = (s) => s
  .replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&amp;/g, "&");

/** Pages of positioned text runs, with font colour/size, bold, and the link each run sits in. */
export function readPdf(file, { first, last } = {}) {
  const args = ["-xml", "-i", "-q", "-stdout"];
  if (first) args.push("-f", String(first));
  if (last) args.push("-l", String(last));
  const xml = execFileSync("pdftohtml", [...args, file], { maxBuffer: 256 << 20 }).toString("utf8");

  const fonts = new Map();
  for (const m of xml.matchAll(/<fontspec id="(\d+)" size="(-?\d+)" family="([^"]*)" color="([^"]*)"\/>/g)) {
    fonts.set(m[1], { size: Number(m[2]), family: m[3], color: m[4].toLowerCase() });
  }

  const pages = [];
  for (const pm of xml.matchAll(/<page number="(\d+)"[^>]*height="(\d+)" width="(\d+)">([\s\S]*?)<\/page>/g)) {
    const runs = [];
    for (const t of pm[4].matchAll(/<text top="(-?\d+)" left="(-?\d+)" width="(\d+)" height="(\d+)" font="(\d+)">([\s\S]*?)<\/text>/g)) {
      const inner = t[6];
      const font = fonts.get(t[5]) ?? {};
      const href = /<a href="([^"]*)"/.exec(inner)?.[1];
      runs.push({
        top: Number(t[1]), left: Number(t[2]), width: Number(t[3]), height: Number(t[4]),
        size: font.size, color: font.color, family: font.family,
        bold: /<b>/.test(inner) || /bold/i.test(font.family ?? ""),
        text: decode(inner),
        href: href ? decode(href) : undefined,
      });
    }
    pages.push({ number: Number(pm[1]), height: Number(pm[2]), width: Number(pm[3]), runs });
  }

  const outline = [];
  const om = /<outline>([\s\S]*)<\/outline>/.exec(xml);
  if (om) {
    // Nested <outline> elements carry depth; a running counter over the tags recovers it.
    let depth = 0;
    for (const m of om[1].matchAll(/<(\/?)outline>|<item page="(\d+)">([\s\S]*?)<\/item>/g)) {
      if (m[0] === "<outline>") depth++;
      else if (m[0] === "</outline>") depth--;
      else outline.push({ depth, page: Number(m[2]), title: decode(m[3]).replace(/\s+/g, " ").trim() });
    }
  }
  return { pages, outline };
}

/**
 * Runs grouped into lines, in reading order. With `columns: 2`, the left half of the page is read
 * top to bottom before the right half -- the order the notes are set in.
 */
export function linesOf(page, { columns = 1, tolerance = 4 } = {}) {
  const split = page.width / 2;
  const cols = columns === 2
    ? [page.runs.filter((r) => r.left < split), page.runs.filter((r) => r.left >= split)]
    : [page.runs];
  const out = [];
  cols.forEach((runs, col) => {
    const sorted = [...runs].sort((a, b) => a.top - b.top || a.left - b.left);
    const lines = [];
    for (const r of sorted) {
      const line = lines.find((l) => Math.abs(l.top - r.top) <= tolerance);
      if (line) line.runs.push(r);
      else lines.push({ top: r.top, runs: [r], col });
    }
    for (const l of lines) {
      l.runs.sort((a, b) => a.left - b.left);
      l.left = l.runs[0].left;
      l.text = l.runs.map((r) => r.text).join("").replace(/\s+/g, " ").trim();
      l.hrefs = [...new Set(l.runs.map((r) => r.href).filter(Boolean))];
      // Anchors: consecutive runs under one href, with the text they print.
      l.anchors = [];
      for (const r of l.runs) {
        const last = l.anchors.at(-1);
        if (r.href && last?.href === r.href) last.text += r.text;
        else if (r.href) l.anchors.push({ href: r.href, text: r.text });
      }
    }
    out.push(...lines.sort((a, b) => a.top - b.top));
  });
  return out.filter((l) => l.text);
}

/** Whitespace-joined text of a document's pages, for verbatim checks against extracted strings. */
export const pageText = (file, page) =>
  execFileSync("pdftotext", ["-f", String(page), "-l", String(page), "-layout", file, "-"]).toString("utf8");

/**
 * Text inside a rectangle of one page, in the coordinates readPdf() reports (pdftohtml's 1.5x
 * scale, i.e. 108 dpi). Lines are returned as printed; joining them is the caller's business,
 * because whether a line-final hyphen belongs to the word depends on what is being read.
 */
export function cropText(file, page, { x, y, w, h }) {
  return execFileSync("pdftotext", ["-layout", "-f", String(page), "-l", String(page), "-r", "108",
    "-x", String(Math.round(x)), "-y", String(Math.round(y)), "-W", String(Math.round(w)), "-H", String(Math.round(h)),
    file, "-"]).toString("utf8").split("\n").map((l) => l.replace(/\f/g, "").trimEnd());
}

/** Wrapped lines back into one string: a line ending in "-" or "/" continues without a space. */
export function joinLines(lines) {
  let out = "";
  for (const raw of lines.map((l) => l.trim()).filter(Boolean)) {
    out = !out ? raw : /[-/_]$/.test(out) ? out + raw : `${out} ${raw}`;
  }
  return out.replace(/\s+/g, " ").replace(/\s+([,.;:)])/g, "$1").trim();
}

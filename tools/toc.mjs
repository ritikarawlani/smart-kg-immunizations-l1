// A publication's table of contents, read off its contents page.
//
// The guidance documents the DAK cites carry no PDF outline, or an outline that runs to every
// minor heading; the printed contents page is what the publisher chose to show as structure. A
// line is an entry when it ends in a page number set apart by dot leaders or a wide gap:
//
//   Section 1. Principles of catch-up vaccination ........... 1
//          1.1    Establishing a catch-up vaccination policy ... 2
//   SECTION 2         Ethical considerations and data protection principles     6
//   Annex 1. Designing Catch-up Vaccination Schedules ........ 24
//
// Numbered entries nest by their number (1.1 under 1). An unnumbered entry indented under a
// numbered one is its child; otherwise it is top level.

import { execFileSync } from "node:child_process";

const ENTRY = /^(\s*)(?:(SECTION|Section|Annex|ANNEX)\s+(\d+)\.?\s+|(\d+(?:\.\d+)*)\.?\s+)?(\S.*?)\s*(?:(?:\.\s?){3,}|\s{3,})\s*([0-9]{1,3}|[ivxlc]{1,6})\s*$/;

export function readToc(file, [first, last]) {
  const text = execFileSync("pdftotext", ["-layout", "-f", String(first), "-l", String(last), file, "-"]).toString("utf8");
  // A long title wraps: "Annex 1      Illustrative example of Digital Documentation of COVID-19"
  // then, further indented, "Certificates: Vaccination Status (DDCC:VS)      63". A numbered line
  // with no page number takes the next line's text and page.
  const lines = text.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^\s*(?:SECTION|Section|Annex|ANNEX|\d+(?:\.\d+)*\.?)\s+\S/.test(lines[i]) || ENTRY.test(lines[i])) continue;
    const next = lines[i + 1];
    if (ENTRY.test(next) && next.search(/\S/) > lines[i].search(/\S/)) {
      lines[i] = `${lines[i].trimEnd()} ${next.trim()}`;
      lines[i + 1] = "";
    }
  }
  const entries = [];
  for (const [i, line] of lines.entries()) {
    const m = ENTRY.exec(line);
    if (!m) continue;
    const [, indent, word, wordNo, dotted, heading, page] = m;
    if (/^(contents|page)$/i.test(heading.trim())) continue;
    const number = word ? (/annex/i.test(word) ? `Annex ${wordNo}` : wordNo) : dotted;
    entries.push({ indent: indent.length, number, heading: heading.replace(/[.\s]+$/, "").trim(), page, line: i + 1,
                   printed: line.trim() });
  }
  // Nesting.
  const byNumber = new Map(entries.filter((e) => e.number).map((e) => [e.number, e]));
  let lastTop = null;
  for (const e of entries) {
    if (e.number && /\./.test(e.number)) {
      e.parent = byNumber.get(e.number.split(".").slice(0, -1).join("."))?.number;
    } else if (!e.number && lastTop && e.indent > lastTop.indent + 2) {
      e.parent = lastTop.number ?? lastTop.heading;
    }
    if (!e.parent) lastTop = e;
  }
  return entries;
}

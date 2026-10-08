// The WHO routine immunization summary tables: what they print, read off the page.
//
// Tables 1-3 are a grid of antigens followed by "Summary Table N - Notes": one numbered footnote
// per antigen, each a list of bullets, the first of which names the WHO position paper the rest
// restate ("Position paper reference: Weekly Epid. Record (2018, 93:73-96)", hyperlinked). The
// notes are set in two columns and a bullet regularly runs from the foot of one column into the
// head of the next, so they are read column by column with continuation lines appended to the
// bullet that is open.
//
// Table 4 is a two-column grid -- antigen, recommendation -- and a numbered reference list.
//
// This module only reads. It decides nothing about what a bullet means; build-l1.mjs does that,
// and records that it did.

import { readPdf, linesOf } from "./pdfxml.mjs";

const WHITE = "#ffffff";
const isFooter = (line, page) =>
  line.top > page.height * 0.93 || /P\.\s?\d+\s*\/\s*\d+/.test(line.text) || /^\(?updated:? /i.test(line.text);

/** "Weekly Epid. Record (2018, 93:73-96)" -> { year, volume, pages } -- the printed identity of a position paper. */
export function werCitation(text) {
  const m = /(?:Weekly Epid(?:emiological|\.)? Record)[^0-9]*\(?\s*(\d{4})\s*,\s*(?:vol\.?\s*)?(\d+)\s*(?:\(\d+\))?\s*:\s*(\d+)\s*[-–]\s*(\d+)/i.exec(text);
  return m ? { year: m[1], volume: m[2], pages: `${m[3]}-${m[4]}` } : null;
}

/**
 * Notes of Tables 1-3.
 * @returns {{ title, updated, notesFrom, general: Bullet[], footnotes: Footnote[] }}
 *   Bullet   = { text, hrefs, page, subheading? }
 *   Footnote = { number, heading, page, bullets: Bullet[] }
 */
export function parseNotes(file) {
  const { pages } = readPdf(file);
  const first = linesOf(pages[0]);
  const title = first.find((l) => /^Table \d+:/.test(l.text))?.text;
  const updated = /updated:?\s*([A-Za-z]+ \d{4})/i.exec(first.map((l) => l.text).join(" "))?.[1];

  const notesFrom = pages.findIndex((p) => p.runs.some((r) => /Summary Table \d+ ?- ?Notes/.test(r.text)));
  if (notesFrom < 0) throw new Error(`${file}: no "Summary Table N - Notes" page`);

  const general = [];
  const footnotes = [];
  let current = null;      // the footnote being read, or null while still in the general notes
  let bullet = null;       // the bullet lines are being appended to
  let subheading;

  for (const page of pages.slice(notesFrom)) {
    for (const line of linesOf(page, { columns: 2 })) {
      if (isFooter(line, page)) continue;
      const white = line.runs.every((r) => r.color === WHITE || !r.text.trim());
      if (white) {
        if (/Notes/.test(line.text)) continue;
        // "1 Respiratory Syncytial Virus": the number is set apart, in a smaller white run.
        // The two runs abut, so "3" and "Hepatitis B" join as "3Hepatitis B".
        const m = /^(\d+)\s*(\D.*)$/.exec(line.text);
        if (m) {
          current = { number: m[1], heading: m[2].trim(), page: page.number, bullets: [] };
          footnotes.push(current);
          bullet = null;
          subheading = undefined;
          continue;
        }
      }
      if (line.runs[0].text.trim() === "•" || line.text.startsWith("• ")) {
        bullet = { text: line.text.replace(/^•\s*/, ""), hrefs: [...line.hrefs], anchors: [...line.anchors], page: page.number,
                   ...(subheading ? { subheading } : {}) };
        (current ? current.bullets : general).push(bullet);
        continue;
      }
      if (line.text === "•") continue;
      const allBold = line.runs.every((r) => r.bold || !r.text.trim());
      if (allBold && line.text.length < 90 && !/[.;:]$/.test(line.text)) {
        subheading = line.text;
        bullet = null;
        continue;
      }
      if (bullet) {
        bullet.text = `${bullet.text} ${line.text}`;
        for (const h of line.hrefs) if (!bullet.hrefs.includes(h)) bullet.hrefs.push(h);
        for (const a of line.anchors) {
          // An anchor wrapped across lines continues the previous one.
          const last = bullet.anchors.at(-1);
          if (last?.href === a.href) last.text += ` ${a.text}`; else bullet.anchors.push({ ...a });
        }
      } else {
        // Unbulleted prose. Kept as its own item so nothing printed is silently dropped.
        bullet = { text: line.text, hrefs: [...line.hrefs], anchors: [...line.anchors], page: page.number, unbulleted: true,
                   ...(subheading ? { subheading } : {}) };
        (current ? current.bullets : general).push(bullet);
      }
    }
  }
  for (const b of [...general, ...footnotes.flatMap((f) => f.bullets)]) {
    b.text = tidy(b.text);
    for (const a of b.anchors) a.text = tidy(a.text);
  }
  return { title, updated, notesFrom: notesFrom + 1, general, footnotes };
}

/** Table 4: one recommendation per antigen row, and the numbered reference list it cites. */
export function parseTable4(file) {
  const { pages } = readPdf(file);
  const lines = linesOf(pages[0]);
  const title = lines.find((l) => /^Table 4:/.test(l.text))?.text;
  const updated = /Updated\s+([A-Za-z]+ \d{4})/i.exec(lines.map((l) => l.text).join(" "))?.[1];
  // Two header rows split the table into groups: "Vaccination of Health Care Workers Recommended",
  // and further down, "No current recommendation for vaccination of Health Care Workers". Which
  // group a row sits in is what it says, so the group travels with the row.
  const headers = lines.filter((l) => l.text.startsWith("Antigen"));
  const header = headers[0];
  const groupOf = (l) => l.runs.filter((r) => !r.text.startsWith("Antigen")).map((r) => r.text).join("").trim();
  const columns = ["Antigen", groupOf(header)];
  // The recommendation column starts where the long lines start; the header is centred over it,
  // so its position says nothing about the column edge.
  const split = Math.min(...lines.filter((l) => l.top > header.top)
    .flatMap((l) => l.runs).filter((r) => r.text.length > 40).map((r) => r.left)) - 5;

  // Antigen labels sit left of the recommendation column and end in their reference number.
  const body = lines.filter((l) => l.top > header.top && !/^Updated/.test(l.text));
  const labels = [];
  const text = [];
  for (const l of body) {
    if (l.text.startsWith("Antigen")) continue;
    const left = l.runs.filter((r) => r.left < split).map((r) => r.text).join("").trim();
    const right = l.runs.filter((r) => r.left >= split).map((r) => r.text).join("").trim();
    // "Mumps" "2 3": the reference number is sometimes set as two runs.
    const lab = /^(.+?)\s*([\d ]*\d)\s*([A-Z])?$/.exec(left);
    if (lab) {
      const group = groupOf(headers.filter((h) => h.top < l.top).at(-1));
      labels.push({ top: l.top, antigen: lab[1].trim(), ref: lab[2].replace(/\s/g, ""), marker: lab[3], group });
    }
    if (right) text.push({ top: l.top, text: right, hrefs: l.hrefs });
  }
  // Each recommendation line belongs to the label nearest it vertically: labels are centred on
  // the rows they head, and rows never interleave.
  const rows = labels.map((lab) => ({ ...lab, lines: [] }));
  for (const t of text) {
    const near = rows.reduce((a, b) => (Math.abs(b.top - t.top) < Math.abs(a.top - t.top) ? b : a));
    if (Math.abs(near.top - t.top) < 40) near.lines.push(t);
  }
  const intro = lines.filter((l) => l.top < header.top && !/^Table 4:|^Updated/.test(l.text)).map((l) => l.text).join(" ");

  const refs = [];
  let footnotes = [];
  for (const page of pages.slice(1)) {
    for (const l of linesOf(page)) {
      const m = /^(\d+)\.\s*(.+)$/.exec(l.text);
      if (m) { refs.push({ number: m[1], text: tidy(m[2]), hrefs: l.hrefs, page: page.number }); continue; }
      if (/^[A-Z]$/.test(l.text)) { footnotes.push({ label: l.text, text: "", page: page.number }); continue; }
      if (footnotes.length && !/^References|Updated/.test(l.text)) footnotes.at(-1).text = tidy(`${footnotes.at(-1).text} ${l.text}`);
    }
  }
  // Links in the reference list are set on the entry, not always on the same line as its number.
  return {
    title, updated, columns, intro,
    rows: rows.map((r) => ({
      antigen: r.antigen, ref: r.ref, marker: r.marker, group: r.group, top: r.top,
      statement: tidy(r.lines.sort((a, b) => a.top - b.top).map((x) => x.text).join(" ")),
    })),
    refs, footnotes,
  };
}

/** Joins wrapped lines back into the sentence they were set from. */
function tidy(s) {
  return s.replace(/\s+/g, " ")
    .replace(/(\w)- (and|or)\b/g, "$1- $2")          // "vaccines-and- biologicals" stays two words only inside URLs, below
    .replace(/(https?:\/\/\S+?-)\s+(\S)/g, "$1$2")     // a URL broken after a hyphen
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .trim();
}

#!/usr/bin/env node
// Resolves every position paper the summary tables cite to a WHO IRIS item.
//
// A position paper is printed as a citation -- "Weekly Epid. Record (2018, 93:73-96)" -- and
// hyperlinked. The same paper is linked differently from different tables (an IRIS bitstream, an
// IRIS handle page, a who.int publication page, a who.int topic page), so links are not identity.
// The printed citation is: every table prints the same one for the same paper. So references are
// grouped by printed citation, and each group is resolved once:
//
//   1. each link is followed to an IRIS handle where it can be --
//        handle in the URL         …/10665/260306/…            mechanical
//        IRIS bitstream UUID       bitstream -> bundle -> item  IRIS API
//        who.int publication page  the page's IRIS download link
//        who.int topic page        lists several papers: no handle
//   2. if the group's links agree on one handle, that is the paper;
//   3. if no link gave a handle, IRIS is searched for "<antigen> position paper" issued in the
//      printed year, and exactly one hit is taken; several are left ambiguous;
//   4. if links give different handles, the ones issued in the printed year are kept, and of
//      those an item that is the paper itself is preferred to the full WER issue containing it;
//      one survivor resolves the group, more leave it ambiguous. The losers are kept, with why.
//
// It also checks the printed citation against what IRIS says the linked item is. A full WER issue
// is titled "Weekly Epidemiological Record, 2018, vol. 93, 08"; where its year or volume differs
// from the printed one, the table cites one thing and links another.
//
// Network lookups, so the result is written to data/position-papers.json and committed: the build
// reads that file and runs offline, and the file records what IRIS said and when.
//
//   node tools/resolve-links.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseNotes, parseTable4, werCitation } from "./summary-tables.mjs";
import { get, getJson } from "./net.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "sources.json"), "utf8"));
const IRIS = "https://iris.who.int/server/api";

export const werKey = (c) => `WER ${c.year}, ${c.volume}:${c.pages}`;

/** Every position-paper reference printed in the tables: { key, printed, href, where, topic }. */
export function positionPaperReferences(root = ROOT) {
  const refs = [];
  for (const src of manifest.sources.filter((s) => s.parse)) {
    const file = join(root, "sources", src.file);
    if (src.parse === "notes") {
      for (const f of parseNotes(file).footnotes) {
        for (const b of f.bullets.filter((b) => /^Position paper references?\b/i.test(b.text))) {
          for (const a of b.anchors) {
            const c = werCitation(a.text);
            if (c) refs.push({ key: werKey(c), printed: a.text, href: a.href, topic: f.heading,
                               where: `${src.id} footnote ${f.number} (p. ${b.page})` });
          }
        }
      }
    } else {
      for (const r of parseTable4(file).refs) {
        const c = werCitation(r.text);
        if (c) refs.push({ key: werKey(c), printed: r.text, href: r.hrefs[0], topic: r.text.split(/[,:]/)[0],
                           where: `${src.id} reference ${r.number} (p. ${r.page})` });
      }
    }
  }
  return refs;
}

const item = (handle) => {
  const d = getJson(`${IRIS}/pid/find?id=${handle}`);
  const m = (k) => (d.metadata?.[k] ?? []).map((v) => v.value);
  return { handle: d.handle, title: d.name.replace(/\s+/g, " ").trim(), issued: m("dc.date.issued")[0] };
};
const itemOfBitstream = (uuid) => {
  const bundle = getJson(`${IRIS}/core/bitstreams/${uuid}/bundle`);
  return item(getJson(bundle._links.item.href).handle);
};

const linkCache = new Map();
function resolveHref(href) {
  if (linkCache.has(href)) return linkCache.get(href);
  let r;
  try {
    const handle = /\/10665\/(\d+)(?:[/?#]|$)/.exec(href)?.[1];
    const bitstream = /iris\.who\.int\/server\/api\/core\/bitstreams\/([0-9a-f-]{36})/.exec(href)?.[1];
    if (handle) r = { via: "handle in the link", ...item(`10665/${handle}`) };
    else if (bitstream) r = { via: "IRIS bitstream in the link", ...itemOfBitstream(bitstream) };
    else if (/who\.int\/publications\/i\/item\//.test(href)) {
      const page = get(href);
      // The page's own Download button precedes any related items it lists further down.
      const m = /iris\.who\.int\/(?:server\/api\/core\/bitstreams\/([0-9a-f-]{36})|(?:bitstream\/)?handle\/10665\/(\d+))/.exec(page.body);
      if (page.code !== 200) r = { unresolved: `HTTP ${page.code}` };
      else if (!m) r = { unresolved: "the who.int publication page links to no IRIS item" };
      else r = { via: "IRIS download link on the who.int publication page", ...(m[1] ? itemOfBitstream(m[1]) : item(`10665/${m[2]}`)) };
    } else if (/who\.int\/teams\/.+\/position-papers\//.test(href)) {
      r = { unresolved: "a who.int topic page, listing every position paper on the antigen" };
    } else r = { unresolved: "not a WHO IRIS or who.int publication link" };
  } catch (err) {
    r = { unresolved: `lookup failed: ${err.message}` };
  }
  linkCache.set(href, r);
  return r;
}

/** IRIS search: "<topic> position paper", issued in the printed year. */
function search(topic, year) {
  const q = `${topic.replace(/\(.*?\)/g, "").trim()} position paper`;
  const d = getJson(`${IRIS}/discover/search/objects?size=20&query=${encodeURIComponent(q)}`);
  const hits = (d._embedded?.searchResult?._embedded?.objects ?? []).map((o) => o._embedded.indexableObject)
    .map((x) => ({ handle: x.handle, title: x.name.replace(/\s+/g, " ").trim(),
                   issued: x.metadata?.["dc.date.issued"]?.[0]?.value }))
    .filter((x) => x.issued?.startsWith(year) && /position paper|note de synth/i.test(x.title));
  return { query: q, hits };
}

/** What a full-issue title says: "Weekly Epidemiological Record, 2018, vol. 93, 08 [full issue]". */
const issueOf = (title) => {
  const m = /Weekly Epidemiological Record, (\d{4}), vol\. (\d+), ([\d/]+)/.exec(title ?? "");
  return m ? { year: m[1], volume: m[2], issue: m[3] } : null;
};

function main() {
  const refs = positionPaperReferences();
  const groups = new Map();
  for (const r of refs) {
    if (!groups.has(r.key)) groups.set(r.key, []);
    groups.get(r.key).push(r);
  }

  const papers = {};
  for (const [key, members] of [...groups].sort()) {
    const printed = werCitation(members[0].printed);
    const links = [...new Set(members.map((m) => m.href))].map((href) => ({ href, ...resolveHref(href) }));
    const handles = [...new Set(links.map((l) => l.handle).filter(Boolean))];
    const p = { printedAs: [...new Set(members.map((m) => m.printed))], citedFrom: members.map((m) => m.where),
                topic: members[0].topic, links };
    if (handles.length === 1) {
      Object.assign(p, { status: "resolved", via: "link", ...links.find((l) => l.handle) });
    } else if (handles.length > 1) {
      const items = handles.map((h) => links.find((l) => l.handle === h));
      let keep = items.filter((i) => i.issued?.startsWith(printed.year));
      if (keep.length > 1) keep = keep.filter((i) => !/\[full issue\]/.test(i.title));
      if (keep.length === 1) {
        Object.assign(p, { status: "resolved", via: "link, disambiguated", ...keep[0],
          rejected: items.filter((i) => i !== keep[0]).map((i) => ({ handle: i.handle, title: i.title, issued: i.issued,
            why: !i.issued?.startsWith(printed.year) ? `issued ${i.issued}, not in the printed year ${printed.year}`
                                                     : "the full WER issue containing the paper, where the paper itself is also linked" })) });
      } else {
        Object.assign(p, { status: "ambiguous", why: `the links resolve to different IRIS items: ${handles.join(", ")}` });
      }
    } else {
      const topics = [...new Set(members.map((m) => m.topic))];
      for (const t of topics) {
        p.search = search(t, printed.year);
        if (p.search.hits.length) break;
      }
      const s = p.search;
      if (s.hits.length === 1) Object.assign(p, { status: "resolved", via: "search", ...s.hits[0] });
      else Object.assign(p, { status: s.hits.length ? "ambiguous" : "unresolved",
                              why: s.hits.length ? `${s.hits.length} IRIS items match the search` : "no IRIS item matches the search" });
    }
    // A link whose IRIS item was issued outside the printed year cites one paper and links another.
    p.linkMismatches = links.filter((l) => l.issued && !l.issued.startsWith(printed.year))
      .map((l) => `${l.href} is ${l.handle} "${l.title}", issued ${l.issued}; the citation printed beside it is ${key}`);
    if (!p.linkMismatches.length) delete p.linkMismatches;
    // Printed citation against the linked item.
    const issue = issueOf(p.title);
    if (issue && (issue.year !== printed.year || issue.volume !== printed.volume)) {
      p.mismatch = `printed ${key}; the linked IRIS item is WER ${issue.year}, vol. ${issue.volume}, issue ${issue.issue}`;
    }
    papers[key] = p;
    console.log(`${p.status === "resolved" ? "✓" : "·"} ${key}  ${p.handle ?? ""} ${p.title ?? p.why}` +
                (p.mismatch ? `\n    ! ${p.mismatch}` : "") + (p.linkMismatches ?? []).map((m) => `\n    ! ${m}`).join(""));
  }

  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(join(ROOT, "data", "position-papers.json"), JSON.stringify({
    note: "Each position paper the WHO routine immunization summary tables cite, keyed by its printed Weekly Epidemiological Record citation and resolved to a WHO IRIS item by tools/resolve-links.mjs. Network lookups, committed so the build runs offline and records what IRIS said and when.",
    resolvedAt: new Date().toISOString().slice(0, 10),
    papers,
  }, null, 2) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

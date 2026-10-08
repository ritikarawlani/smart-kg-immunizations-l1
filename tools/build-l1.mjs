#!/usr/bin/env node
// Builds the L1 graph for the WHO immunization DAK's section 1.2 sources.
//
// What it reads, all pinned by sha256 in sources.json and fetched by tools/fetch.mjs:
//
//   the DAK (ISBN 9789240099456)   section 1.2: ten linked captions, each ending in "(n)"; and the
//                                  reference list those numbers point into
//   summary Tables 1-3             per-antigen notes: bullets restating a WHO position paper
//   summary Table 4                one recommendation per antigen for health care workers
//   five guidance documents        their tables of contents
//
// and data/position-papers.json, where tools/resolve-links.mjs recorded which IRIS item each
// printed position-paper citation names.
//
// What it writes: graph/immunizations-l1.json, one L1 document conforming to the smart-kg L1
// ontology, and graph/REPORT.md, what was found -- counts, and every place a source disagrees
// with itself. Identity comes from smart-kg's tools/kgid.mjs, so two builds -- or this build and
// anyone else's extraction of the same guideline -- mint the same IRIs.
//
//   SMART_KG=../smart-kg node tools/build-l1.mjs
//
// Every node and edge read off a PDF is `inferred`, with a note saying how and evidence saying
// where: reading a PDF is a judgement, and smart-kg's validator holds it to that.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readPdf, cropText, joinLines } from "./pdfxml.mjs";
import { parseNotes, parseTable4, werCitation } from "./summary-tables.mjs";
import { readToc } from "./toc.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SMART_KG = process.env.SMART_KG ?? join(ROOT, "..", "smart-kg");
const kg = await import(pathToFileURL(join(SMART_KG, "tools", "kgid.mjs")).href);
const { publicationId, sectionId, publicationElementId, recommendationId, citationId, referenceEntryId,
        contentHash, contentText, normText } = kg;
const ONTOLOGY = JSON.parse(readFileSync(join(SMART_KG, "ontology", "l1", "l1.json"), "utf8"));

const manifest = JSON.parse(readFileSync(join(ROOT, "sources.json"), "utf8"));
const PAPERS_FILE = join(ROOT, "data", "position-papers.json");
const papers = JSON.parse(readFileSync(PAPERS_FILE, "utf8"));
const src = (id) => manifest.sources.find((s) => s.id === id);
const fileOf = (s) => join(ROOT, "sources", s.file);
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

// The DAK's own namespace. Citations are DAK material, content-addressed there (smart-kg kgid).
const DAK_NS = "https://smart.who.int/immunizations";

// ---- the document -------------------------------------------------------------------------------
const nodes = new Map();
const edges = [];
const findings = [];          // where a source disagrees with itself or with what it links to
const edgeKeys = new Set();

const at = (file, page, quote) => ({ location: `${file} p. ${page}`, ...(quote ? { quote: clip(quote) } : {}) });
const clip = (s, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Adds a node, or merges into the one already there: one IRI, one node, however often it is read. */
function node(id, type, label, properties, how) {
  const prior = nodes.get(id);
  if (prior) {
    if (prior.type !== type) throw new Error(`${id} minted as ${prior.type} and ${type}`);
    return prior;
  }
  const n = { id, type, label: clip(label, 160), properties: clean(properties), ...how };
  nodes.set(id, n);
  return n;
}
function edge(predicate, source, target, how = {}) {
  const key = `${predicate}|${source}|${target}|${how.qualifier ?? ""}`;
  if (edgeKeys.has(key)) return;
  edgeKeys.add(key);
  edges.push({ type: "Statement", predicate, source, target, ...how });
}
const inferred = (note, evidence, extra = {}) => ({ derivation: "inferred", note, evidence, ...extra });
const derived = (extra = {}) => ({ derivation: "derived", ...extra });
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
const hashed = (props, fields) => ({ ...props, contentHash: contentHash(contentText({ properties: props }, fields)) });

// ---- publications -------------------------------------------------------------------------------
const pubOf = new Map();       // manifest id -> IRI

function publication(s, how) {
  const identifiers = s.identifiers.map(({ type, value }) => ({ type, value }));
  const id = publicationId(identifiers);
  node(id, "publication", s.title, {
    title: s.title, creator: s.publisher, publisher: s.publisher, issued: s.issued, identifiers,
    language: s.language ?? "en", rights: s.rights, url: s.link ?? s.landing ?? s.download,
    sha256: s.sha256 || undefined, publicationType: s.publicationType, grcStatus: s.grcStatus,
  }, how);
  pubOf.set(s.id, id);
  return id;
}

const dak = manifest.dak;
const DAK_FILE = fileOf(dak);
const DAK = publication(dak, inferred(
  "Bibliographic record from WHO IRIS; identity from the electronic ISBN printed on the copyright page.",
  { location: dak.landing, quote: "ISBN 978-92-4-009945-6 (electronic version)" }));

for (const s of manifest.sources) {
  const why = s.file
    ? `Title and date as printed and on the landing page; identity from its ${s.identifiers[0].type}. sha256 pins the file read.`
    : s.unavailable
      ? `Known only from the DAK's reference list: ${s.unavailable}`
      : `A web page, known from the DAK's reference list and the page itself; identified by its address.`;
  publication(s, inferred(why, { location: s.link ?? s.landing ?? s.download, quote: s.title }));
}

// Position papers: one per printed citation, identified by the IRIS item it resolves to.
const paperOf = new Map();     // "WER 2018, 93:73-96" -> IRI
for (const [key, p] of Object.entries(papers.papers)) {
  if (p.status !== "resolved") continue;
  const id = publicationId([{ type: "iris-handle", value: p.handle }]);
  node(id, "publication", `${p.topic} — position paper, ${key}`, {
    title: p.title, creator: "World Health Organization", publisher: "World Health Organization",
    issued: p.issued, url: `https://iris.who.int/handle/${p.handle}`, publicationType: "position-paper",
    identifiers: [{ type: "iris-handle", value: p.handle }, { type: "other", value: key }],
  }, inferred(
    `A WHO position paper, cited in the summary tables as "${p.printedAs[0]}". Resolved to IRIS item ` +
    `${p.handle} by ${p.via}${p.rejected ? `; rejected ${p.rejected.map((r) => `${r.handle} (${r.why})`).join(", ")}` : ""}. ` +
    `Title and date are IRIS's.${/\[full issue\]/.test(p.title) ? " The IRIS item is the full WER issue the paper is printed in." : ""}`,
    { location: p.citedFrom[0], quote: p.printedAs[0] }));
  paperOf.set(key, id);
}

// ---- the DAK's section 1.2 and its reference list -----------------------------------------------
const S12 = sectionId(DAK, dak.section.number);
node(S12, "publication-section", `${dak.section.number} ${dak.section.heading}`, {
  heading: dak.section.heading, number: dak.section.number, pageRange: dak.section.printedPage,
}, inferred("Read from the DAK PDF.", at(dak.file, dak.section.page, `${dak.section.number} ${dak.section.heading}`)));
edge("contains", DAK, S12, inferred("The section is printed in the DAK.", at(dak.file, dak.section.page)));

// The reference list, both columns of both pages.
const refList = new Map();
{
  const lines = [];
  for (const page of dak.referenceList.pages) {
    for (const x of [0, 631]) lines.push(...cropText(DAK_FILE, page, { x, y: 0, w: 620, h: 860 }));
  }
  let cur = null;
  for (const l of lines) {
    const m = /^\s*(\d{1,2})\.\s+(.*)$/.exec(l);
    if (m) { cur = { number: m[1], lines: [m[2]] }; refList.set(m[1], cur); continue; }
    if (cur && /^\s{2,}\S/.test(l)) cur.lines.push(l);
    else cur = null;
  }
  for (const r of refList.values()) {
    r.text = joinLines(r.lines);
    r.url = /\((https?:\/\/[^)\s]+)\)\.?$/.exec(r.text)?.[1];
  }
}

// Section 1.2: each box is a caption hyperlinked to its source, ending in the reference number.
const { pages: [p12] } = readPdf(DAK_FILE, { first: dak.section.page, last: dak.section.page });
const boxes = new Map();
for (const r of p12.runs) {
  if (!r.href || !/^https?:/.test(r.href) || r.text.trim().length < 4) continue;
  if (!boxes.has(r.href)) boxes.set(r.href, []);
  boxes.get(r.href).push(r);
}
// The DAK links some sources over http and the manifest records https; the scheme is not identity.
const bare = (u) => String(u ?? "").replace(/^https?:\/\//, "");
const linkToSource = (href) => manifest.sources.find((s) => [s.link, s.landing, s.download].map(bare).includes(bare(href)));
let ordinal = 0;
for (const [href, runs] of boxes) {
  const x = Math.min(...runs.map((r) => r.left)) - 2;
  const y = Math.min(...runs.map((r) => r.top)) - 2;
  const w = Math.max(...runs.map((r) => r.left + r.width)) - x + 8;
  const lines = cropText(DAK_FILE, dak.section.page, { x, y, w, h: 200 });
  const end = lines.findIndex((l) => /\(\d+\)\s*$/.test(l));
  const caption = joinLines(lines.slice(0, end + 1));
  const n = /\((\d+)\)$/.exec(caption)?.[1];
  const target = linkToSource(href);
  if (!n || !target) throw new Error(`section 1.2: could not read the box linking ${href} (${caption})`);
  ordinal++;

  const C = citationId(DAK_NS, caption);
  node(C, "citation", caption, { text: caption, numbering: n, citationKind: "reference", resolutionStatus: "resolved" },
    derived({ evidence: at(dak.file, dak.section.page, caption) }));
  const ref = refList.get(n);
  const R = referenceEntryId(DAK, n);
  node(R, "reference-entry", `(${n}) ${ref.text}`, { number: n, text: ref.text, url: ref.url, resolutionStatus: "resolved" },
    derived({ evidence: at(dak.file, dak.referenceList.pages.join("-"), ref.text) }));
  edge("numberedAs", C, R, derived({ evidence: at(dak.file, dak.section.page, `(${n})`) }));

  // The caption's hyperlink names its source more precisely than the reference entry does: four
  // captions all numbered (29) link to four different summary tables.
  edge("resolvesTo", C, pubOf.get(target.id), inferred(
    "The caption is hyperlinked; the link is this publication's address.",
    { ...at(dak.file, dak.section.page, href) }));

  const refTarget = manifest.sources.find((s) => s.cites === n && (!s.file || s.parse !== "notes" && s.parse !== "table4"));
  const refHow = inferred(
    "The entry's printed URL is this publication's address, or its title is this publication's title.",
    at(dak.file, dak.referenceList.pages.join("-"), ref.url ?? ref.text));
  edge("resolvesTo", R, pubOf.get(refTarget.id), refHow);
  // The entry's URL should be one of the addresses the source is known by; an IRIS handle is
  // known by its handle URL.
  const known = [refTarget.link, refTarget.landing, refTarget.download,
    ...refTarget.identifiers.map((i) => (i.type === "iris-handle" ? `https://iris.who.int/handle/${i.value}` : i.value))].map(bare);
  if (ref.url && !known.includes(bare(ref.url))) {
    findings.push({ kind: "dak", where: `DAK section 1.2 and reference (${n})`,
      what: `Caption "${caption}" links to ${href}; its reference entry (${n}) gives ${ref.url}.` });
  }
}

// ---- the summary tables -------------------------------------------------------------------------
const restated = new Map();     // recommendation IRI -> tables it is printed in

function definedInFor(key, why) {
  const pub = paperOf.get(key);
  if (!pub) throw new Error(`no resolved position paper for ${key} (${why})`);
  return pub;
}

for (const s of manifest.sources.filter((x) => x.parse === "notes")) {
  const PUB = pubOf.get(s.id);
  const notes = parseNotes(fileOf(s));
  const tableLabel = /^(Table \d+)/.exec(notes.title)[1];
  const T = publicationElementId(PUB, tableLabel);
  node(T, "publication-element", notes.title, {
    elementType: "table", label: tableLabel, caption: notes.title, pageRange: `1-${notes.notesFrom - 1}`,
  }, inferred("Read from the summary table PDF. Its grid cells are not extracted; see README.", at(s.file, 1, notes.title)));
  edge("contains", PUB, T, inferred("The table is the publication.", at(s.file, 1), { qualifier: "unsectioned" }));

  const G = publicationElementId(PUB, tableLabel, "notes");
  node(G, "publication-element", `${tableLabel} — Notes`, {
    elementType: "list", label: `Summary ${tableLabel} - Notes`, pageRange: String(notes.notesFrom),
    text: notes.general.map((b) => b.text).join("\n"),
  }, inferred("The general notes preceding the per-antigen footnotes. Printed text about the table, not a recommendation.",
              at(s.file, notes.notesFrom, `Summary ${tableLabel} - Notes`)));
  edge("contains", T, G, inferred("Printed under the table.", at(s.file, notes.notesFrom), { qualifier: "part" }));

  for (const f of notes.footnotes) {
    const F = publicationElementId(PUB, tableLabel, `footnote ${f.number}`);
    const refBullets = f.bullets.filter((b) => /^Position paper references?\b/i.test(b.text));
    const cited = refBullets.flatMap((b) => b.anchors.map((a) => ({ a, c: werCitation(a.text) })).filter((x) => x.c));
    const unbulleted = f.bullets.filter((b) => b.unbulleted).map((b) => b.text);
    node(F, "publication-element", `${tableLabel} footnote ${f.number}: ${f.heading}`, {
      elementType: "footnote", label: f.number, caption: f.heading, pageRange: String(f.page),
      text: [...refBullets.map((b) => b.text), ...unbulleted].join("\n") || undefined,
    }, inferred("A numbered footnote of the summary table notes, headed by its antigen.", at(s.file, f.page, `${f.number} ${f.heading}`)));
    edge("contains", T, F, inferred("Printed in the table's notes.", at(s.file, f.page), { qualifier: "part" }));

    // Which paper the footnote's bullets restate. One cited paper: that one. Several (DTP cites
    // diphtheria, tetanus and pertussis; meningococcal cites four): the one whose label the
    // bullet names, else the first listed, flagged.
    const keys = cited.map(({ a, c }) => ({ key: `WER ${c.year}, ${c.volume}:${c.pages}`,
      label: (/^(?:Position paper references?:\s*)?(?:(.*?)\s*[-–]\s*)?Weekly/i.exec(a.text)?.[1] ?? "").replace(/^and\s+/, "").trim() }));
    if (!keys.length) {
      findings.push({ kind: "table", where: `${s.id} footnote ${f.number}`, what: `"${f.heading}" names no position paper.` });
      continue;
    }

    for (const b of f.bullets) {
      if (b.unbulleted || refBullets.includes(b)) continue;
      let k = keys[0];
      let how = keys.length === 1
        ? `Restated from the one position paper footnote ${f.number} cites (${k.key}).`
        : null;
      let flag;
      if (keys.length > 1) {
        const named = keys.filter((x) => x.label && new RegExp(`\\b${x.label.split(/\s+/)[0]}`, "i").test(b.text));
        if (named.length === 1) { k = named[0]; how = `Footnote ${f.number} cites ${keys.length} position papers; the bullet names "${k.label}", so ${k.key}.`; }
        else { how = `Footnote ${f.number} cites ${keys.length} position papers and the bullet does not name one; the first listed (${k.key}) is taken. Needs review.`; flag = `multi-paper-footnote:${f.number}`; }
      }
      const PAPER = definedInFor(k.key, `${s.id} footnote ${f.number}`);
      const statement = normText(b.text);
      const R = recommendationId(PAPER, null, statement);
      node(R, "recommendation", `${f.heading}: ${statement}`, hashed({
        statement, intervention: f.heading,
      }, ["statement"]), inferred(
        "One bullet of a summary-table footnote, verbatim. The tables restate position papers; kind, direction and strength are not printed, so none is recorded.",
        at(s.file, b.page, statement), flag ? { flagRef: flag } : {}));
      edge("definedIn", R, PAPER, inferred(how, at(s.file, f.page, k.key)));
      edge("presentedIn", R, F, inferred(`Printed in ${tableLabel}'s footnote ${f.number}${b.subheading ? `, under "${b.subheading}"` : ""}.`, at(s.file, b.page, statement)));
      if (!restated.has(R)) restated.set(R, new Set());
      restated.get(R).add(tableLabel);
    }
  }
}

// Table 4: a recommendation per antigen row.
{
  const s = src("summary-table-4");
  const PUB = pubOf.get(s.id);
  const t4 = parseTable4(fileOf(s));
  const T = publicationElementId(PUB, "Table 4");
  node(T, "publication-element", t4.title, {
    elementType: "table", label: "Table 4", caption: t4.title.replace(/A$/, ""), pageRange: "1",
    columns: t4.columns, columnMap: { [t4.columns[1]]: "statement" }, text: t4.intro,
  }, inferred("Read from the summary table PDF.", at(s.file, 1, t4.title)));
  edge("contains", PUB, T, inferred("The table is the publication.", at(s.file, 1), { qualifier: "unsectioned" }));

  const groups = [...new Set(t4.rows.map((r) => r.group))];
  let ordinal = 0;
  for (const r of t4.rows) {
    ordinal++;
    if (r.group !== groups[0] && t4.rows[ordinal - 2]?.group !== r.group) {
      const H = publicationElementId(PUB, "Table 4", `header ${r.group}`);
      node(H, "publication-element", `Table 4 / ${r.group}`, {
        elementType: "table-row", rowType: "header", ordinal: ordinal - 0.5, cells: ["Antigen", r.group],
      }, inferred("A second header row, starting a group of rows.", at(s.file, 1, r.group)));
      edge("contains", T, H, inferred("A row of the table.", at(s.file, 1), { qualifier: "part" }));
    }
    const ROW = publicationElementId(PUB, "Table 4", `row ${r.antigen}`);
    node(ROW, "publication-element", `Table 4 / ${r.antigen}`, {
      elementType: "table-row", rowType: "data", ordinal, cells: [`${r.antigen} ${r.ref}`, null],
    }, inferred("A row of Table 4; its recommendation cell is filled from the recommendation presented here.", at(s.file, 1, r.antigen)));
    edge("contains", T, ROW, inferred("A row of the table.", at(s.file, 1), { qualifier: "part" }));

    const ref = t4.refs.find((x) => x.number === r.ref);
    const c = werCitation(ref?.text ?? "");
    if (!c) { findings.push({ kind: "table", where: `Table 4 row ${r.antigen}`, what: `reference ${r.ref} names no WER citation` }); continue; }
    const key = `WER ${c.year}, ${c.volume}:${c.pages}`;
    const PAPER = definedInFor(key, `Table 4 reference ${r.ref}`);
    const statement = normText(r.statement);
    const noRec = r.group !== groups[0];
    const R = recommendationId(PAPER, null, statement);
    node(R, "recommendation", `${r.antigen} (health care workers): ${statement}`, hashed({
      statement, kind: noRec ? "no-recommendation" : undefined,
    }, ["statement"]), inferred(
      noRec ? `A row under Table 4's header "${r.group}", so kind no-recommendation; the cell's words are kept verbatim.`
            : `A row under Table 4's header "${r.group}". Direction and strength are not printed.`,
      at(s.file, 1, statement)));
    edge("definedIn", R, PAPER, inferred(`The row's superscript ${r.ref} points to Table 4 reference ${r.ref}: "${ref.text}".`,
      at(s.file, 2, ref.text)));
    edge("presentedIn", R, ROW, inferred("Printed in this row.", at(s.file, 1, statement)));
    if (!restated.has(R)) restated.set(R, new Set());
    restated.get(R).add("Table 4");
  }
  const L = publicationElementId(PUB, "Table 4", "references");
  node(L, "publication-element", "Table 4 — References", {
    elementType: "list", label: "References", pageRange: "2", text: t4.refs.map((x) => `${x.number}. ${x.text}`).join("\n"),
  }, inferred("Table 4's numbered reference list.", at(s.file, 2, "References")));
  edge("contains", T, L, inferred("Printed with the table.", at(s.file, 2), { qualifier: "part" }));

  // A row whose words are another row's.
  const seen = new Map();
  for (const r of t4.rows) {
    const k = normText(r.statement);
    if (seen.has(k)) findings.push({ kind: "table", where: `Table 4 rows ${seen.get(k)} and ${r.antigen}`,
      what: `${r.antigen}'s recommendation is word for word ${seen.get(k)}'s: "${clip(k, 120)}"` });
    else seen.set(k, r.antigen);
  }
}

// ---- guidance documents: their printed contents ---------------------------------------------------
const tocCounts = {};
for (const s of manifest.sources.filter((x) => x.sections === "toc")) {
  const PUB = pubOf.get(s.id);
  const entries = readToc(fileOf(s), s.tocPages);
  const idOf = new Map();
  let ordinal = 0;
  for (const e of entries) {
    ordinal++;
    const key = e.number ?? e.heading;
    let SID = sectionId(PUB, key);
    if ([...idOf.values()].includes(SID)) SID = sectionId(PUB, `${key}-${ordinal}`);
    idOf.set(key, SID);
    node(SID, "publication-section", `${e.number ? `${e.number} ` : ""}${e.heading}`, {
      heading: e.heading, number: e.number, pageRange: e.page, ordinal,
    }, inferred("An entry of the printed table of contents; pageRange is the printed page it gives.",
                at(s.file, s.tocPages.join("-"), e.printed)));
    const parent = e.parent ? idOf.get(e.parent) : null;
    if (parent) edge("contains", parent, SID, inferred("Nested under its parent in the contents.", at(s.file, s.tocPages.join("-")), { qualifier: "subsection" }));
    else edge("contains", PUB, SID, inferred("A top-level entry of the contents.", at(s.file, s.tocPages.join("-"))));
  }
  tocCounts[s.id] = entries.length;
}

// ---- what the sources say about themselves ------------------------------------------------------
for (const [key, p] of Object.entries(papers.papers)) {
  const c = /WER (\d{4}), (\d+):/.exec(key);
  // WER volume 1 is 1926, so volume = year - 1925.
  if (c && Number(c[2]) !== Number(c[1]) - 1925) {
    findings.push({ kind: "citation", where: p.citedFrom.join("; "),
      what: `printed "${p.printedAs[0]}": volume ${c[2]} is not WER's volume for ${c[1]} (${Number(c[1]) - 1925})` +
            `${p.mismatch ? `; ${p.mismatch.replace(/^printed [^;]+; /, "")}` : ""}.` });
  }
  for (const m of p.linkMismatches ?? []) findings.push({ kind: "link", where: p.citedFrom.join("; "), what: m });
  if (p.via === "search") findings.push({ kind: "link", where: p.citedFrom.join("; "),
    what: `${key} is linked only to a who.int topic page; resolved by IRIS search to ${p.handle} "${p.title}".` });
}

// ---- write --------------------------------------------------------------------------------------
const doc = {
  "@context": "http://smart.who.int/kg/l1.context.jsonld",
  id: `${DAK}/kg/section-1.2-sources`,
  type: "Entity",
  ontologyVersion: ONTOLOGY.schemaVersion,
  generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  wasDerivedFrom: [
    ...[dak, ...manifest.sources].filter((s) => s.file).map((s) => ({
      path: `sources/${s.file}`, sha256: s.sha256, note: s.download })),
    { path: "data/position-papers.json", sha256: sha(PAPERS_FILE), note: `WHO IRIS lookups of ${papers.resolvedAt}` },
  ],
  nodes: [...nodes.values()],
  edges,
};
mkdirSync(join(ROOT, "graph"), { recursive: true });
writeFileSync(join(ROOT, "graph", "immunizations-l1.json"), JSON.stringify(doc, null, 2) + "\n");

// The report.
const byType = {};
for (const n of nodes.values()) byType[n.type] = (byType[n.type] ?? 0) + 1;
const byPred = {};
for (const e of edges) byPred[e.predicate] = (byPred[e.predicate] ?? 0) + 1;
const recs = [...nodes.values()].filter((n) => n.type === "recommendation");
const multi = [...restated.values()].filter((t) => t.size > 1).length;
const flagged = recs.filter((n) => n.flagRef).length;
const perPaper = new Map();
for (const e of edges.filter((e) => e.predicate === "definedIn")) perPaper.set(e.target, (perPaper.get(e.target) ?? 0) + 1);

const md = [
  "# Build report",
  "",
  `Generated by \`tools/build-l1.mjs\` against smart-kg L1 ontology ${ONTOLOGY.schemaVersion}. Regenerated on every build; do not edit.`,
  "",
  "## Counts",
  "",
  `${nodes.size} nodes, ${edges.length} edges.`,
  "",
  "| Class | Nodes |", "|---|---|",
  ...Object.entries(byType).sort().map(([k, v]) => `| ${k} | ${v} |`),
  "",
  "| Predicate | Edges |", "|---|---|",
  ...Object.entries(byPred).sort().map(([k, v]) => `| ${k} | ${v} |`),
  "",
  `- **${recs.length} distinct recommendations** across the four summary tables; ${multi} of them are printed in more than one table and are stored once, with a \`presentedIn\` edge per printing.`,
  `- **${paperOf.size} position papers**, each resolved to a WHO IRIS item (see \`data/position-papers.json\`).`,
  `- ${flagged} recommendation(s) carry a \`flagRef\`: their footnote cites several position papers and the bullet does not say which. Each is attributed to the first listed and needs a person to check.`,
  `- Sections from printed contents: ${Object.entries(tocCounts).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
  "",
  "### Recommendations per position paper",
  "",
  "| Position paper | IRIS | Recommendations |", "|---|---|---|",
  ...[...paperOf].map(([key, id]) => [key, id, papers.papers[key]]).sort((a, b) => a[2].topic.localeCompare(b[2].topic))
    .map(([key, id, p]) => `| ${p.topic} — ${key} | [${p.handle}](https://iris.who.int/handle/${p.handle}) | ${perPaper.get(id) ?? 0} |`),
  "",
  "## Where the sources disagree with themselves",
  "",
  "Each of these is a defect in a WHO source, found while building the graph. None is corrected in the graph: it records what is printed, and the resolution it made, with evidence.",
  "",
  ...findings.map((f) => `- **${f.kind}** — ${f.where}: ${f.what}`),
  "",
];
writeFileSync(join(ROOT, "graph", "REPORT.md"), md.join("\n"));

console.log(`${nodes.size} nodes, ${edges.length} edges -> graph/immunizations-l1.json`);
console.log(Object.entries(byType).map(([k, v]) => `${k}:${v}`).join(" "));
console.log(`${recs.length} recommendations (${multi} printed in more than one table, ${flagged} flagged); ${findings.length} findings -> graph/REPORT.md`);

# L1 graph: WHO immunization DAK, section 1.2 sources

An L1 knowledge graph of the WHO guidelines and guidance that the **Digital adaptation kit for
immunizations** (WHO, 2024, ISBN 9789240099456) cites in **section 1.2, "WHO guidelines,
recommendations and guidance"**. It is built against the L1 ontology of
[`WorldHealthOrganization/smart-kg`](https://github.com/WorldHealthOrganization/smart-kg) (3.0), and
it validates against that repository's tier-1 shape and tier-2 conformance checks.

| | |
|---|---|
| [`graph/immunizations-l1.json`](graph/immunizations-l1.json) | The graph: 592 nodes and 1228 edges |
| [`graph/immunizations-l1.cypher`](graph/immunizations-l1.cypher) | The same graph as Cypher, for Neo4j |
| [`graph/REPORT.md`](graph/REPORT.md) | Counts, recommendations per position paper, and **every place a source disagrees with itself** |
| [`sources.json`](sources.json) | Every source read, with its download URL and pinned sha256 |
| [`data/position-papers.json`](data/position-papers.json) | Which WHO IRIS item each cited position paper resolves to, and how |
| [`tools/`](tools/) | Fetch, resolve, build, export. Plain Node, no npm dependencies |

## What section 1.2 points at, and what came out of it

Section 1.2 (PDF p. 27, printed p. 17) is eleven hyperlinked captions, each ending in a number
from the DAK's reference list:

| DAK ref | Source | Read for |
|---|---|---|
| (29) | WHO recommendations for routine immunization – summary tables, **Tables 1, 2, 3, 4** (Dec 2025) | **342 recommendations**, each attributed to one of **29 WHO position papers** |
| (26) | Analysis and use of health facility data: guidance for immunization programme managers (2018) | 11 sections |
| (31) | Leave no one behind: guidance for planning and implementing catch-up vaccination (2021, ISBN 9789240016514) | 26 sections |
| (28) | Digital documentation of COVID-19 certificates: vaccination status (2021, IRIS 10665/343361) | 45 sections |
| (15) | Electronic immunization registry: practical considerations… (PAHO, 2017, ISBN 978-92-75-11953-2) | publication only (two-column contents, not parsed) |
| (32) | Monitoring metrics related to the global COVID-19 vaccination strategy (July 2022) | publication only (no contents page) |
| (30) | Sample of the WHO/UNICEF joint report form on immunization (2016, .xls) | publication only: data.unicef.org returns a Cloudflare challenge, so the file was **not** read |
| (24) | WHO Immunization data portal | publication only: a website |

The graph has three layers, connected the way the L1 model intends:

```
DAK (isbn-9789240099456)
 ├─ section 1.2
 ├─ citation "…position papers (29)" ──numberedAs──▶ reference-entry (29) ──resolvesTo──▶ summary tables (web page)
 │        └──────────────resolvesTo (the caption's hyperlink)──────────────▶ Table 1 / 2 / 3 / 4
 │
Table 1 ─contains─▶ footnote 2 "BCG" ◀─presentedIn─ recommendation ─definedIn─▶ BCG position paper
Table 2 ─contains─▶ footnote 2 "BCG" ◀─presentedIn─┘                             (IRIS 10665/260306)
```

- **A recommendation is stored once, wherever it is printed.** A summary table restates a position
  paper, so each bullet is `definedIn` the paper (its authority) and `presentedIn` the footnote or
  row that prints it. Tables 1 and 2 share their notes, so 243 of the 342 recommendations have more
  than one `presentedIn`. IRIs come from smart-kg's `tools/kgid.mjs`. A recommendation with no
  published number is content-addressed by its statement, so re-extracting gives the same nodes.
- **A position paper is identified by its IRIS handle, not by its link.** The tables link one paper
  up to four ways: an IRIS bitstream, an IRIS handle page, a who.int item page, or a who.int topic
  page. `tools/resolve-links.mjs` groups references by their **printed** citation (e.g.
  `Weekly Epid. Record (2018, 93:73-96)`) and follows the links to one IRIS item, in this order:
  1. a handle in the URL;
  2. the IRIS bitstream → item;
  3. the who.int page's IRIS download link;
  4. for links that only reach a topic page, an IRIS search on the antigen and the printed year, accepted only when there is exactly one hit.

  All 29 resolve. How each one did is recorded in `data/position-papers.json`, along with any IRIS items it rejected and why.
- **Table 4** (health care workers) is a two-column grid. Each row is a recommendation, and rows
  under its second header, *"No current recommendation for vaccination of Health Care Workers"*,
  are `kind: no-recommendation`. The table's `columnMap` fills the recommendation column from the
  recommendation's statement, so the words are stored once.

### Judgements, and where they are marked

Every node and edge read off a PDF is `derivation: inferred` and carries a `note` saying how it was
read and `evidence` saying where (file, page and quote). That is what smart-kg's validator requires.

- **34 recommendations carry `flagRef: multi-paper-footnote:<n>`.** The DTP footnote cites three
  position papers and the meningococcal footnote cites four. When a bullet names one of them
  ("Pertussis …"), the bullet is attributed to that paper. Otherwise it goes to the first listed and
  is flagged for a person to check.
- **Kind, direction and strength are not recorded** for Tables 1–3. The tables don't print them, and
  smart-kg's handbook-based model says not to invent them. The source position papers carry them;
  extracting those is the next step (see below).
- **GRC status of the position papers is left unrecorded**, so smart-kg's validator warns once per
  recommendation. Absent means "not recorded", and this graph doesn't assert it.

### Defects found in the sources

These were found while building the graph and are not corrected in it. Details are in [`graph/REPORT.md`](graph/REPORT.md).

- **Table 4 prints Japanese encephalitis's recommendation in the tick-borne encephalitis row**, word for
  word ("…not at special risk of contracting JE…").
- **Table 4's pneumococcal reference links the 2019 WER issue** (10665/310968) next to a printed 2025
  citation. Tables 1–3 link the 2025 paper.
- **Four printed citations carry an impossible WER volume.** RSV `(2025, 22:…)`, pneumococcal
  `(2025, 39:…)` and varicella `(2025, 47:…)` print the *issue* number where the volume (100)
  belongs. Mumps prints `(2024, 82:…)`, which is the 2007 volume.
- **Five antigens link only to a who.int topic page** (Hib, pertussis, HPV, measles, varicella), not to a
  paper. Measles is also linked directly from Table 4, so it resolves by link; the other four needed an
  IRIS search.

## Rebuilding

Requirements: Node ≥ 20, poppler-utils (`pdftohtml`, `pdftotext`), curl, and a checkout of
smart-kg beside this one (or `SMART_KG=<path>`).

```bash
node tools/fetch.mjs                 # download sources into sources/ (gitignored), verify sha256
node tools/resolve-links.mjs         # network: position papers -> WHO IRIS (writes data/)
SMART_KG=../smart-kg node tools/build-l1.mjs   # offline: graph/immunizations-l1.json + REPORT.md
node tools/to-cypher.mjs             # graph/immunizations-l1.cypher

# validate with smart-kg's own checks
(cd ../smart-kg && node tools/validate.mjs ../smart-kg-immunizations-l1/graph/immunizations-l1.json)
npx ajv validate --spec=draft2020 -c ajv-formats \
  -s ../smart-kg/shapes/recommendation-graph.schema.json -d graph/immunizations-l1.json
```

`fetch.mjs` refuses a source whose hash has moved. WHO revises the summary tables in place under
one URL, so a moved hash means the tables changed. Check what changed, then run `--repin`.

**Neo4j:** load `../smart-kg/ontology/l1/l1.cypher` (the type graph), then
`graph/immunizations-l1.cypher`. Instance nodes are labelled `:L1:<Class>` and joined to their
`:KGClass` by `INSTANCE_OF`. The Cypher has been generated but not yet run against a Neo4j instance.

## Why a committed graph

smart-kg's `docs/STORAGE.md` says instance graphs belong with their source rather than in git,
because a committed copy goes stale. This repository is that source-side home, for one snapshot:
every input is pinned by sha256 in `sources.json` and `wasDerivedFrom`, so you can check whether
the graph is stale by re-hashing the sources. It was built against smart-kg at
`3f5e477` (ontology 3.0).

## Not done yet

- **The position papers themselves.** The graph resolves each paper to IRIS but doesn't read it. Reading the 29
  WER papers would add direction, strength and certainty, and the GRADE tables behind them (key
  questions, outcomes, evidence). Those are L1 classes that this graph leaves empty.
- **The grid cells of Tables 1–3** (ages, doses, intervals). smart-kg treats a schedule as printed
  elements and L2 scheduling input, so it doesn't belong in a recommendation, and it isn't extracted.
- **L2.** Coverage (`smart-kg tools/l1-queries.mjs`) currently reports all 342 recommendations as
  unrepresented, because nothing above L1 points at them yet. Loading the immunization DAK's
  decision tables through `extract-citations.mjs` would join DMN rules to these nodes.
- Sections of the PAHO registry guide and the COVID-19 monitoring metrics; the JRF spreadsheet.

#!/usr/bin/env node
// Downloads every source in sources.json into sources/ and checks it against its pinned sha256.
//
// A source whose hash has moved is refused, not silently used: WHO revises the summary tables in
// place under one URL, and a graph built from a different file than the one it claims to be
// derived from is the stale copy docs/STORAGE.md in smart-kg warns about. Re-pin deliberately:
//
//   node tools/fetch.mjs            # download what is missing, verify everything
//   node tools/fetch.mjs --repin    # accept the files as they are now and rewrite the pins

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { download } from "./net.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "sources.json");
const DIR = join(ROOT, "sources");
const repin = process.argv.includes("--repin");

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
mkdirSync(DIR, { recursive: true });

let failed = false;
for (const src of [manifest.dak, ...manifest.sources]) {
  if (!src.file) {
    console.log(`  -  ${src.id}: ${src.unavailable ? "unavailable — " + src.unavailable : "web page, nothing to download"}`);
    continue;
  }
  const path = join(DIR, src.file);
  if (!existsSync(path)) {
    process.stdout.write(`  ↓  ${src.id} … `);
    try { download(src.download, path); console.log("ok"); }
    catch (err) { console.log(`failed: ${err.message}`); failed = true; continue; }
  }
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (repin) { src.sha256 = hash; console.log(`  ✓  ${src.id} pinned ${hash.slice(0, 12)}`); continue; }
  if (hash !== src.sha256) {
    console.error(`  ✗  ${src.id}: sha256 ${hash} does not match the pin ${src.sha256 || "(none)"}. ` +
                  `The source has changed; re-run with --repin once you have checked what changed.`);
    failed = true;
  } else {
    console.log(`  ✓  ${src.id}`);
  }
}
if (repin) writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
if (failed) process.exit(1);

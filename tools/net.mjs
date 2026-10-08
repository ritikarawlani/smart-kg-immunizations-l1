// Network access goes through curl rather than fetch(): curl honours HTTPS_PROXY and the system CA
// store without configuration, and Node's fetch does neither.

import { execFileSync } from "node:child_process";

const UA = "Mozilla/5.0 (smart-kg-immunizations-l1; +https://github.com/ritikarawlani/smart-kg-immunizations-l1)";

/** GET a URL into a file. Throws on any non-2xx status. */
export function download(url, out) {
  const code = execFileSync("curl", ["-sSL", "-m", "300", "-A", UA, "-o", out, "-w", "%{http_code}", url])
    .toString().trim();
  if (!/^2/.test(code)) throw new Error(`${url}: HTTP ${code}`);
}

/** GET a URL as text. Follows redirects; returns { code, body, finalUrl }. */
export function get(url) {
  const raw = execFileSync("curl", ["-sSL", "-m", "120", "-A", UA, "-w", "\n%{http_code} %{url_effective}", url],
    { maxBuffer: 64 << 20 }).toString("utf8");
  const nl = raw.lastIndexOf("\n");
  const [code, finalUrl] = raw.slice(nl + 1).split(" ");
  return { code: Number(code), body: raw.slice(0, nl), finalUrl };
}

export function getJson(url) {
  const r = get(url);
  if (r.code !== 200) throw new Error(`${url}: HTTP ${r.code}`);
  return JSON.parse(r.body);
}

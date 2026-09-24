#!/usr/bin/env node
/**
 * Repository secret scan. Run before every commit/push (`pnpm secret-scan`).
 * Scans every file git would track (tracked + untracked-not-ignored) and the
 * Next.js client bundle if it exists. Prints file names and rule names only —
 * never the matched value.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const RULES = [
  { name: "alebex-wt-token", re: /\bwt_[A-Za-z0-9_-]{20,}\b/g, allow: /wt_x{6,}|wt_y{6,}|wt_kUakA2ZbQDU9tpTcaacJb2wc12L1-4fg4PyB0ToainA/ },
  { name: "alebex-subprotocol-with-token", re: /alebex\.token\.(?!\$\{|<|\[|"|'|`)[A-Za-z0-9_-]{16,}/g },
  { name: "bearer-literal", re: /Bearer\s+(?!\$\{|<|\[|nope|abc\b)[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{20,}/g },
  { name: "twilio-sid", re: /\bAC[0-9a-f]{32}\b/g },
  { name: "private-key", re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
  { name: "generic-sk", re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
];

// Exact values of secrets configured locally (compared in memory, never printed).
const envSecrets = [];
if (existsSync(join(ROOT, ".env"))) {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m;
    const value = raw.replace(/^["']|["']$/g, "");
    if (/KEY|TOKEN|SECRET/.test(key) && value.length >= 12) envSecrets.push({ key, value });
  }
}

function listFiles() {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT }).toString("utf8");
  return out.split("\0").filter(Boolean);
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(js|json|html|map|txt)$/.test(name)) acc.push(p);
  }
  return acc;
}

const files = listFiles().map((f) => join(ROOT, f));
const bundle = walk(join(ROOT, "apps", "web", ".next", "static"));
const findings = [];
for (const file of [...files, ...bundle]) {
  if (file.endsWith(".env") || !existsSync(file)) continue;
  let text;
  try {
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binary
    text = buf.toString("utf8");
  } catch {
    continue;
  }
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      if (rule.allow && rule.allow.test(m[0])) continue;
      findings.push({ file: file.slice(ROOT.length + 1), rule: rule.name });
    }
  }
  for (const s of envSecrets) if (text.includes(s.value)) findings.push({ file: file.slice(ROOT.length + 1), rule: `value-of-${s.key}` });
}

if (existsSync(join(ROOT, ".git"))) {
  const tracked = execFileSync("git", ["ls-files", "-z", ".env"], { cwd: ROOT }).toString("utf8");
  if (tracked) findings.push({ file: ".env", rule: "env-file-tracked" });
}

if (findings.length) {
  console.error(`secret-scan: ${findings.length} finding(s)`);
  for (const f of findings) console.error(`  ${f.rule}  ${f.file}`);
  process.exit(1);
}
console.log(`secret-scan: clean (${files.length} repo files, ${bundle.length} client bundle files, ${envSecrets.length} local secret value(s) checked)`);

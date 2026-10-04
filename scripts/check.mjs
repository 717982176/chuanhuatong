import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const ignored = new Set(['node_modules', '.git', '.wrangler', 'dist', 'backups']);
const excluded = new Set(['wrangler.jsonc', '.dev.vars']);
const failures = [];
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || excluded.has(entry.name) || /^\.env(?:\.|$)/.test(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(filename);
    else if (entry.isFile()) files.push(filename);
  }
}
await walk(root);
const patterns = [
  ['Telegram bot token', /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub access token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['hard-coded runtime credential', /\b(?:BOT_TOKEN|TURNSTILE_SECRET|WEBHOOK_SECRET)\s*[:=]\s*["'][^"'\n]{16,}["']/],
];
for (const filename of files) {
  const relative = path.relative(root, filename);
  if (/\.(?:js|mjs|cjs)$/.test(filename)) {
    const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
    if (result.status !== 0) failures.push(`Syntax ${relative}: ${result.stderr || result.error?.message}`);
  }
  if (!/\.(?:js|mjs|cjs|md|json|jsonc|yml|yaml|example)$/.test(filename)) continue;
  const text = await readFile(filename, 'utf8');
  for (const [label, pattern] of patterns) {
    // Test fixtures use conspicuous synthetic credentials, never real account values.
    const scan = relative.startsWith(`tests${path.sep}`)
      ? text.replace(/(["'])(?:\d+:)?TEST_[A-Za-z0-9_-]+\1/g, "''") : text;
    if (pattern.test(scan)) failures.push(`${label} in ${relative} (value withheld)`);
  }
  if (!filename.endsWith('.md')) continue;
  for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const target = match[1];
    if (/^(?:[a-z]+:|#)/i.test(target)) continue;
    const local = path.resolve(path.dirname(filename), target.split('#')[0]);
    if (!local.startsWith(root) || !files.includes(local)) failures.push(`Broken document link ${relative}: ${target}`);
  }
}
if (failures.length) {
  failures.forEach(failure => console.error(failure));
  process.exitCode = 1;
} else console.log(`PASS syntax, document links and credential-pattern checks (${files.length} files)`);

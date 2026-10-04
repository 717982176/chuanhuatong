import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = new URL('../tests/', import.meta.url);
const suites = (await readdir(directory)).filter(name => name.endsWith('.cjs')).sort();
let failed = 0;
let cases = 0;
let next = 0;

function run(name) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(name, directory))], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('error', error => { output += error.message; });
    child.on('close', code => {
      clearTimeout(timer);
      const count = (output.match(/^PASS /gm) || []).length;
      if (code !== 0 || count === 0) {
        failed++;
        console.error(`FAIL ${name}\n${output}`);
      } else {
        cases += count;
        console.log(`PASS ${name}: ${count} cases`);
      }
      resolve();
    });
  });
}

await Promise.all(Array.from({ length: Math.min(4, suites.length) }, async () => {
  while (next < suites.length) await run(suites[next++]);
}));
if (!suites.length) failed++;
console.log(`${suites.length} suites, ${cases} cases passed, ${failed} suites failed`);
process.exitCode = failed ? 1 : 0;

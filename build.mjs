// Build step (dev-only): inlines src/styles.css and the seven src/*.js modules
// from src/shell.html into a single self-contained index.html — the project's
// actual deliverable. CDN tags (Chart.js, Google Fonts) are kept as-is per the
// brief (§4 allows CDN libraries that do real work). Run: node build.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');

const shell = read('src/shell.html');
const css = read('src/styles.css');
// same order as the shell's script tags — load order is behavior, keep it exact
const scripts = ['src/seeds.js', 'src/data.js', 'src/indicators.js', 'src/analysis.js', 'src/i18n.js', 'src/report.js', 'src/ui.js']
  .map((f) => `<script>\n// ═══ inlined from ${f} ═══\n${read(f)}</script>`)
  .join('\n');

let out = shell
  .replace('<link rel="stylesheet" href="src/styles.css">', () => `<style>\n${css}</style>`)
  .replace(/<script src="src\/[^"]+"><\/script>\r?\n?/g, '');
out = out.replace('</body>', () => `${scripts}\n</body>`);

// belt-and-braces: the final file must reference nothing under src/
if (/(?:src|href)="src\//.test(out)) {
  throw new Error('src/ reference leaked into the final file');
}
writeFileSync(new URL('index.html', import.meta.url), out);
console.log(`built index.html: ${(out.length / 1024).toFixed(0)} KB`);

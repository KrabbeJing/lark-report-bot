import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReportToPng } from '../src/render-v2.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const fixtureName = process.argv[2] || 'sample-rich';
const fixturePath = path.join(projectRoot, 'src', 'fixtures', `${fixtureName}.json`);
const outDir = path.join(projectRoot, 'out');
fs.mkdirSync(outDir, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outPath = path.join(outDir, `v2-${fixtureName}-${ts}.jpg`);

const report = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
console.log(`[render] fixture=${fixturePath}`);
console.log(`[render] -> ${outPath}`);

const t0 = Date.now();
await renderReportToPng(report, outPath);
console.log(`[render] done in ${Date.now() - t0}ms`);
console.log(outPath);

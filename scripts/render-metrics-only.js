import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { buildReportHtml } from '../src/render-v2.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const fixture = JSON.parse(fs.readFileSync(path.join(projectRoot, 'src/fixtures/sample-rich.json'), 'utf8'));
const html = buildReportHtml({ ...fixture, projects: [], managementCategories: [] });
const outPath = path.join(projectRoot, 'out', 'metrics-debug.png');

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.waitForFunction(() => window.__rendered === true, { timeout: 10000 });
await page.screenshot({ path: outPath, fullPage: true, type: 'png' });
await browser.close();
console.log('saved', outPath, fs.statSync(outPath).size);

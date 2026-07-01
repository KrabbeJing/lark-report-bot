import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDateTime } from './date-utils.js';
import { launchBrowser } from './puppeteer-launcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.resolve(__dirname, 'logo_row.png');

function loadLogoDataUri() {
  if (!fs.existsSync(LOGO_PATH)) return '';
  const buf = fs.readFileSync(LOGO_PATH);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

function renderList(items, emptyText) {
  if (!items?.length) {
    return `<div class="empty">${escapeHtml(emptyText)}</div>`;
  }
  return `<ol>${items.map(item => `<li><span>${escapeHtml(item.member)}</span>${escapeHtml(item.text)}</li>`).join('')}</ol>`;
}

function renderMembers(members) {
  if (!members.length) {
    return '<div class="empty">本周期暂无成员日报</div>';
  }
  return members.map(member => `
    <div class="member">
      <div class="member-name">${escapeHtml(member.name)}</div>
      <div class="member-meta">${member.reportCount} 份日报 / ${member.itemCount} 项事项</div>
    </div>
  `).join('');
}

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 1080px;
    background: #eef4f7;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    color: #12202f;
  }
  .canvas {
    width: 1080px;
    min-height: 1620px;
    background: linear-gradient(180deg, #f6fbfc 0%, #eef7f4 46%, #f8fafc 100%);
    padding-bottom: 52px;
  }
  .hero {
    padding: 76px 64px 66px;
    background: linear-gradient(135deg, #0f766e 0%, #047857 52%, #2563eb 100%);
    color: #fff;
  }
  .eyebrow {
    font-size: 24px;
    letter-spacing: 4px;
    opacity: 0.86;
    margin-bottom: 22px;
  }
  h1 {
    font-size: 74px;
    line-height: 1.12;
    font-weight: 800;
    margin-bottom: 22px;
  }
  .period {
    font-size: 30px;
    opacity: 0.92;
  }
  .metrics {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 18px;
    padding: 42px 52px 8px;
  }
  .metric {
    background: #fff;
    border: 1px solid #d9e6e9;
    border-radius: 8px;
    padding: 26px 22px;
    box-shadow: 0 10px 26px rgba(15, 118, 110, 0.08);
  }
  .metric-value {
    font-size: 48px;
    font-weight: 800;
    color: #0f766e;
    line-height: 1;
  }
  .metric-label {
    margin-top: 12px;
    font-size: 22px;
    color: #64748b;
  }
  .section {
    padding: 44px 52px 0;
  }
  .section-title {
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: 34px;
    font-weight: 800;
    margin-bottom: 24px;
  }
  .section-title::before {
    content: '';
    width: 8px;
    height: 34px;
    border-radius: 4px;
    background: #0f766e;
  }
  .panel {
    background: #fff;
    border: 1px solid #d9e6e9;
    border-radius: 8px;
    padding: 28px 32px;
    box-shadow: 0 10px 26px rgba(15, 23, 42, 0.06);
  }
  .summary {
    font-size: 25px;
    line-height: 1.8;
    color: #334155;
  }
  ol {
    list-style: none;
    counter-reset: item;
  }
  li {
    counter-increment: item;
    position: relative;
    padding: 16px 0 16px 56px;
    font-size: 25px;
    line-height: 1.72;
    color: #334155;
    border-bottom: 1px dashed #dce7ea;
  }
  li:last-child { border-bottom: none; }
  li::before {
    content: counter(item);
    position: absolute;
    left: 0;
    top: 20px;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: #e0f2f1;
    color: #0f766e;
    font-size: 20px;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  li span {
    display: inline-block;
    margin-right: 14px;
    font-weight: 800;
    color: #0f172a;
  }
  .members {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .member {
    border: 1px solid #d9e6e9;
    border-radius: 8px;
    padding: 20px 22px;
    background: #fbfefe;
  }
  .member-name {
    font-size: 26px;
    font-weight: 800;
    color: #0f172a;
    margin-bottom: 8px;
  }
  .member-meta {
    font-size: 20px;
    color: #64748b;
  }
  .empty {
    padding: 18px 0;
    font-size: 24px;
    color: #94a3b8;
  }
  .footer {
    padding: 48px 52px 0;
    text-align: center;
    color: #94a3b8;
    font-size: 20px;
  }
  .footer-logo {
    display: block;
    width: 420px;
    max-width: 70%;
    height: auto;
    margin: 0 auto 20px;
  }
`;

export function buildWeeklySummaryHtml(summary, options = {}) {
  const logoUri = loadLogoDataUri();
  const generated = formatDateTime(summary.generatedAt || new Date(), options.timezone || 'Asia/Shanghai');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>${CSS}</style>
</head>
<body>
  <main class="canvas">
    <header class="hero">
      <div class="eyebrow">数金小助手 · 项目组周报</div>
      <h1>${escapeHtml(summary.project || '项目组周报')}</h1>
      <div class="period">${escapeHtml(summary.weekStart)} 至 ${escapeHtml(summary.weekEnd)}</div>
    </header>

    <section class="metrics">
      <div class="metric"><div class="metric-value">${summary.reportCount}</div><div class="metric-label">日报数量</div></div>
      <div class="metric"><div class="metric-value">${summary.memberCount}</div><div class="metric-label">覆盖成员</div></div>
      <div class="metric"><div class="metric-value">${summary.itemCount}</div><div class="metric-label">工作事项</div></div>
    </section>

    <section class="section">
      <h2 class="section-title">本周概览</h2>
      <div class="panel summary">${escapeHtml(summary.summaryText)}</div>
    </section>

    <section class="section">
      <h2 class="section-title">重点事项</h2>
      <div class="panel">${renderList(summary.highlights, '暂无可汇总事项')}</div>
    </section>

    <section class="section">
      <h2 class="section-title">风险阻塞</h2>
      <div class="panel">${renderList(summary.riskItems, '暂无明确风险阻塞')}</div>
    </section>

    <section class="section">
      <h2 class="section-title">待跟进事项</h2>
      <div class="panel">${renderList(summary.followUpItems, '暂无明确待跟进事项')}</div>
    </section>

    <section class="section">
      <h2 class="section-title">成员覆盖</h2>
      <div class="panel members">${renderMembers(summary.members)}</div>
    </section>

    <footer class="footer">
      ${logoUri ? `<img class="footer-logo" src="${logoUri}" alt="logo">` : ''}
      <div>生成时间 ${escapeHtml(generated)}</div>
    </footer>
  </main>
</body>
</html>`;
}

export async function renderWeeklySummaryToPng(summary, outPath, options = {}) {
  const html = buildWeeklySummaryHtml(summary, options);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1.5 });
    await page.setContent(html, { waitUntil: 'load' });
    const isJpeg = /\.jpe?g$/i.test(outPath);
    await page.screenshot({
      path: outPath,
      fullPage: true,
      type: isJpeg ? 'jpeg' : 'png',
      quality: isJpeg ? 88 : undefined,
    });
  } finally {
    await browser.close();
  }
}

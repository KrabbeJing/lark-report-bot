import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './puppeteer-launcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ECHARTS_PATH = path.resolve(__dirname, '..', 'node_modules', 'echarts', 'dist', 'echarts.min.js');
const LOGO_PATH = path.resolve(__dirname, 'logo_row.png');

function loadEChartsSource() {
  return fs.readFileSync(ECHARTS_PATH, 'utf8');
}

function loadLogoDataUri() {
  if (!fs.existsSync(LOGO_PATH)) return '';
  const buf = fs.readFileSync(LOGO_PATH);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripPrefix(s) {
  return String(s ?? '').replace(/^\s*\d+[\.、]\s*/, '').trim();
}

function gaugeColor(pct) {
  if (pct >= 75) return '#10b981';
  if (pct >= 50) return '#3b82f6';
  if (pct >= 25) return '#f59e0b';
  return '#ef4444';
}

function pctLabel(pct) {
  if (pct == null) return '';
  if (pct >= 75) return '良好';
  if (pct >= 50) return '推进中';
  if (pct >= 25) return '需关注';
  return '滞后';
}

function multilineToHtml(s) {
  return escapeHtml(s).replace(/\n/g, '<br>');
}

function renderHero(report) {
  return `
  <header class="hero">
    <div class="hero-bg-1"></div>
    <div class="hero-bg-2"></div>
    <div class="hero-tag">数字金融部</div>
    <h1 class="hero-title">${escapeHtml(report.title)}</h1>
    <div class="hero-period">${escapeHtml(report.period)}</div>
  </header>`;
}

function renderMetricCard(metric, idx) {
  const cat = stripPrefix(metric.category);
  const pct = metric.completionPct;
  const color = gaugeColor(pct);
  return `
  <div class="metric-card">
    <div class="metric-cat">${escapeHtml(cat)}</div>
    <div class="metric-name">${escapeHtml(metric.name)}</div>
    <div class="gauge" id="gauge-${idx}" data-pct="${pct}" data-color="${color}"></div>
    <div class="metric-status" style="background:${color}1a;color:${color}">${pctLabel(pct)}</div>
    <div class="metric-stats">
      <div class="stat"><span class="stat-k">年度目标</span><span class="stat-v">${escapeHtml(metric.yearTarget || '-')}</span></div>
      <div class="stat-sep"></div>
      <div class="stat"><span class="stat-k">当前完成</span><span class="stat-v" style="color:${color}">${escapeHtml(metric.weekActual || '-')}</span></div>
    </div>
  </div>`;
}

function renderMetricsSection(metrics) {
  if (!metrics?.length) return '';
  return `
  <section class="section metrics-section">
    <div class="section-head">
      <span class="section-num">01</span>
      <h2 class="section-title">核心指标完成情况</h2>
    </div>
    <div class="metrics-grid">
      ${metrics.map((m, i) => renderMetricCard(m, i)).join('')}
    </div>
  </section>`;
}

function renderProjectCard(project) {
  const hasWeek = (project.weekHighlights || '').trim() !== '';
  const hasNext = (project.nextWeekPlan || '').trim() !== '';
  const isEmpty = !hasWeek && !hasNext;

  const weekBody = hasWeek
    ? `<div class="block-body">${multilineToHtml(project.weekHighlights)}</div>`
    : `<div class="block-body empty">待填写</div>`;
  const nextBody = hasNext
    ? `<div class="block-body">${multilineToHtml(project.nextWeekPlan)}</div>`
    : `<div class="block-body empty">待填写</div>`;

  return `
  <div class="project-card ${isEmpty ? 'project-empty' : ''}">
    <div class="project-head">
      <div class="project-name">${escapeHtml(project.name)}</div>
      ${isEmpty ? '<div class="project-badge">本周无内容</div>' : ''}
    </div>
    <div class="panel panel-week">
      <div class="panel-head"><span class="panel-icon week-icon"></span>本周重点事项</div>
      ${weekBody}
    </div>
    <div class="panel panel-next">
      <div class="panel-head"><span class="panel-icon next-icon"></span>下周工作计划</div>
      ${nextBody}
    </div>
  </div>`;
}

function renderProjectsSection(projects) {
  if (!projects?.length) return '';
  return `
  <section class="section projects-section">
    <div class="section-head">
      <span class="section-num">02</span>
      <h2 class="section-title">敏捷项目组工作进展</h2>
    </div>
    <div class="project-list">
      ${projects.map(renderProjectCard).join('')}
    </div>
  </section>`;
}

function renderBulletList(items) {
  if (!items?.length) return '<div class="block-body empty">待填写</div>';
  return `<ul class="bullets">${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
}

function renderManagementCard(cat) {
  const name = stripPrefix(cat.name);
  return `
  <div class="mgmt-card">
    <div class="mgmt-head">
      <div class="mgmt-name">${escapeHtml(name)}</div>
    </div>
    <div class="panel panel-week">
      <div class="panel-head"><span class="panel-icon week-icon"></span>本周工作进展</div>
      ${renderBulletList(cat.weekProgress)}
    </div>
    <div class="panel panel-next">
      <div class="panel-head"><span class="panel-icon next-icon"></span>下周工作计划</div>
      ${renderBulletList(cat.nextWeekPlan)}
    </div>
  </div>`;
}

function renderManagementSection(cats) {
  if (!cats?.length) return '';
  return `
  <section class="section mgmt-section">
    <div class="section-head">
      <span class="section-num">03</span>
      <h2 class="section-title">部门管理工作</h2>
    </div>
    <div class="mgmt-list">
      ${cats.map(renderManagementCard).join('')}
    </div>
  </section>`;
}

function renderFooter(logoDataUri) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  return `
  <footer class="report-footer">
    <div class="footer-line"></div>
    ${logoDataUri ? `<img class="footer-logo" src="${logoDataUri}" alt="logo">` : ''}
    <div class="footer-text">生成时间 ${escapeHtml(now)}</div>
  </footer>`;
}

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #f0f2fa; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB",
                 "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
    color: #1f2937;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    font-size: 24px;
  }
  .canvas {
    width: 1080px;
    margin: 0 auto;
    background: linear-gradient(180deg, #eff6ff 0%, #f0f9ff 40%, #ecfeff 100%);
    padding: 0 0 56px;
  }

  /* ========== HERO ========== */
  .hero {
    position: relative;
    padding: 96px 64px 88px;
    background: linear-gradient(135deg, #0c4a6e 0%, #0369a1 45%, #0891b2 80%, #06b6d4 100%);
    color: #fff;
    overflow: hidden;
  }
  .hero-bg-1 {
    position: absolute;
    width: 520px; height: 520px;
    border-radius: 50%;
    background: rgba(255,255,255,0.08);
    top: -200px; right: -140px;
  }
  .hero-bg-2 {
    position: absolute;
    width: 360px; height: 360px;
    border-radius: 50%;
    background: rgba(255,255,255,0.06);
    bottom: -140px; left: -100px;
  }
  .hero-tag {
    position: relative;
    display: inline-block;
    padding: 12px 28px;
    background: rgba(255,255,255,0.15);
    border: 1px solid rgba(255,255,255,0.35);
    border-radius: 100px;
    font-size: 24px;
    letter-spacing: 2px;
    margin-bottom: 36px;
    font-weight: 500;
  }
  .hero-title {
    position: relative;
    font-size: 96px;
    font-weight: 800;
    letter-spacing: -1px;
    margin-bottom: 28px;
    text-shadow: 0 4px 16px rgba(0,0,0,0.15);
    line-height: 1.1;
  }
  .hero-period {
    position: relative;
    font-size: 40px;
    font-weight: 500;
    opacity: 0.95;
    letter-spacing: 3px;
  }

  /* ========== SECTION ========== */
  .section {
    padding: 72px 56px 24px;
  }
  .section-head {
    display: flex;
    align-items: flex-end;
    gap: 24px;
    margin-bottom: 44px;
  }
  .section-num {
    font-size: 88px;
    font-weight: 800;
    background: linear-gradient(135deg, #0369a1, #06b6d4);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    line-height: 0.9;
    letter-spacing: -3px;
  }
  .section-title {
    font-size: 44px;
    font-weight: 700;
    color: #0f172a;
    letter-spacing: 1px;
    padding-bottom: 8px;
  }

  /* ========== METRICS ========== */
  .metrics-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 28px;
  }
  .metric-card {
    background: #fff;
    border-radius: 28px;
    padding: 36px 32px 32px;
    box-shadow: 0 12px 32px rgba(3, 105, 161, 0.08);
    border: 1px solid rgba(3, 105, 161, 0.1);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .metric-cat {
    display: inline-block;
    font-size: 22px;
    font-weight: 700;
    padding: 8px 22px;
    border-radius: 100px;
    margin-bottom: 18px;
    letter-spacing: 0.5px;
    line-height: 1.4;
    background: linear-gradient(135deg, #dbeafe 0%, #cffafe 100%);
    color: #0369a1;
  }
  .metric-name {
    font-size: 28px;
    font-weight: 700;
    color: #1f2937;
    margin-bottom: 12px;
    line-height: 1.35;
    min-height: 76px;
    display: flex;
    align-items: center;
    text-align: center;
  }
  .gauge {
    width: 240px;
    height: 240px;
    margin: 8px 0 8px;
  }
  .metric-status {
    display: inline-block;
    font-size: 22px;
    font-weight: 700;
    padding: 6px 20px;
    border-radius: 100px;
    margin: 4px 0 24px;
    letter-spacing: 1px;
  }
  .metric-stats {
    display: flex;
    align-items: center;
    justify-content: space-around;
    width: 100%;
    padding-top: 22px;
    border-top: 1px dashed #e5e7eb;
  }
  .stat-sep {
    width: 1px; height: 44px;
    background: #e5e7eb;
  }
  .stat { display: flex; flex-direction: column; gap: 6px; }
  .stat-k { font-size: 18px; color: #9ca3af; letter-spacing: 1px; }
  .stat-v { font-size: 26px; font-weight: 700; color: #111827; }

  /* ========== PROJECT / MGMT CARDS ========== */
  .project-list, .mgmt-list {
    display: flex;
    flex-direction: column;
    gap: 28px;
  }
  .project-card, .mgmt-card {
    background: #fff;
    border-radius: 28px;
    padding: 36px 40px;
    box-shadow: 0 12px 32px rgba(3, 105, 161, 0.08);
    border: 1px solid rgba(3, 105, 161, 0.1);
  }
  .project-card.project-empty { opacity: 0.78; }
  .project-head, .mgmt-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 28px;
    padding-bottom: 20px;
    border-bottom: 3px solid #f3f4f6;
  }
  .project-name, .mgmt-name {
    font-size: 36px;
    font-weight: 800;
    color: #0f172a;
    letter-spacing: 0.5px;
  }
  .project-badge {
    font-size: 18px;
    color: #9ca3af;
    background: #f3f4f6;
    padding: 6px 18px;
    border-radius: 100px;
    font-weight: 500;
  }

  /* === PANELS (本周/下周 distinct cards) === */
  .panel {
    border-radius: 20px;
    padding: 28px 28px 26px;
    margin-top: 24px;
  }
  .panel:first-of-type { margin-top: 0; }
  .panel-week {
    background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%);
    border-left: 6px solid #1d4ed8;
  }
  .panel-next {
    background: linear-gradient(135deg, #f0f9ff 0%, #cffafe 100%);
    border-left: 6px solid #0891b2;
  }
  .panel-head {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 26px;
    font-weight: 800;
    margin-bottom: 20px;
    padding-bottom: 14px;
    border-bottom: 2px solid rgba(0,0,0,0.06);
    letter-spacing: 0.5px;
  }
  .panel-week .panel-head { color: #1e40af; }
  .panel-next .panel-head { color: #0e7490; }
  .panel-icon {
    display: inline-block;
    width: 14px; height: 14px;
    border-radius: 50%;
  }
  .panel-week .panel-icon { background: #1d4ed8; }
  .panel-next .panel-icon { background: #0891b2; }

  .block-body {
    font-size: 24px;
    line-height: 1.85;
    color: #374151;
  }
  .block-body.empty {
    color: #9ca3af;
    font-style: italic;
    font-size: 22px;
  }

  /* bullets in mgmt */
  .bullets {
    list-style: none;
    padding-left: 0;
  }
  .bullets li {
    position: relative;
    padding: 14px 0 14px 32px;
    font-size: 24px;
    line-height: 1.75;
    color: #374151;
  }
  .bullets li::before {
    content: '';
    position: absolute;
    left: 8px; top: 28px;
    width: 10px; height: 10px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.4;
  }
  .panel-week .bullets li { color: #374151; }
  .panel-week .bullets li::before { background: #1d4ed8; opacity: 0.7; }
  .panel-next .bullets li::before { background: #0891b2; opacity: 0.7; }
  .bullets li + li { border-top: 1px dashed rgba(0,0,0,0.06); }

  /* ========== FOOTER ========== */
  .report-footer {
    padding: 56px 56px 0;
    text-align: center;
  }
  .footer-line {
    height: 1px;
    background: linear-gradient(90deg, transparent, #d1d5db, transparent);
    margin-bottom: 36px;
  }
  .footer-logo {
    max-width: 480px;
    width: 80%;
    height: auto;
    margin: 0 auto 24px;
    display: block;
  }
  .footer-text {
    font-size: 20px;
    color: #9ca3af;
    letter-spacing: 1px;
  }
`;

const INIT_SCRIPT = `
  function initGauges() {
    const els = document.querySelectorAll('.gauge');
    els.forEach(el => {
      const pct = parseFloat(el.dataset.pct);
      const color = el.dataset.color;
      const chart = echarts.init(el);
      chart.setOption({
        animation: false,
        series: [{
          type: 'gauge',
          startAngle: 90,
          endAngle: -270,
          radius: '92%',
          min: 0,
          max: 100,
          progress: {
            show: true,
            overlap: false,
            width: 22,
            roundCap: true,
            itemStyle: { color: color }
          },
          axisLine: {
            lineStyle: {
              width: 22,
              color: [[1, '#eef2f7']]
            }
          },
          pointer: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
          anchor: { show: false },
          title: { show: false },
          detail: {
            valueAnimation: false,
            formatter: function(v){ return Math.round(v*10)/10 + '%'; },
            offsetCenter: [0, '0%'],
            fontSize: 42,
            fontWeight: 'bold',
            color: '#0f172a'
          },
          data: [{ value: pct }]
        }]
      });
    });
    window.__rendered = true;
  }
  initGauges();
`;

export function buildReportHtml(report) {
  const echartsSrc = loadEChartsSource();
  const logoUri = loadLogoDataUri();
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>${CSS}</style>
</head>
<body>
  <div class="canvas">
    ${renderHero(report)}
    ${renderMetricsSection(report.metrics)}
    ${renderProjectsSection(report.projects)}
    ${renderManagementSection(report.managementCategories)}
    ${renderFooter(logoUri)}
  </div>
  <script>${echartsSrc}</script>
  <script>${INIT_SCRIPT}</script>
</body>
</html>`;
}

export async function renderReportToPng(report, outPath) {
  const html = buildReportHtml(report);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    // DPR=1.5 在 1080 宽下渲染 1620 实际像素，文字仍清晰；
    // 配合 JPEG quality 88，体积通常 < 2MB，远低于飞书 10MB 限制。
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1.5 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__rendered === true, { timeout: 10000 });
    const isJpeg = /\.jpe?g$/i.test(outPath);
    if (isJpeg) {
      await page.screenshot({ path: outPath, fullPage: true, type: 'jpeg', quality: 88 });
    } else {
      await page.screenshot({ path: outPath, fullPage: true, type: 'png' });
    }
  } finally {
    await browser.close();
  }
}

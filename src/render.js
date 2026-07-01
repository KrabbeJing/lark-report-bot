import { launchBrowser } from './puppeteer-launcher.js';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

function formatCell(cell) {
  if (cell == null) return '';
  if (Array.isArray(cell)) {
    return cell.map(seg => (typeof seg === 'object' ? (seg.text ?? '') : seg)).join('');
  }
  if (typeof cell === 'object') {
    return cell.text ?? JSON.stringify(cell);
  }
  return String(cell);
}

function cleanCell(text) {
  return text.replace(/\s*【[^】]*\/[^】]*】\s*/g, '').trim();
}

const SECTION_RE = /^\s*[一二三四五六七八九十百]+[、\.]/;
const NOTE_RE = /^(填写要求|说明|备注)[：:]/;

function formatDate(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function getReportPeriod(now = new Date()) {
  const dow = now.getDay();
  const daysToLastSunday = dow === 0 ? 7 : dow;
  const lastSunday = new Date(now);
  lastSunday.setDate(now.getDate() - daysToLastSunday);
  const lastMonday = new Date(lastSunday);
  lastMonday.setDate(lastSunday.getDate() - 6);
  return `${formatDate(lastMonday)}-${formatDate(lastSunday)}`;
}

export function normalizeSheet(values) {
  const stringified = values.map(row => row.map(c => cleanCell(formatCell(c))));

  let headerIdx = 0;
  for (let i = 0; i < Math.min(stringified.length, 10); i++) {
    const nonEmpty = stringified[i].filter(c => c.trim() !== '').length;
    if (nonEmpty >= 3) {
      headerIdx = i;
      break;
    }
  }

  const aboveHeader = stringified.slice(0, headerIdx);
  const mainTitle = aboveHeader[0]?.find(c => c.trim() !== '') || '';

  const periodValue = getReportPeriod();

  const preHeaderSections = aboveHeader
    .map(row => (row.find(c => c.trim() !== '') || '').trim())
    .filter(t => t && t !== mainTitle && !/周期|日期|时间|____/.test(t));

  const pageTitle = `${mainTitle}·${periodValue}`;

  const rawHeader = stringified[headerIdx] || [];
  const rawRows = stringified.slice(headerIdx + 1)
    .filter(row => row.some(c => c.trim() !== ''));

  const colCount = rawHeader.length;
  const keepIdx = [];
  for (let i = 0; i < colCount; i++) {
    const hasContent = (rawHeader[i]?.trim() !== '') || rawRows.some(r => (r[i] ?? '').trim() !== '');
    if (hasContent) keepIdx.push(i);
  }

  const header = keepIdx.map(i => rawHeader[i] ?? '');
  const trimmedRows = rawRows.map(row => keepIdx.map(i => row[i] ?? ''));

  const annotated = trimmedRows.map(row => {
    const firstIdx = row.findIndex(c => c.trim() !== '');
    if (firstIdx === -1) return null;
    const firstText = row[firstIdx].trim();
    const restEmpty = row.slice(firstIdx + 1).every(c => c.trim() === '');

    if (firstIdx === 0 && restEmpty && SECTION_RE.test(firstText)) {
      return { kind: 'section', text: firstText, cells: row };
    }
    if (firstIdx === 0 && restEmpty && NOTE_RE.test(firstText)) {
      return { kind: 'note', text: firstText, cells: row };
    }
    return { kind: 'data', cells: row };
  }).filter(Boolean).filter(r => r.kind !== 'note');

  const preSections = preHeaderSections
    .map(text => ({
      kind: SECTION_RE.test(text) ? 'section' : 'note',
      text,
      cells: header.map((_, i) => i === 0 ? text : ''),
    }))
    .filter(r => r.kind !== 'note');

  let groupIdx = -1;
  const withGroups = annotated.map(row => {
    if (row.kind === 'section') {
      groupIdx = -1;
      return row;
    }
    if ((row.cells[0] ?? '').trim() !== '') groupIdx++;
    return { ...row, groupIdx: Math.max(0, groupIdx) };
  });

  return {
    pageTitle,
    periodValue,
    header,
    rows: [...preSections, ...withGroups],
  };
}

export function buildHtml({ pageTitle, sheetTitle, header, rows }) {
  const colCount = header.length;
  const headerRowHtml = `<tr class="th-row">${header.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
  const dataCount = rows.filter(r => r.kind === 'data').length;

  const parts = [];
  let headerEmitted = false;
  const ensureHeader = () => {
    if (!headerEmitted) {
      parts.push(headerRowHtml);
      headerEmitted = true;
    }
  };
  for (const row of rows) {
    if (row.kind === 'section') {
      parts.push(`<tr class="section"><td colspan="${colCount}">${escapeHtml(row.text)}</td></tr>`);
      ensureHeader();
      continue;
    }
    ensureHeader();
    const groupStart = (row.cells[0] ?? '').trim() !== '';
    const groupCls = (row.groupIdx ?? 0) % 2 === 0 ? 'group-even' : 'group-odd';
    const cls = `data ${groupCls}${groupStart ? ' group-start' : ''}`;
    parts.push(`<tr class="${cls}">${row.cells.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`);
  }
  const bodyRows = parts.join('');

  const now = new Date().toLocaleString('zh-CN', { hour12: false });

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    padding: 48px 32px;
    color: #1a202c;
  }
  .card {
    background: #fff;
    border-radius: 20px;
    padding: 40px 36px;
    box-shadow: 0 24px 60px rgba(0,0,0,0.18);
    max-width: 1280px;
    margin: 0 auto;
  }
  .header {
    border-bottom: 2px solid #edf2f7;
    padding-bottom: 24px;
    margin-bottom: 28px;
  }
  h1 {
    font-size: 30px;
    font-weight: 700;
    background: linear-gradient(135deg, #667eea, #764ba2);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 6px;
  }
  .subtitle { color: #4a5568; font-size: 15px; margin-bottom: 12px; }
  .meta { color: #a0aec0; font-size: 13px; }
  table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    table-layout: fixed;
    word-wrap: break-word;
  }
  th {
    background: #f7fafc;
    padding: 14px 12px;
    text-align: left;
    font-weight: 600;
    color: #2d3748;
    border-bottom: 2px solid #e2e8f0;
    font-size: 13px;
  }
  td {
    padding: 14px 12px;
    border-bottom: 1px solid #edf2f7;
    vertical-align: top;
    font-size: 13px;
    line-height: 1.6;
    color: #2d3748;
  }
  tbody tr.data.group-even td { background: #f7fafc; }
  tbody tr.data.group-odd td { background: #ffffff; }
  tbody tr.data.group-start td {
    border-top: 2px solid #cbd5e0;
  }
  tbody tr.data.group-start td:first-child {
    font-weight: 700;
    color: #1a365d;
    font-size: 14px;
    letter-spacing: 0.3px;
  }
  tbody tr.data td:first-child {
    color: #2c5282;
    font-weight: 500;
  }
  tbody tr.section td {
    background: linear-gradient(90deg, #ebf4ff 0%, #f0e7ff 100%);
    color: #553c9a;
    font-weight: 700;
    font-size: 16px;
    padding: 20px 16px;
    border-bottom: 1px solid #d6bcfa;
    border-top: 1px solid #d6bcfa;
  }
  tr:last-child td { border-bottom: none; }
</style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>${escapeHtml(pageTitle || sheetTitle || '周报')}</h1>
      <div class="subtitle">${escapeHtml(sheetTitle || '')}</div>
      <div class="meta">生成时间 ${escapeHtml(now)} · 共 ${dataCount} 条记录</div>
    </div>
    <table>
      <tbody>${bodyRows}</tbody>
    </table>
  </div>
</body>
</html>`;
}

export async function renderToPng(html, outputPath) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1360, height: 800, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: outputPath, fullPage: true, type: 'png' });
  } finally {
    await browser.close();
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseSheetToReport } from './parsers.js';
import { renderReportToPng } from './render-v2.js';

export function extractSheetRef(text) {
  const sheetMatch = String(text || '').match(/\/sheets\/([A-Za-z0-9]+)/);
  if (sheetMatch) {
    const subSheetMatch = String(text || '').match(/[?#&]sheet=([A-Za-z0-9]+)/);
    return {
      type: 'sheet',
      spreadsheetToken: sheetMatch[1],
      sheetId: subSheetMatch ? subSheetMatch[1] : null,
    };
  }
  const wikiMatch = String(text || '').match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wikiMatch) {
    return { type: 'wiki', nodeToken: wikiMatch[1] };
  }
  return null;
}

export async function handleSheetPosterRequest({ client, messenger, message, text, outDir }) {
  const ref = extractSheetRef(text);
  if (!ref) {
    await messenger.replyText(message.message_id, '没找到表格链接，请在 @ 我时贴一个飞书电子表格或 wiki 链接');
    return;
  }

  console.log('[sheet-poster] sheet reference parsed', { type: ref.type, hasSheetId: Boolean(ref.sheetId) });
  let spreadsheetToken;
  let sheetId = ref.sheetId || null;
  let sheetTitle = '';

  if (ref.type === 'wiki') {
    const node = await resolveWikiNode(client, ref.nodeToken);
    console.log('[sheet-poster] wiki resolved', { objType: node.objType, hasTitle: Boolean(node.title) });
    if (node.objType !== 'sheet') {
      await messenger.replyText(message.message_id, `这个 wiki 节点是「${node.objType}」类型，目前只支持电子表格（sheet）`);
      return;
    }
    spreadsheetToken = node.objToken;
    sheetTitle = node.title;
  } else {
    spreadsheetToken = ref.spreadsheetToken;
  }

  if (!sheetId) {
    const sheets = await listSheets(client, spreadsheetToken);
    if (sheets.length === 0) {
      await messenger.replyText(message.message_id, '这张表里没有任何 sheet');
      return;
    }
    sheetId = sheets[0].sheet_id;
    if (!sheetTitle) sheetTitle = sheets[0].title;
    console.log('[sheet-poster] using first sheet');
  }

  const values = await readRange(client, spreadsheetToken, `${sheetId}!A1:Z200`);
  const report = parseSheetToReport(values);
  console.log('[sheet-poster] parsed', buildSheetPosterParsedLogMetadata(report));

  await messenger.replyText(
    message.message_id,
    `正在生成周报海报（${report.metrics.length} 项指标 / ${report.projects.length} 个项目组 / ${report.managementCategories.length} 个管理板块）...`,
  );

  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `report-${message.message_id}.jpg`);
  const t0 = Date.now();
  await renderReportToPng(report, outPath);
  console.log('[sheet-poster] rendered', buildSheetPosterRenderedLogMetadata(Date.now() - t0));

  const imageKey = await messenger.uploadImage(outPath);
  await messenger.replyImage(message.message_id, imageKey);
}

export function buildSheetPosterParsedLogMetadata(report) {
  return {
    metricCount: Array.isArray(report?.metrics) ? report.metrics.length : 0,
    projectCount: Array.isArray(report?.projects) ? report.projects.length : 0,
    managementCategoryCount: Array.isArray(report?.managementCategories)
      ? report.managementCategories.length
      : 0,
  };
}

export function buildSheetPosterRenderedLogMetadata(durationMs) {
  return { durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0 };
}

async function resolveWikiNode(client, nodeToken) {
  const res = await client.request({
    method: 'GET',
    url: `/open-apis/wiki/v2/spaces/get_node?token=${nodeToken}`,
  });
  const node = res.data?.node;
  if (!node) throw new Error('未找到 wiki 节点');
  return { objType: node.obj_type, objToken: node.obj_token, title: node.title };
}

async function listSheets(client, spreadsheetToken) {
  const res = await client.request({
    method: 'GET',
    url: `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`,
  });
  return res.data?.sheets || [];
}

async function readRange(client, spreadsheetToken, range) {
  const res = await client.request({
    method: 'GET',
    url: `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(range)}`,
  });
  return res.data?.valueRange?.values || [];
}

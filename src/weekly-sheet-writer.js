import { locateWeeklyTemplateTargets } from './weekly-template-locator.js';

export class WeeklySheetWriter {
  constructor(client) {
    this.client = client;
  }

  async ensureWeeklySheet(sheetConfig, { weekStart, weekEnd }) {
    assertWeeklySheetConfig(sheetConfig);
    const resolvedConfig = await this.resolveSheetConfig(sheetConfig);
    const title = renderWeeklySheetTitle(sheetConfig.titlePattern, { weekStart, weekEnd });

    if (sheetConfig.reuseExisting !== false) {
      const existing = await this.findSheetByTitle(resolvedConfig.spreadsheetToken, title);
      if (existing) {
        return { ...existing, title: existing.title || title, reused: true, created: false };
      }
    }

    if (sheetConfig.copyTemplate === false) {
      throw new Error('未找到本周实例，禁止直接写入周报模板');
    }

    return this.copyTemplateSheet(resolvedConfig, title);
  }

  async resolveSheetConfig(sheetConfig) {
    if (sheetConfig.spreadsheetToken) return sheetConfig;
    if (!sheetConfig.wikiNodeToken) return sheetConfig;

    const res = await this.client.request({
      method: 'GET',
      url: `/open-apis/wiki/v2/spaces/get_node?token=${sheetConfig.wikiNodeToken}`,
    });
    const node = res?.data?.node;
    if (!node) throw new Error(`未找到 wiki 节点：${sheetConfig.wikiNodeToken}`);
    if (node.obj_type !== 'sheet') {
      throw new Error(`wiki 节点 ${sheetConfig.wikiNodeToken} 是 ${node.obj_type} 类型，不是电子表格`);
    }
    return {
      ...sheetConfig,
      spreadsheetToken: node.obj_token,
    };
  }

  async findSheetByTitle(spreadsheetToken, title) {
    const sheets = await this.listSheets(spreadsheetToken);
    return sheets.find(sheet => sheet.title === title) || null;
  }

  async listSheets(spreadsheetToken) {
    const res = await this.client.request({
      method: 'GET',
      url: `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`,
    });
    return (res?.data?.sheets || []).map(sheet => {
      const grid = sheet.grid_properties || sheet.gridProperties || {};
      return {
        spreadsheetToken,
        sheetId: sheet.sheet_id || sheet.sheetId,
        title: sheet.title || '',
        index: sheet.index,
        rowCount: Number(grid.row_count || grid.rowCount || 0),
        columnCount: Number(grid.column_count || grid.columnCount || 0),
      };
    });
  }

  async readSheetValues(sheetConfig, sheetId, { endRow = 0 } = {}) {
    const resolvedConfig = await this.resolveSheetConfig(sheetConfig);
    const sheet = (await this.listSheets(resolvedConfig.spreadsheetToken))
      .find(item => item.sheetId === sheetId);
    if (!sheet) throw new Error(`周报工作表不存在：${sheetId}`);
    const rowCount = Number(endRow || sheet.rowCount);
    if (!rowCount) throw new Error(`周报工作表行数无效：${sheetId}`);

    const range = `${sheetId}!A1:C${rowCount}`;
    const res = await this.client.request({
      method: 'GET',
      url: `/open-apis/sheets/v2/spreadsheets/${resolvedConfig.spreadsheetToken}/values/${encodeURIComponent(range)}`,
    });
    return res?.data?.valueRange?.values || res?.data?.value_range?.values || [];
  }

  async discoverTemplateTargets(sheetConfig, sheetId, options = {}) {
    const values = await this.readSheetValues(sheetConfig, sheetId, options);
    return locateWeeklyTemplateTargets(values, options);
  }

  async copyTemplateSheet(sheetConfig, title) {
    if (!sheetConfig.templateSheetId) {
      throw new Error('weeklySheet.templateSheetId 未配置，无法复制周报模板 sheet');
    }

    const res = await this.client.request({
      method: 'POST',
      url: `/open-apis/sheets/v2/spreadsheets/${sheetConfig.spreadsheetToken}/sheets_batch_update`,
      data: {
        requests: [{
          copySheet: {
            source: {
              sheetId: sheetConfig.templateSheetId,
            },
            destination: {
              title,
            },
          },
        }],
      },
    });

    const copied = extractCopiedSheet(res);
    if (copied.sheetId) {
      return {
        spreadsheetToken: sheetConfig.spreadsheetToken,
        sheetId: copied.sheetId,
        title: copied.title || title,
        rowCount: copied.rowCount,
        columnCount: copied.columnCount,
        reused: false,
        created: true,
      };
    }

    const existing = await this.findSheetByTitle(sheetConfig.spreadsheetToken, title);
    if (existing) {
      return { ...existing, reused: false, created: true };
    }
    throw new Error(`复制周报模板 sheet 成功但未返回新 sheetId: ${JSON.stringify(res?.data || res)}`);
  }

  async moveSheet(sheetConfig, sheetId, targetIndex = 0) {
    const resolvedConfig = await this.resolveSheetConfig(sheetConfig);
    if (!String(resolvedConfig.spreadsheetToken || '').trim()) {
      throw new Error('weeklySheet.spreadsheetToken 为空，无法移动周报工作表');
    }
    if (!sheetId) throw new Error('sheetId 为空，无法移动周报工作表');
    if (!Number.isInteger(targetIndex) || targetIndex < 0) {
      throw new Error(`工作表目标位置无效：${targetIndex}`);
    }

    const sheets = await this.listSheets(resolvedConfig.spreadsheetToken);
    const sourceIndex = sheets.findIndex(sheet => sheet.sheetId === sheetId);
    if (sourceIndex < 0) throw new Error(`周报工作表不存在：${sheetId}`);
    const currentIndex = Number.isInteger(sheets[sourceIndex].index)
      ? sheets[sourceIndex].index
      : sourceIndex;
    if (currentIndex === targetIndex) {
      return {
        moved: false,
        skipped: true,
        reason: 'already_at_target_index',
        targetIndex,
        sourceIndex: currentIndex,
      };
    }

    const response = await this.client.request({
      method: 'POST',
      url: `/open-apis/sheet_ai/v2/spreadsheets/${resolvedConfig.spreadsheetToken}/tools/invoke_write`,
      data: {
        input: JSON.stringify({
          excel_id: resolvedConfig.spreadsheetToken,
          operation: 'move',
          sheet_id: sheetId,
          source_index: currentIndex,
          target_index: targetIndex,
        }),
        tool_name: 'modify_workbook_structure',
      },
    });
    return { moved: true, targetIndex, sourceIndex: currentIndex, response };
  }

  async writeCells(sheetConfig, sheetId, values) {
    assertWeeklySheetConfig(sheetConfig);
    const resolvedConfig = await this.resolveSheetConfig(sheetConfig);
    if (!sheetId) throw new Error('sheetId 为空，无法写入周报单元格');

    const valueRanges = Object.entries(values || {})
      .filter(([cell]) => Boolean(cell))
      .map(([cell, value]) => ({
        range: `${sheetId}!${cell}:${cell}`,
        values: [[value == null ? '' : String(value)]],
      }));

    if (!valueRanges.length) return { skipped: true, rangeCount: 0 };

    const res = await this.client.request({
      method: 'POST',
      url: `/open-apis/sheets/v2/spreadsheets/${resolvedConfig.spreadsheetToken}/values_batch_update`,
      data: { valueRanges },
    });
    return {
      skipped: false,
      rangeCount: valueRanges.length,
      response: res,
    };
  }
}

export function renderWeeklySheetTitle(pattern, { weekStart, weekEnd }) {
  return String(pattern || '数字金融部周报{{weekEndMMDD}}')
    .replaceAll('{{weekStart}}', weekStart || '')
    .replaceAll('{{weekEnd}}', weekEnd || '')
    .replaceAll('{{weekStartCompact}}', compactDate(weekStart))
    .replaceAll('{{weekEndCompact}}', compactDate(weekEnd))
    .replaceAll('{{weekEndMMDD}}', monthDay(weekEnd))
    .trim();
}

export function buildWeeklySheetUrl(sheetConfig, sheetId) {
  const token = sheetConfig?.spreadsheetToken || '';
  const base = sheetConfig?.spreadsheetUrl || `https://www.feishu.cn/sheets/${token}`;
  if (!sheetId) return base;
  try {
    const url = new URL(base);
    url.searchParams.set('sheet', sheetId);
    return url.toString();
  } catch {
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}sheet=${encodeURIComponent(sheetId)}`;
  }
}

function assertWeeklySheetConfig(sheetConfig) {
  if (!sheetConfig?.spreadsheetToken && !sheetConfig?.wikiNodeToken) {
    throw new Error('weeklySheet.spreadsheetToken/wikiNodeToken 未配置，无法生成周报 sheet');
  }
}

function extractCopiedSheet(res) {
  const replies = res?.data?.replies || res?.replies || [];
  const reply = replies.find(item => item.copySheet || item.copy_sheet) || {};
  const copied = reply.copySheet || reply.copy_sheet || res?.data?.copySheet || res?.data?.copy_sheet || {};
  const properties = copied.properties || copied.sheet || copied;
  const grid = properties.gridProperties || properties.grid_properties || {};
  return {
    sheetId: properties.sheetId || properties.sheet_id || copied.sheetId || copied.sheet_id || '',
    title: properties.title || copied.title || '',
    rowCount: Number(grid.rowCount || grid.row_count || 0),
    columnCount: Number(grid.columnCount || grid.column_count || 0),
  };
}

function compactDate(ymd) {
  return String(ymd || '').replace(/-/g, '.');
}

function monthDay(ymd) {
  const match = String(ymd || '').match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}${match[2]}` : '';
}

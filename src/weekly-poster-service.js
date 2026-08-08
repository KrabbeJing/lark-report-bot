import fs from 'node:fs/promises';
import path from 'node:path';
import { formatNaturalWeekPeriod } from './date-utils.js';
import { parseSheetToReport } from './parsers.js';
import { renderReportToPng } from './render-v2.js';

export class WeeklyPosterService {
  constructor({ sheetWriter, messenger, outDir }) {
    this.sheetWriter = sheetWriter;
    this.messenger = messenger;
    this.outDir = outDir;
  }

  async readSheet({ instance }) {
    const values = await this.sheetWriter.readSheetValues(
      instance.sheetConfig,
      instance.sheetId,
      { endRow: 200 },
    );
    const report = parseSheetToReport(values);
    return {
      report,
      sections: buildCurrentSections(report),
    };
  }

  async render({ sheet, instance }) {
    await fs.mkdir(this.outDir, { recursive: true });
    const outPath = path.join(this.outDir, `weekly-${safeFilePart(instance.instanceKey || 'report')}.png`);
    await renderReportToPng(sheet.report, outPath);
    return { ...sheet, outPath };
  }

  async renderTeam({ target, summary, instance }) {
    if (!summary?.sections?.length) throw new Error('small_team_no_content');
    await fs.mkdir(this.outDir, { recursive: true });
    const outPath = path.join(
      this.outDir,
      `weekly-${safeFilePart(instance.instanceKey || 'report')}-${safeFilePart(target.key || target.name || 'team')}.png`,
    );
    const report = {
      title: `${target.name || target.key || '团队'}周报`,
      period: formatNaturalWeekPeriod(instance.weekStart, instance.weekEnd)
        || `${instance.periodStart || ''}-${instance.periodEnd || ''}`,
      metrics: [],
      projects: summary.sections.map(section => ({
        name: section.name,
        weekHighlights: section.summaryText,
        nextWeekPlan: '',
      })),
      managementCategories: [],
    };
    await renderReportToPng(report, outPath);
    return { report, outPath, sections: summary.sections };
  }

  async validate({ poster }) {
    const stat = await fs.stat(poster.outPath);
    if (!stat.isFile() || stat.size <= 0) throw new Error('周报海报文件为空');
    return { valid: true, size: stat.size };
  }

  async sendDepartment({ poster, chatId, idempotencyKey }) {
    if (!chatId) throw new Error('missing_department_chat_id');
    const imageKey = poster.imageKey || await this.messenger.uploadImage(poster.outPath);
    await this.messenger.sendImage(chatId, imageKey, idempotencyKey);
    poster.imageKey = imageKey;
    return { imageKey };
  }

  async sendTeam(target, sections, idempotencyKey) {
    if (!target?.chatId) throw new Error('missing_small_team_chat_id');
    if (sections?.outPath) {
      const imageKey = sections.imageKey || await this.messenger.uploadImage(sections.outPath);
      await this.messenger.sendImage(target.chatId, imageKey, idempotencyKey);
      sections.imageKey = imageKey;
      return { sent: true, imageKey };
    }
    const lines = Object.entries(sections || {}).flatMap(([name, section]) => [
      `【${name}】`,
      sectionText(section),
    ]);
    const text = ['本周团队周报同步', '', ...lines].join('\n');
    await this.messenger.sendText(target.chatId, text, idempotencyKey);
    return { sent: true };
  }
}

function buildCurrentSections(report) {
  const sections = {};
  for (const project of report?.projects || []) {
    sections[project.name] = {
      module: 'module2',
      currentText: project.weekHighlights || '',
    };
  }
  for (const category of report?.managementCategories || []) {
    sections[category.name] = {
      module: 'module3',
      currentText: (category.weekProgress || []).filter(Boolean).join('\n'),
    };
  }
  return sections;
}

function sectionText(section) {
  return String(section?.currentText || '').trim() || '本期暂无已填写内容';
}

function safeFilePart(value) {
  return String(value || 'report').replace(/[^A-Za-z0-9_-]+/g, '_');
}

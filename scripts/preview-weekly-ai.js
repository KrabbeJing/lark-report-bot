import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { createAiProvider } from '../src/ai-providers.js';
import { BitableService } from '../src/bitable-service.js';
import { loadGroupConfig } from '../src/config.js';
import { buildLarkClientOptions } from '../src/lark-client.js';
import { runWeeklyAiPreviewCli } from '../src/weekly-ai-preview-cli.js';
import { runWeeklyAiPreview } from '../src/weekly-ai-preview.js';
import { WeeklySheetWriter } from '../src/weekly-sheet-writer.js';

const { APP_ID, APP_SECRET } = process.env;

await runWeeklyAiPreviewCli({
  createAiProvider,
  createClient: () => {
    if (!APP_ID || !APP_SECRET) throw new Error('APP_ID/APP_SECRET 未配置');
    return new lark.Client(buildLarkClientOptions({
      appId: APP_ID,
      appSecret: APP_SECRET,
      domain: lark.Domain.Feishu,
    }));
  },
  createBitable: client => new BitableService(client),
  createSheetWriter: client => new WeeklySheetWriter(client),
  loadConfig: loadGroupConfig,
  runPreview: runWeeklyAiPreview,
  mkdir,
  realpath,
  lstat,
  writeFile,
});

import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { BitableService } from '../src/bitable-service.js';
import { loadGroupConfig } from '../src/config.js';
import { buildLarkClientOptions } from '../src/lark-client.js';
import {
  runWeeklyClassificationLabelPreparationCli,
} from '../src/weekly-classification-label-preparation.js';
import { loadWeeklyConfiguration } from '../src/weekly-config-repository.js';

const { APP_ID, APP_SECRET } = process.env;

await runWeeklyClassificationLabelPreparationCli({
  loadConfig: loadGroupConfig,
  createClient: () => {
    if (!APP_ID || !APP_SECRET) throw new Error('APP_ID/APP_SECRET not configured');
    return new lark.Client(buildLarkClientOptions({
      appId: APP_ID,
      appSecret: APP_SECRET,
      domain: lark.Domain.Feishu,
    }));
  },
  createBitable: client => new BitableService(client),
  loadWeeklyConfiguration,
  readFile,
  mkdir,
  realpath,
  lstat,
  writeFile,
});

import 'dotenv/config';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createAiProvider } from '../src/ai-providers.js';
import { runWeeklyClassificationEvaluationCli } from '../src/weekly-classification-evaluation.js';

await runWeeklyClassificationEvaluationCli({
  createAiProvider,
  readFile,
  mkdir,
  realpath,
  lstat,
  writeFile,
});

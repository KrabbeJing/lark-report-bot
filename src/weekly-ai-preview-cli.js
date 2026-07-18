import path from 'node:path';
import { parseWeeklyAiPreviewArgs } from './weekly-ai-preview.js';

export async function runWeeklyAiPreviewCli({
  argv = process.argv.slice(2),
  createAiProvider,
  createClient,
  createBitable,
  createSheetWriter,
  loadConfig,
  runPreview,
  mkdir,
  realpath,
  lstat,
  writeFile,
  stdout = text => process.stdout.write(text),
  stderr = text => process.stderr.write(text),
  processRef = process,
} = {}) {
  try {
    const options = parseWeeklyAiPreviewArgs(argv);
    validateOutputPath(options.outputPath, processRef.cwd?.() || process.cwd());
    if (options.outputPath) {
      await mkdir(path.dirname(options.outputPath), { recursive: true });
      await validateOutputTarget({
        cwd: processRef.cwd?.() || process.cwd(),
        outputPath: options.outputPath,
        realpath,
        lstat,
      });
    }
    const aiProvider = createAiProvider();
    if (aiProvider.name !== 'openai-compatible') {
      throw new Error('weekly:ai-preview requires AI_PROVIDER=openai-compatible');
    }
    if (!String(aiProvider.apiKey || '').trim()) {
      throw new Error('weekly:ai-preview requires an AI API key');
    }

    const client = createClient();
    const result = await runPreview({
      config: loadConfig(),
      bitable: createBitable(client),
      sheetWriter: createSheetWriter(client),
      aiProvider,
      options,
    });
    const output = `${JSON.stringify(sanitizePreviewResult(result), null, 2)}\n`;
    if (options.outputPath) {
      await writeFile(options.outputPath, output, { encoding: 'utf8', flag: 'wx' });
    }
    stdout(output);
    return result;
  } catch (error) {
    const message = error?.message === 'weekly:ai-preview requires AI_PROVIDER=openai-compatible'
      ? error.message
      : 'weekly:ai-preview failed';
    stderr(`[weekly:ai-preview] ${message}\n`);
    processRef.exitCode = 1;
    return null;
  }
}

function sanitizePreviewResult(result) {
  if (!result || typeof result !== 'object') return result;
  return {
    ...result,
    warnings: Array.isArray(result.warnings)
      ? result.warnings.map(sanitizeWarning)
      : result.warnings,
  };
}

function sanitizeWarning(value) {
  return String(value || '')
    .replace(/\bAuthorization\s*[:=]\s*Bearer\s+[^\s,;]+/gi, '[masked]')
    .replace(/\b(?:AI_API_KEY|APP_SECRET)\b\s*[:=]\s*[^\s,;]+/gi, '[masked]')
    .replace(/\bresponse\s+body\b[^\n]*/gi, '[masked]');
}

function validateOutputPath(outputPath, cwd) {
  if (!outputPath) return;
  if (path.isAbsolute(outputPath) || path.win32.isAbsolute(outputPath)
    || outputPath.split(/[\\/]+/).includes('..')) {
    throw new Error('Invalid output path');
  }
  const relative = path.relative(cwd, path.resolve(cwd, outputPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid output path');
}

async function validateOutputTarget({ cwd, outputPath, realpath, lstat }) {
  const target = path.resolve(cwd, outputPath);
  const [realCwd, realParent] = await Promise.all([
    realpath(cwd),
    realpath(path.dirname(target)),
  ]);
  if (!isWithin(realCwd, realParent)) throw new Error('Invalid output path');

  try {
    await lstat(target);
    throw new Error('Invalid output path');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

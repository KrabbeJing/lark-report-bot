import fs from 'node:fs';
import puppeteer from 'puppeteer';

const DEFAULT_ARGS = ['--no-sandbox', '--disable-setuid-sandbox'];

const CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

export function resolveChromeExecutable() {
  return CHROME_CANDIDATES.find(candidate => fs.existsSync(candidate)) || '';
}

export async function launchBrowser(options = {}) {
  const executablePath = resolveChromeExecutable();
  const launchOptions = {
    headless: true,
    ...options,
    args: [...DEFAULT_ARGS, ...(options.args || [])],
  };

  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  try {
    return await puppeteer.launch(launchOptions);
  } catch (err) {
    err.message = `${err.message}\n请安装 Chrome，或在 .env 中配置 PUPPETEER_EXECUTABLE_PATH=/path/to/chrome`;
    throw err;
  }
}

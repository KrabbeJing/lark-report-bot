import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'src', 'logo_row.jpg');
const DST = path.resolve(__dirname, '..', 'src', 'logo_row.png');

const jpgB64 = fs.readFileSync(SRC).toString('base64');

const html = `<!DOCTYPE html><html><body style="margin:0;padding:0">
<img id="src" src="data:image/jpeg;base64,${jpgB64}" style="display:block">
<canvas id="cv"></canvas>
<script>
  const img = document.getElementById('src');
  const cv = document.getElementById('cv');
  img.onload = () => {
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, cv.width, cv.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i+1], b = px[i+2];
      const minBright = Math.min(r, g, b);
      if (minBright >= 250) {
        px[i+3] = 0;
      } else if (minBright > 200) {
        px[i+3] = Math.round((250 - minBright) * 255 / 50);
      }
    }
    ctx.putImageData(data, 0, 0);
    window.__pngDataUrl = cv.toDataURL('image/png');
    window.__done = true;
  };
  if (img.complete) img.onload();
</script>
</body></html>`;

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__done === true, { timeout: 20000 });
  const dataUrl = await page.evaluate(() => window.__pngDataUrl);
  const pngB64 = dataUrl.split(',')[1];
  fs.writeFileSync(DST, Buffer.from(pngB64, 'base64'));
  console.log('saved', DST, fs.statSync(DST).size, 'bytes');
} finally {
  await browser.close();
}

/**
 * Generates frontend/assets/icon.icns and frontend/assets/dmg-background.png
 * Uses Playwright (root node_modules) + macOS sips/iconutil.
 * Run once: node build-icon.mjs
 */

import { chromium } from '../node_modules/playwright/index.mjs';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, 'assets');
mkdirSync(ASSETS, { recursive: true });

// ─── Icon HTML ────────────────────────────────────────────────────────────────

const ICON_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1024px; height: 1024px; overflow: hidden; background: transparent; }
  body {
    background: radial-gradient(ellipse at 38% 36%, #211050 0%, #0D0A1F 62%);
    display: flex; align-items: center; justify-content: center;
  }
</style>
</head>
<body>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg" cx="38%" cy="36%" r="70%">
      <stop offset="0%" stop-color="#211050"/>
      <stop offset="100%" stop-color="#0D0A1F"/>
    </radialGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#7C5CFF" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#7C5CFF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="body-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3D2A8A"/>
      <stop offset="100%" stop-color="#1E1050"/>
    </linearGradient>
    <linearGradient id="stroke-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#9B7FFF"/>
      <stop offset="100%" stop-color="#5C3FCC"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="1024" height="1024" fill="url(#bg)"/>

  <!-- Ambient glow -->
  <ellipse cx="512" cy="510" rx="370" ry="360" fill="url(#glow)"/>

  <!-- ── Briefcase ── centered, 580px wide -->
  <!-- Handle -->
  <path d="M390 390 L390 330 Q390 278 440 278 L584 278 Q634 278 634 330 L634 390"
    fill="none" stroke="url(#stroke-grad)" stroke-width="52" stroke-linecap="round" stroke-linejoin="round"/>

  <!-- Body -->
  <rect x="172" y="390" width="680" height="460" rx="72" fill="url(#body-fill)" stroke="url(#stroke-grad)" stroke-width="44"/>

  <!-- Mid divider -->
  <rect x="172" y="590" width="680" height="44" fill="#7C5CFF" opacity="0.18"/>

  <!-- Clasp -->
  <rect x="456" y="568" width="112" height="88" rx="22" fill="#7C5CFF" opacity="0.9"/>
  <rect x="478" y="590" width="68" height="44" rx="12" fill="#B8A4FF" opacity="0.7"/>
</svg>
</body>
</html>`;

// ─── DMG background HTML ──────────────────────────────────────────────────────

const DMG_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1080px; height: 760px; overflow: hidden; }
  body {
    background: radial-gradient(ellipse at 30% 50%, #1A0F3D 0%, #0D0A1F 60%);
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 120px;
    font-family: -apple-system, system-ui, sans-serif;
  }
  .side { display: flex; flex-direction: column; align-items: center; gap: 20px; }
  .label {
    color: rgba(200,197,214,0.6);
    font-size: 22px;
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .icon-placeholder {
    width: 140px; height: 140px;
    border-radius: 32px;
    background: rgba(124,92,255,0.12);
    border: 1.5px solid rgba(124,92,255,0.3);
  }
  .arrow {
    color: rgba(124,92,255,0.5);
    font-size: 64px;
    margin: 0 20px;
    align-self: center;
  }
  .title {
    position: absolute;
    top: 60px; left: 50%;
    transform: translateX(-50%);
    color: rgba(200,197,214,0.25);
    font-size: 15px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }
</style>
</head>
<body>
  <div class="title">career-ops</div>
  <div class="side">
    <div class="icon-placeholder"></div>
    <div class="label">career-ops</div>
  </div>
  <div class="arrow">→</div>
  <div class="side">
    <div class="icon-placeholder" style="background:rgba(255,255,255,0.04); border-color:rgba(255,255,255,0.1)"></div>
    <div class="label">Applications</div>
  </div>
</body>
</html>`;

// ─── Render ───────────────────────────────────────────────────────────────────

async function render(html, width, height, outPath) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width, height });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.screenshot({ path: outPath, type: 'png' });
  await browser.close();
  console.log(`  rendered → ${outPath}`);
}

// ─── Build .icns ──────────────────────────────────────────────────────────────

function buildIconset(src1024) {
  const iconset = join(ASSETS, 'icon.iconset');
  if (existsSync(iconset)) rmSync(iconset, { recursive: true });
  mkdirSync(iconset);

  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const s of sizes) {
    execSync(`sips -z ${s} ${s} "${src1024}" --out "${join(iconset, `icon_${s}x${s}.png`)}" --setProperty format png`, { stdio: 'inherit' });
    if (s <= 512) {
      execSync(`sips -z ${s*2} ${s*2} "${src1024}" --out "${join(iconset, `icon_${s}x${s}@2x.png`)}" --setProperty format png`, { stdio: 'inherit' });
    }
  }

  const icns = join(ASSETS, 'icon.icns');
  execSync(`iconutil -c icns "${iconset}" -o "${icns}"`);
  rmSync(iconset, { recursive: true });
  console.log(`  .icns    → ${icns}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('Building icon…');
const icon1024 = join(ASSETS, 'icon-1024.png');
await render(ICON_HTML, 1024, 1024, icon1024);
buildIconset(icon1024);

console.log('Building DMG background…');
const dmgBg = join(ASSETS, 'dmg-background.png');
await render(DMG_HTML, 1080, 760, dmgBg);

console.log('Done.');

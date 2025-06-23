// scripts/install-chromium.js
import { execSync } from 'child_process';

try {
  execSync('PUPPETEER_PRODUCT=chrome npm install puppeteer', { stdio: 'inherit' });
  console.log('✅ Chromium installed via Puppeteer');
} catch (err) {
  console.error('❌ Failed to install Chromium:', err);
  process.exit(1);
}

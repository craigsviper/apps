import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const distHtml = path.join(rootDir, 'dist', 'index.html');
const androidAssetsDir = path.join(rootDir, 'android', 'app', 'src', 'main', 'assets');
const targetHtml = path.join(androidAssetsDir, 'index.html');

console.log('🔄 Syncing web build assets to Android Studio assets...');

if (!fs.existsSync(distHtml)) {
  console.error('❌ Error: dist/index.html not found. Run "npm run build" or "vite build" first.');
  process.exit(1);
}

if (!fs.existsSync(androidAssetsDir)) {
  fs.mkdirSync(androidAssetsDir, { recursive: true });
}

// Copy dist/index.html to android/app/src/main/assets/index.html
fs.copyFileSync(distHtml, targetHtml);
console.log(`✅ Copied ${distHtml} -> ${targetHtml}`);

// Copy public/leaflet if exists
const publicLeaflet = path.join(rootDir, 'public', 'leaflet');
const targetLeaflet = path.join(androidAssetsDir, 'leaflet');

if (fs.existsSync(publicLeaflet)) {
  if (!fs.existsSync(targetLeaflet)) {
    fs.mkdirSync(targetLeaflet, { recursive: true });
  }
  const files = fs.readdirSync(publicLeaflet);
  for (const file of files) {
    const src = path.join(publicLeaflet, file);
    const dest = path.join(targetLeaflet, file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, dest);
    }
  }
  console.log(`✅ Copied Leaflet icons to ${targetLeaflet}`);
}

console.log('🎉 Android assets sync complete! Ready for Android Studio.');

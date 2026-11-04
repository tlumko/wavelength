// Copies the browser bundle of preact+htm into public/vendor (no CDN at runtime).
import { copyFileSync, mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const src = new URL('node_modules/htm/preact/standalone.module.js', root);
const dir = new URL('public/vendor/', root);

mkdirSync(dir, { recursive: true });
copyFileSync(src, new URL('preact-htm.js', dir));
console.log('vendored public/vendor/preact-htm.js');

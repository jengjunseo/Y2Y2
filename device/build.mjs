import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
await build({ entryPoints: { 'device-app': 'device/app.js', 'device-worker': 'device/worker.js' },
  bundle: true, format: 'esm', outdir: 'backend/public', target: ['es2022'], minify: true });
await writeFile('backend/public/style.css', await readFile('public/personal.css', 'utf8') +
  '\n.choices{grid-template-columns:1fr auto}.download{display:inline-block;background:#c4e7a6;color:#192117;text-decoration:none;font-weight:700;border-radius:10px;padding:8px 14px}.job-actions{flex-wrap:wrap}#title{overflow-wrap:anywhere}@media(max-width:560px){.input-row{align-items:stretch;flex-direction:column}.choices{grid-template-columns:1fr}}\n');

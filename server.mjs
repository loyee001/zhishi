import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createSeed, validatePlant, applyCare } from './dist/model.js';
import { createPlantPhotoStore } from './plant-photos.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, 'dist');
const basePath = (process.env.BASE_PATH || '').replace(/\/$/, '');
if (basePath && !/^\/(?:[A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_-]+)*$/.test(basePath)) throw new Error('BASE_PATH 必须是以 / 开始的路径，例如 /plants');
let publicOrigin = '';
let publicHost = '';
if (process.env.PUBLIC_ORIGIN) {
  const configured = new URL(process.env.PUBLIC_ORIGIN);
  if (configured.protocol !== 'https:' || configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash) throw new Error('PUBLIC_ORIGIN 必须是完整的 HTTPS 来源，例如 https://f.qdfb.tech');
  publicOrigin = configured.origin;
  publicHost = configured.host;
}
const dataDir = process.env.PLANT_DATA_DIR || path.join(root, 'data');
const dataFile = path.join(dataDir, 'plants.json');
const plantPhotos = createPlantPhotoStore({ cacheDir: path.join(dataDir, 'plant-photos') });
const port = Number(process.env.PORT || 4188);
await mkdir(dataDir, { recursive: true });
let state;
try { state = JSON.parse(await readFile(dataFile, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw new Error(`养护数据无法读取，已保留原文件：${error.message}`); state = createSeed(); await writeFile(dataFile, JSON.stringify(state, null, 2)); }
if (state.version !== 1 || !Array.isArray(state.plants) || !Array.isArray(state.history)) throw new Error('养护数据格式无效，已保留原文件');
let queue = Promise.resolve();
function mutate(change) {
  const job = queue.then(async () => {
    const next = structuredClone(state);
    change(next);
    await writeFile(`${dataFile}.tmp`, JSON.stringify(next, null, 2));
    await rename(`${dataFile}.tmp`, dataFile);
    state = next;
    return state;
  });
  queue = job.catch(() => {});
  return job;
}
function json(res, status, payload) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); }
async function body(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 2000000) { const e = new Error('图片过大，请选择较小的图片'); e.status = 413; throw e; } chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('请求数据格式不正确'); }
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const host = req.headers.host;
    const boundPort = server.address().port;
    const localHost = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`].includes(host);
    if (!localHost && (!publicHost || host !== publicHost)) return json(res, 403, { error: '访问来源不允许' });
    // The proxy must retain the original Host. Forwarded headers are not an
    // authority for accepting new hosts or origins.
    if (!req.url.startsWith('/') || req.url.startsWith('//')) return json(res, 400, { error: '请求路径无效' });
    const url = new URL(req.url, `http://${host}`);
    if (basePath && url.pathname === basePath) {
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 404, { error: '页面不存在' });
      res.writeHead(308, { Location: `${basePath}/${url.search}`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (basePath && !url.pathname.startsWith(`${basePath}/`)) return json(res, 404, { error: '页面不存在' });
    const pathname = url.pathname.slice(basePath.length);
    if (pathname.startsWith('/api/')) {
      const allowedOrigins = new Set([...(localHost ? [`http://${host}`] : []), ...(publicOrigin ? [publicOrigin] : [])]);
      if ((req.headers.origin && !allowedOrigins.has(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '不允许跨站访问数据' });
      if (req.method === 'GET' && pathname === '/api/config') return json(res, 200, { basePath, hosted: Boolean(publicOrigin) });
      if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, state);
      if (req.method === 'GET' && pathname === '/api/plant-photo') {
        const result = await plantPhotos.match(url.searchParams.get('name'));
        return json(res, 200, result.imageUrl ? { ...result, imageUrl: `${basePath}${result.imageUrl}` } : result);
      }
      if (['GET', 'HEAD'].includes(req.method) && pathname.startsWith('/api/plant-photos/')) {
        const photo = await plantPhotos.image(pathname.slice('/api/plant-photos/'.length));
        if (!photo) return json(res, 404, { error: '图片不存在' });
        res.writeHead(200, { 'Content-Type': photo.type, 'Cache-Control': 'public, max-age=31536000, immutable' });
        return res.end(req.method === 'HEAD' ? undefined : photo.bytes);
      }
      if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return json(res, 404, { error: '接口不存在' });
      if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '请使用JSON请求' });
      const input = await body(req);
      let result;
      if (pathname === '/api/plants' && req.method === 'POST') {
        const plant = validatePlant(input);
        result = await mutate(s => s.plants.push({ ...plant, id: crypto.randomUUID(), isDemo: false }));
      } else if (/^\/api\/plants\/[^/]+$/.test(pathname)) {
        const id = decodeURIComponent(pathname.split('/').at(-1));
        if (req.method === 'PUT') {
          const plant = validatePlant(input);
          result = await mutate(s => {
            const index = s.plants.findIndex(p => p.id === id);
            if (index < 0) throw new Error('植物已被移除');
            const revision = s.plants[index].revision || 0;
            if (input.revision !== revision) { const e = new Error('这盆植物刚刚有了新记录。请关闭并重新打开编辑框，避免覆盖最新养护。'); e.status = 409; throw e; }
            s.plants[index] = { ...plant, id, isDemo: false, revision: revision + 1 };
          });
        } else if (req.method === 'DELETE') {
          result = await mutate(s => { if (!s.plants.some(p => p.id === id)) throw new Error('植物已被移除'); s.plants = s.plants.filter(p => p.id !== id); });
        }
      } else if (pathname === '/api/care' && req.method === 'POST') result = await mutate(s => applyCare(s, input));
      if (!result) return json(res, 404, { error: '接口不存在' });
      return json(res, 200, result);
    }
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '请求方法不支持' });
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const filename = path.resolve(publicRoot, relative);
    if (!filename.startsWith(`${publicRoot}${path.sep}`)) return json(res, 403, { error: '无法访问此文件' });
    const file = await readFile(filename);
    res.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return json(res, 404, { error: '页面不存在' });
    if (error.code) console.error(error);
    json(res, error.status || (error.code ? 500 : 400), { error: error.code ? '保存暂时失败，请重试。原有数据已保留。' : error.message });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`植时已启动：http://127.0.0.1:${server.address().port}${basePath}/\n养护数据：${dataFile}`));
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 正在使用。请设置其他 PORT 后启动。` : error); process.exitCode = 1; });

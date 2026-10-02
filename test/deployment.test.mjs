import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';

const origin = 'https://f.qdfb.tech';
const jpeg = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
const hash = value => createHash('sha256').update(value).digest('hex');

async function start(t, settings = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'zhishi-deployment-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: '0', PLANT_DATA_DIR: directory, PUBLIC_ORIGIN: '', BASE_PATH: '', ...settings },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = ''; let errors = '';
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), 5000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${errors}`)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const call = (path, { method = 'GET', headers = {}, payload } = {}) => new Promise((resolve, reject) => {
    const bytes = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: {
      ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}), ...headers
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(body.toString('utf8')) });
      });
    });
    req.on('error', reject); req.end(bytes);
  });
  return { directory, port, call };
}

test('hosted subpath routes APIs and static assets without exposing other root paths', async t => {
  const { call, directory } = await start(t, { PUBLIC_ORIGIN: origin, BASE_PATH: '/plants', TZ: 'Asia/Shanghai' });
  const headers = { Host: 'f.qdfb.tech', Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const config = await call('/plants/api/config', { headers });
  assert.equal(config.status, 200);
  assert.deepEqual(config.json(), { basePath: '/plants', hosted: true });
  for (const path of ['/plants/', '/plants/app.js', '/plants/model.js', '/plants/style.css', '/plants/sw.js', '/plants/assets/plant-placeholder.svg']) {
    assert.equal((await call(path, { headers })).status, 200, path);
  }
  assert.match((await call('/plants/sw.js', { headers })).headers['content-type'], /javascript/);
  assert.equal((await call('/plants/style.css', { method: 'HEAD', headers })).body.length, 0);
  const redirect = await call('/plants?from=home', { headers });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, '/plants/?from=home');
  for (const path of ['/', '/api/state', '/api/config', '/style.css', '/plants-other/api/state', '/plants/data/plants.json', '/plants/%2e%2e%2fserver.mjs']) {
    assert.ok([403, 404].includes((await call(path, { headers })).status), path);
  }
  const state = (await call('/plants/api/state', { headers })).json();
  const input = { ...state.plants[0], name: '上线测试植物' };
  const saved = await call('/plants/api/plants', { method: 'POST', headers, payload: input });
  assert.equal(saved.status, 200);
  const plant = saved.json().plants.at(-1);
  const edited = await call(`/plants/api/plants/${plant.id}`, {
    method: 'PUT', headers, payload: { ...plant, name: '子路径保存正常', revision: plant.revision || 0 }
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json().plants.at(-1).name, '子路径保存正常');
  const editedPlant = edited.json().plants.at(-1);
  const care = await call('/plants/api/care', { method: 'POST', headers, payload: {
    plantId: plant.id, type: 'water', action: 'skip', expectedRevision: editedPlant.revision,
    expected: `${editedPlant.water.nextDate}T${editedPlant.water.time}`
  } });
  assert.equal(care.status, 200);
  assert.equal(care.json().history[0].plantId, plant.id);
  const removed = await call(`/plants/api/plants/${plant.id}`, { method: 'DELETE', headers, payload: {} });
  assert.equal(removed.status, 200);
  assert.equal(removed.json().plants.length, state.plants.length);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'plants.json'), 'utf8')), removed.json());
});

test('hosted origin is exact, local access remains available, and forwarded headers do not grant trust', async t => {
  const { call, port } = await start(t, { PUBLIC_ORIGIN: origin, BASE_PATH: '/plants' });
  assert.equal((await call('/plants/api/config', { headers: { Host: 'f.qdfb.tech', Origin: origin } })).status, 200);
  assert.equal((await call('/plants/api/config', { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await call('/plants/api/config', { headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` } })).status, 200);
  for (const invalid of ['http://f.qdfb.tech', 'https://f.qdfb.tech.evil.example', 'https://evil.example', 'null', `${origin}/plants`, `http://127.0.0.1:${port}`]) {
    const headers = { Host: 'f.qdfb.tech', Origin: invalid, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'f.qdfb.tech' };
    assert.equal((await call('/plants/api/state', { headers })).status, 403, invalid);
    assert.equal((await call('/plants/api/plants', { method: 'POST', headers, payload: {} })).status, 403, invalid);
  }
  for (const host of ['evil.example', 'f.qdfb.tech.evil.example', 'f.qdfb.tech:1234']) {
    assert.equal((await call('/plants/api/config', { headers: { Host: host, Origin: origin, 'X-Forwarded-Host': 'f.qdfb.tech', 'Forwarded': 'host=f.qdfb.tech;proto=https' } })).status, 403);
  }
  const crossSite = { Host: 'f.qdfb.tech', Origin: origin, 'Sec-Fetch-Site': 'cross-site' };
  for (const path of ['/plants/api/state', '/plants/api/config', '/plants/api/plant-photo?name=x']) {
    assert.equal((await call(path, { headers: crossSite })).status, 403);
  }
  assert.equal((await call('/plants/api/plants', { method: 'POST', headers: crossSite, payload: {} })).status, 403);
});

test('cached automatic photos gain the deployment path without changing cache metadata', async t => {
  const { call, directory } = await start(t, { PUBLIC_ORIGIN: origin, BASE_PATH: '/plants' });
  const cacheDir = join(directory, 'plant-photos');
  await mkdir(cacheDir, { recursive: true });
  const filename = `${hash(jpeg)}.jpg`;
  const photo = { status: 'matched', imageUrl: `/api/plant-photos/${filename}`, matchedName: '绿萝', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Plant.jpg', author: 'Test', license: 'CC0 1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' };
  const metadata = join(cacheDir, `${hash('绿萝')}.json`);
  await writeFile(metadata, JSON.stringify(photo));
  await writeFile(join(cacheDir, filename), jpeg);
  const headers = { Host: 'f.qdfb.tech', Origin: origin };
  const matched = await call(`/plants/api/plant-photo?name=${encodeURIComponent('绿萝')}`, { headers });
  assert.equal(matched.status, 200);
  assert.deepEqual(matched.json(), { ...photo, imageUrl: `/plants${photo.imageUrl}` });
  const image = await call(matched.json().imageUrl, { headers });
  assert.equal(image.status, 200);
  assert.equal(image.headers['content-type'], 'image/jpeg');
  assert.deepEqual(image.body, jpeg);
  assert.equal((await call(matched.json().imageUrl, { method: 'HEAD', headers })).body.length, 0);
  assert.deepEqual(JSON.parse(await readFile(metadata, 'utf8')), photo);
});

test('local mode retains root routes and rejects unconfigured public hosts and origins', async t => {
  const { call, port } = await start(t);
  assert.equal((await call('/')).status, 200);
  assert.deepEqual((await call('/api/config')).json(), { basePath: '', hosted: false });
  assert.equal((await call('/api/state', { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await call('/api/state', { headers: { Host: 'f.qdfb.tech', Origin: origin } })).status, 403);
  assert.equal((await call('/api/state', { headers: { Origin: origin } })).status, 403);
  assert.equal((await call('/plants/api/state')).status, 404);
});

test('invalid hosting configuration fails before creating a public endpoint', async t => {
  for (const settings of [{ PUBLIC_ORIGIN: 'http://f.qdfb.tech' }, { PUBLIC_ORIGIN: `${origin}/plants` }, { PUBLIC_ORIGIN: 'https://user:pass@f.qdfb.tech' }, { BASE_PATH: '/plants/../other' }, { BASE_PATH: 'plants' }]) {
    await assert.rejects(start(t, settings), /Server exited 1/);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlantPhotoStore, normalizePlantName } from '../plant-photos.mjs';

const jpeg = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
const species = (title = '绿萝') => ({ title, pageimage: 'Plant.jpg', extract: `${title}（学名：Epipremnum aureum），是天南星科藤本植物。`, pageprops: { wikibase_item: 'Q161809' } });
function provider({ page = species(), imageURL = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/aa/Plant.jpg/640px-Plant.jpg', image = jpeg, imageHeaders = {}, redirect, missing = false, metadata = {} } = {}) {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input); calls.push(url);
    assert.equal(options.redirect, 'manual');
    if (url.hostname === 'zh.wikipedia.org') return Response.json({ query: { pages: missing ? [] : [page] } });
    if (url.hostname === 'commons.wikimedia.org') return Response.json({ query: { pages: [{ imageinfo: [{ thumburl: imageURL, descriptionurl: 'https://commons.wikimedia.org/wiki/File:Plant.jpg', extmetadata: {
      Artist: { value: '<a href="https://example.com">Test &amp; Author</a><script>bad()</script>' }, LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' }, AttributionRequired: { value: 'true' }, ...metadata
    } }] }] } });
    if (redirect) return new Response(null, { status: 302, headers: { location: redirect } });
    return new Response(image, { headers: { 'content-type': 'image/jpeg', ...imageHeaders } });
  };
  return { fetchImpl, calls };
}
async function tempStore(t, options = {}) {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'zhishi-photo-test-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  return { cacheDir, store: createPlantPhotoStore({ cacheDir, ...options }) };
}

test('plant lookup derives species from nicknames without a fixed image catalog', () => {
  for (const name of ['龟背竹', '绿萝', '长寿花', '虎皮兰', '发财树']) assert.equal(normalizePlantName(name), name);
  assert.equal(normalizePlantName(' 大门口的龟背竹（新买的） '), '龟背竹');
  assert.equal(normalizePlantName('阳台绿萝 2号'), '绿萝');
  assert.equal(normalizePlantName('https://example.com/plant.jpg'), '');
  assert.equal(normalizePlantName('x'.repeat(101)), '');
});

test('successful lookup downloads a real provider image and retains plain-text attribution', async t => {
  const remote = provider();
  const { store } = await tempStore(t, remote);
  const result = await store.match('绿萝');
  assert.equal(result.status, 'matched');
  assert.match(result.imageUrl, /^\/api\/plant-photos\/[a-f0-9]{64}\.jpg$/);
  assert.equal(result.matchedName, '绿萝');
  assert.equal(result.author, 'Test & Author');
  assert.equal(result.license, 'CC BY-SA 4.0');
  assert.equal(result.sourceUrl, 'https://commons.wikimedia.org/wiki/File:Plant.jpg');
  assert.equal(remote.calls[0].searchParams.get('titles'), '绿萝');
  assert.equal(remote.calls[1].searchParams.get('titles'), 'File:Plant.jpg');
  const image = await store.image(result.imageUrl.split('/').at(-1));
  assert.deepEqual(image.bytes, jpeg);
  assert.equal(image.type, 'image/jpeg');
  assert.equal(await store.image('../plants.json'), null);
});

test('concurrent matches share one request and successful cache survives restart offline', async t => {
  const remote = provider({ page: species('龟背竹') });
  const { store, cacheDir } = await tempStore(t, remote);
  const results = await Promise.all([store.match('龟背竹'), store.match('大门口的龟背竹'), store.match('龟背竹')]);
  assert.equal(remote.calls.length, 3);
  assert.equal(results[0].status, 'matched');
  assert.deepEqual(results[0], results[1]);
  const offline = createPlantPhotoStore({ cacheDir, fetchImpl: () => { throw new Error('No network'); } });
  assert.deepEqual(await offline.match('龟背竹'), results[0]);
});

test('temporary provider failure is cached briefly and retried after TTL', async t => {
  let clock = 1000; let failedCalls = 0; let connected = false;
  const remote = provider();
  const { store } = await tempStore(t, { now: () => clock, failureTtlMs: 50, fetchImpl: (...args) => {
    if (!connected) { failedCalls++; throw new Error('Offline'); }
    return remote.fetchImpl(...args);
  } });
  assert.equal((await store.match('绿萝')).status, 'unavailable');
  assert.equal((await store.match('绿萝')).status, 'unavailable');
  assert.equal(failedCalls, 1);
  connected = true; clock += 51;
  assert.equal((await store.match('绿萝')).status, 'matched');
});

test('unrelated encyclopedia matches are not used as plant images', async t => {
  const remote = provider({ page: { title: '臺北市立動物園', pageimage: 'Zoo.jpg', extract: '园区有很多植物。' } });
  const { store } = await tempStore(t, remote);
  assert.equal((await store.match('大门口的龟背竹')).status, 'not-found');
  assert.equal(remote.calls.length, 2);
  assert.ok(remote.calls.every(call => call.hostname === 'zh.wikipedia.org'));
  const animal = provider({ page: { title: '兔', pageimage: 'Rabbit.jpg', extract: '兔（学名：Leporidae），是哺乳动物。常以植物为食。' } });
  const animalStore = await tempStore(t, animal);
  assert.equal((await animalStore.store.match('兔')).status, 'not-found');
});

test('search fallback requires the queried name in a botanically identified result', async t => {
  const remote = provider({ page: { ...species('虎尾兰'), extract: '虎尾兰（学名：Dracaena trifasciata），又名虎皮兰，是观叶植物。', index: 1 } });
  const underlying = remote.fetchImpl;
  remote.fetchImpl = (input, options) => new URL(input).searchParams.has('titles') && new URL(input).hostname === 'zh.wikipedia.org'
    ? Promise.resolve(Response.json({ query: { pages: [] } })) : underlying(input, options);
  const { store } = await tempStore(t, remote);
  const result = await store.match('虎皮兰');
  assert.equal(result.status, 'matched');
  assert.equal(result.matchedName, '虎尾兰');
});

test('real 发财树 disambiguation and 马拉巴栗 excerpt resolve to the plant photo', async t => {
  const excerpt = '马拉巴栗（学名：Pachira aquatica，英语：Malabar chestnut），又名发财树、招财树、钱树、美国花生、光瓜栗、瓜栗，属锦葵科瓜栗属的一种植物。中文名称由Malabar chestnut音译而来，一般认为Pachira这个属名取自圭亚那语; 种小名aquatica的意思是“水中的”。马拉巴栗原产于中美洲及南美洲。';
  const page = { title: '馬拉巴栗', pageimage: 'Pachira_aquatica2.jpg', index: 1, pageprops: { defaultsort: 'Pachira aquatica', wikibase_item: 'Q310500' }, extract: excerpt };
  const remote = provider({ page });
  const underlying = remote.fetchImpl;
  remote.fetchImpl = (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'zh.wikipedia.org') {
      assert.equal(url.searchParams.get('variant'), 'zh-cn');
      assert.equal(url.searchParams.get('exlimit'), '3');
      if (url.searchParams.has('titles')) return Promise.resolve(Response.json({ query: { pages: [{ title: '發財樹', pageprops: { disambiguation: '' }, extract: '发财树有两种细述如下：翡翠木：景天科肉质亚灌木。马拉巴栗 ：木棉科的植物。' }] } }));
    }
    return underlying(input, options);
  };
  const { store } = await tempStore(t, remote);
  const result = await store.match('发财树');
  assert.equal(result.status, 'matched');
  assert.equal(result.matchedName, '馬拉巴栗');
  // Latin taxonomic author abbreviations must not split the botanical definition.
  const abbreviated = provider({ page: { ...page, extract: excerpt.replace('Pachira aquatica，', 'Pachira aquatica Aubl.，') } });
  const abbreviationStore = await tempStore(t, abbreviated);
  assert.equal((await abbreviationStore.store.match('发财树')).status, 'matched');
});

test('structured API errors are temporary failure rather than a false no-match', async t => {
  for (const code of ['maxlag', 'ratelimited']) {
    let calls = 0;
    const { store } = await tempStore(t, { fetchImpl: async () => {
      calls++;
      return Response.json({ error: { code, info: 'Provider temporarily busy' } }, { headers: { 'retry-after': '120' } });
    } });
    assert.equal((await store.match('发财树')).status, 'unavailable');
    assert.equal((await store.match('绿萝')).status, 'unavailable');
    assert.equal(calls, 1);
  }
});

test('provider URLs and every redirect are restricted to HTTPS Wikimedia image hosts', async t => {
  for (const imageURL of ['http://upload.wikimedia.org/a.jpg', 'https://example.com/plant.jpg', 'https://upload.wikimedia.org.evil.test/a.jpg', 'https://user:secret@upload.wikimedia.org/a.jpg', 'https://upload.wikimedia.org:444/a.jpg']) {
    const remote = provider({ imageURL });
    const { store } = await tempStore(t, remote);
    assert.equal((await store.match('绿萝')).status, 'unavailable');
    assert.equal(remote.calls.length, 2);
  }
  const remote = provider({ redirect: 'http://127.0.0.1:4188/api/state' });
  const { store } = await tempStore(t, remote);
  assert.equal((await store.match('绿萝')).status, 'unavailable');
  assert.equal(remote.calls.length, 3);
});

test('oversized, mislabelled, and unlicensed images never become default pictures', async t => {
  for (const options of [{ image: Buffer.from('<html>not an image</html>') }, { imageHeaders: { 'content-length': '999999999' } }, { image: Buffer.alloc(21), maxImageBytes: 20 }, { metadata: { LicenseShortName: { value: 'All rights reserved' } } }, { metadata: { Artist: { value: '' } } }]) {
    const remote = provider(options);
    const { store } = await tempStore(t, { ...remote, maxImageBytes: options.maxImageBytes });
    assert.notEqual((await store.match('绿萝')).status, 'matched');
  }
});

test('older HTTP Creative Commons license links are safely upgraded to HTTPS', async t => {
  const remote = provider({ metadata: { LicenseUrl: { value: 'http://creativecommons.org/licenses/by-sa/3.0/' }, LicenseShortName: { value: 'CC BY-SA 3.0' } } });
  const { store } = await tempStore(t, remote);
  const result = await store.match('虎皮兰');
  assert.equal(result.status, 'matched');
  assert.equal(result.licenseUrl, 'https://creativecommons.org/licenses/by-sa/3.0/');
});

test('provider Retry-After pauses lookups across different plant names', async t => {
  let clock = 1000; let calls = 0;
  const { store } = await tempStore(t, { now: () => clock, failureTtlMs: 50, fetchImpl: async () => {
    calls++;
    return new Response('Too many requests', { status: 429, headers: { 'retry-after': '120' } });
  } });
  assert.equal((await store.match('绿萝')).status, 'unavailable');
  assert.equal((await store.match('虎皮兰')).status, 'unavailable');
  assert.equal(calls, 1);
  clock += 119000;
  assert.equal((await store.match('长寿花')).status, 'unavailable');
  assert.equal(calls, 1);
  clock += 1001;
  assert.equal((await store.match('绿萝')).status, 'unavailable');
  assert.equal(calls, 2);
});

function naturalistPhoto(overrides = {}) {
  return { id: 12345, license_code: 'cc-by', attribution_name: 'Test Photographer', url: 'https://inaturalist-open-data.s3.amazonaws.com/photos/12345/square.jpeg', flags: [], ...overrides };
}

function naturalistProvider({ taxa, photo = naturalistPhoto(), curated = [], observations = [], redirect } = {}) {
  const taxon = { id: 154852, name: 'Pachira aquatica', preferred_common_name: '瓜栗', iconic_taxon_name: 'Plantae', is_active: true, names: [{ name: '发财树', is_valid: true }], default_photo: photo };
  const calls = [];
  return { provider: 'inaturalist', calls, fetchImpl: async (input, options) => {
    const url = new URL(input); calls.push(url);
    assert.equal(options.redirect, 'manual');
    if (url.hostname === 'api.inaturalist.org') {
      if (url.pathname === '/v1/taxa/autocomplete') return Response.json({ results: taxa || [taxon] });
      if (url.pathname === '/v1/taxa/154852') return Response.json({ results: [{ ...taxon, taxon_photos: curated }] });
      if (url.pathname === '/v1/observations') return Response.json({ results: observations });
      throw new Error('Unexpected API route');
    }
    assert.equal(url.hostname, 'inaturalist-open-data.s3.amazonaws.com');
    if (redirect) return new Response(null, { status: 302, headers: { location: redirect } });
    return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
  } };
}

test('cloud image provider matches an exact Chinese alias and preserves image attribution', async t => {
  const remote = naturalistProvider();
  const { store, cacheDir } = await tempStore(t, remote);
  const result = await store.match('阳台的发财树');
  assert.equal(result.status, 'matched');
  assert.equal(result.matchedName, '瓜栗');
  assert.equal(result.author, 'Test Photographer');
  assert.equal(result.license, 'CC BY');
  assert.equal(result.licenseUrl, 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(result.sourceUrl, 'https://www.inaturalist.org/photos/12345');
  assert.equal(remote.calls.length, 2);
  assert.equal(remote.calls[0].searchParams.get('q'), '发财树');
  assert.equal(remote.calls[0].searchParams.get('all_names'), 'true');
  assert.equal(remote.calls[0].searchParams.get('locale'), 'zh-CN');
  assert.equal(remote.calls[1].pathname, '/photos/12345/medium.jpeg');
  const offline = createPlantPhotoStore({ cacheDir, provider: 'inaturalist', fetchImpl: () => { throw new Error('Offline'); } });
  assert.deepEqual(await offline.match('发财树'), result);
});

test('cloud matching rejects fuzzy names, animals, invalid aliases and ambiguous exact names', async t => {
  const exact = { id: 1, name: 'Pachira aquatica', preferred_common_name: '发财树', iconic_taxon_name: 'Plantae', default_photo: naturalistPhoto() };
  for (const taxa of [
    [{ ...exact, preferred_common_name: '发财树属' }],
    [{ ...exact, iconic_taxon_name: 'Mammalia' }],
    [{ ...exact, preferred_common_name: '瓜栗', names: [{ name: '发财树', is_valid: false }] }],
    [{ ...exact, is_active: false }],
    [exact, { ...exact, id: 2 }]
  ]) {
    const remote = naturalistProvider({ taxa });
    const { store } = await tempStore(t, remote);
    assert.equal((await store.match('发财树')).status, 'not-found');
    assert.equal(remote.calls.length, 1);
  }
});

test('cloud provider skips reserved default images and uses a licensed curated photo of the same taxon', async t => {
  const remote = naturalistProvider({ photo: naturalistPhoto({ license_code: null }), curated: [
    { taxon_id: 999, photo: naturalistPhoto() },
    { taxon_id: 154852, photo: naturalistPhoto({ license_code: 'cc-by-nc' }) },
    { taxon_id: 154852, photo: naturalistPhoto({ license_code: 'cc-by-sa', attribution_name: '<b>作者</b><script>bad()</script>' }) }
  ] });
  const { store } = await tempStore(t, remote);
  const result = await store.match('发财树');
  assert.equal(result.status, 'matched');
  assert.equal(result.license, 'CC BY-SA');
  assert.equal(result.author, '作者');
  assert.equal(remote.calls.length, 3);
});

test('observation fallback checks the exact plant and each photo license independently', async t => {
  const remote = naturalistProvider({ photo: naturalistPhoto({ license_code: null }), observations: [
    { taxon: { id: 999, iconic_taxon_name: 'Plantae' }, photos: [naturalistPhoto()] },
    { taxon: { id: 154852, iconic_taxon_name: 'Plantae' }, photos: [naturalistPhoto({ license_code: 'cc-by-nd' }), naturalistPhoto({ license_code: 'cc0', attribution_name: '' })] }
  ] });
  const { store } = await tempStore(t, remote);
  const result = await store.match('发财树');
  assert.equal(result.status, 'matched');
  assert.equal(result.license, 'CC0');
  assert.equal(result.licenseUrl, 'https://creativecommons.org/publicdomain/zero/1.0/');
  assert.equal(remote.calls[2].searchParams.get('photo_license'), 'cc0,cc-by,cc-by-sa');
  assert.equal(remote.calls.length, 4);
});

test('cloud provider never downloads unlicensed, flagged, or unattributed photos', async t => {
  for (const changes of [{ license_code: null }, { license_code: 'cc-by-nc' }, { license_code: 'cc-by-nd' }, { flags: [{}] }, { attribution_name: '' }]) {
    const remote = naturalistProvider({ photo: naturalistPhoto(changes), curated: [{ taxon_id: 154852, photo: naturalistPhoto(changes) }] });
    const { store } = await tempStore(t, remote);
    assert.equal((await store.match('发财树')).status, 'not-found');
    assert.ok(remote.calls.every(url => url.hostname === 'api.inaturalist.org'));
  }
});

test('cloud image URLs and redirects must stay on the allowlisted open-image host', async t => {
  for (const url of ['https://static.inaturalist.org/photos/12345/square.jpeg', 'https://example.org/photos/12345/square.jpeg', 'http://inaturalist-open-data.s3.amazonaws.com/photos/12345/square.jpeg', 'https://inaturalist-open-data.s3.amazonaws.com:444/photos/12345/square.jpeg']) {
    const remote = naturalistProvider({ photo: naturalistPhoto({ url }) });
    const { store } = await tempStore(t, remote);
    assert.equal((await store.match('发财树')).status, 'unavailable');
    assert.equal(remote.calls.length, 1);
  }
  const remote = naturalistProvider({ redirect: 'http://127.0.0.1:4188/api/state' });
  const { store } = await tempStore(t, remote);
  assert.equal((await store.match('发财树')).status, 'unavailable');
  assert.equal(remote.calls.length, 2);
});

test('cloud provider also respects Retry-After across plant names', async t => {
  let calls = 0;
  const { store } = await tempStore(t, { provider: 'inaturalist', fetchImpl: async () => {
    calls++;
    return new Response('Busy', { status: 429, headers: { 'retry-after': '120' } });
  } });
  assert.equal((await store.match('发财树')).status, 'unavailable');
  assert.equal((await store.match('龟背竹')).status, 'unavailable');
  assert.equal(calls, 1);
});

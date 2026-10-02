import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

const API_HOSTS = new Set(['zh.wikipedia.org', 'commons.wikimedia.org']);
const IMAGE_HOSTS = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org']);
const INATURALIST_API_HOSTS = new Set(['api.inaturalist.org']);
const INATURALIST_IMAGE_HOSTS = new Set(['inaturalist-open-data.s3.amazonaws.com']);
const INATURALIST_LICENSES = new Set(['cc0', 'cc-by', 'cc-by-sa']);
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const CACHE_FILE = /^[a-f0-9]{64}\.(jpg|png|webp)$/;
const unavailable = () => ({ status: 'unavailable' });
const notFound = () => ({ status: 'not-found' });

export function normalizePlantName(value) {
  if (typeof value !== 'string' || value.length > 100) return '';
  let name = value.normalize('NFKC').trim().replace(/[\u0000-\u001f\u007f]/g, '');
  name = name.replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, ' ').trim();
  // Names such as “大门口的龟背竹” retain the plant name, not its location.
  if (name.includes('的')) name = name.split('的').at(-1).trim();
  name = name.replace(/^(?:我的|家里|家中|门口|大门口|阳台|客厅|卧室|书房|办公室|窗台|窗边|厨房|室内|室外)(?:里|上|旁|边|那盆|这盆|一盆)?\s*/u, '');
  name = name.replace(/(?:[\s#-]*\d+号?|[一二三四五六七八九十]号)$/u, '').trim();
  return /^[\p{L}\p{M}][\p{L}\p{M}\s.-]{0,59}$/u.test(name) ? name : '';
}

function plainText(value, max = 240) {
  return String(value ?? '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
      const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }).replace(/&(amp|quot|apos|lt|gt|nbsp);/gi, (_, n) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[n.toLowerCase()])
    .replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeURL(value, hosts) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Untrusted image source');
  return url;
}

function apiURL(host, params) {
  const url = new URL(`https://${host}/w/api.php`);
  url.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params });
  return url;
}

function isPlantPage(page) {
  if (!page || page.missing || page.pageprops?.disambiguation !== undefined || !page.pageimage) return false;
  const intro = (page.extract || '').split('。').slice(0, 2).join('。');
  if (/(?:哺乳(?:动物|動物|类|類)|鸟类|鳥類|鱼类|魚類|爬行动物|爬行動物|昆虫|昆蟲)/u.test(intro)) return false;
  return /(?:学名|學名|拉丁名)/u.test(intro) && /(?:植物|花卉|草本|木本|灌木|乔木|喬木|藤本|多肉|觀葉|观叶)/u.test(intro);
}

function signatureMatches(buffer, type) {
  if (type === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (type === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
}

function inaturalistURL(endpoint, params = {}) {
  const url = new URL(`https://api.inaturalist.org/v1/${endpoint}`);
  url.search = new URLSearchParams(params);
  return url;
}

function exactPlantTaxon(taxon, name) {
  if (!Number.isSafeInteger(taxon?.id) || taxon.id <= 0 || taxon.is_active === false || taxon.iconic_taxon_name !== 'Plantae') return false;
  const names = [taxon.name, taxon.preferred_common_name, ...(taxon.names || []).filter(item => item.is_valid !== false).map(item => item.name)];
  return names.some(candidate => typeof candidate === 'string' && candidate.normalize('NFKC').trim().toLowerCase() === name.toLowerCase());
}

function licensedNaturalistPhoto(photo) {
  return Number.isSafeInteger(photo?.id) && photo.id > 0 && INATURALIST_LICENSES.has(photo.license_code) &&
    !(photo.flags?.length) && (photo.license_code === 'cc0' || plainText(photo.attribution_name || photo.attribution));
}

export function createPlantPhotoStore({ cacheDir, provider = process.env.PLANT_PHOTO_PROVIDER || 'wikimedia', fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 14000, requestTimeoutMs = 5000, failureTtlMs = 60000, maxImageBytes = 4 * 1024 * 1024 } = {}) {
  if (!cacheDir) throw new Error('Image cache directory is required');
  if (!['wikimedia', 'inaturalist'].includes(provider)) throw new Error('Unknown plant photo provider');
  const memory = new Map();
  const pending = new Map();
  let retryAfter = 0;
  const hash = value => createHash('sha256').update(value).digest('hex');

  function coolDown(response) {
    const value = response.headers.get('retry-after');
    const milliseconds = value && /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now();
    retryAfter = now() + Math.min(60 * 60 * 1000, Math.max(failureTtlMs, milliseconds || 0));
  }

  async function download(input, { kind, signal, source = 'wikimedia' }) {
    const hosts = source === 'inaturalist' ? (kind === 'image' ? INATURALIST_IMAGE_HOSTS : INATURALIST_API_HOSTS) : (kind === 'image' ? IMAGE_HOSTS : API_HOSTS);
    let url = safeURL(input, hosts);
    const limit = kind === 'image' ? maxImageBytes : 1024 * 1024;
    const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]);
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (now() < retryAfter) throw new Error('Image provider cooling down');
      const response = await fetchImpl(url, { redirect: 'manual', signal: stepSignal, headers: { 'User-Agent': 'ZhishiPlantCare/1.0 (personal plant care app)', Accept: kind === 'image' ? 'image/jpeg,image/png,image/webp' : 'application/json' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (!response.headers.get('location') || redirects === 3) throw new Error('Image redirect failed');
        url = safeURL(new URL(response.headers.get('location'), url), hosts);
        continue;
      }
      if (!response.ok) {
        if ([429, 503].includes(response.status)) coolDown(response);
        await response.body?.cancel(); throw new Error('Image provider unavailable');
      }
      const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (kind === 'image' && !IMAGE_TYPES[type]) { await response.body?.cancel(); throw new Error('Unsupported image'); }
      if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Image response too large'); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty image response');
      const chunks = []; let length = 0;
      try {
        while (true) {
          if (stepSignal.aborted) throw new Error('Image provider timed out');
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > limit) throw new Error('Image response too large');
          chunks.push(Buffer.from(value));
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      const bytes = Buffer.concat(chunks, length);
      if (kind === 'image') {
        if (!signatureMatches(bytes, type)) throw new Error('Invalid image content');
        return { bytes, ext: IMAGE_TYPES[type] };
      }
      const payload = JSON.parse(bytes.toString('utf8'));
      if (payload?.error) {
        if (/^(?:ratelimited|maxlag|readonly)$/i.test(payload.error.code || '')) coolDown(response);
        throw new Error('Image provider API unavailable');
      }
      return payload;
    }
    throw new Error('Image redirect failed');
  }

  async function readCached(key) {
    try {
      const file = await readFile(path.join(cacheDir, `${key}.json`), 'utf8');
      if (file.length > 16000) return null;
      const result = JSON.parse(file);
      const filename = result.imageUrl?.split('/').at(-1);
      if (result.status !== 'matched' || !CACHE_FILE.test(filename || '') || result.imageUrl !== `/api/plant-photos/${filename}`) return null;
      if (!(await stat(path.join(cacheDir, filename))).isFile()) return null;
      return result;
    } catch { return null; }
  }

  async function savePhoto(key, photo, metadata) {
    const filename = `${hash(photo.bytes)}.${photo.ext}`;
    const result = { status: 'matched', imageUrl: `/api/plant-photos/${filename}`, ...metadata };
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, filename), photo.bytes);
    const temporary = path.join(cacheDir, `${key}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(result));
    await rename(temporary, path.join(cacheDir, `${key}.json`));
    return result;
  }

  async function lookupNaturalist(name, key, signal) {
    const options = { kind: 'json', signal, source: 'inaturalist' };
    // The general /taxa search tokenizes Chinese names into single characters.
    // Autocomplete plus exact aliases avoids unrelated but popular search hits.
    const data = await download(inaturalistURL('taxa/autocomplete', { q: name, locale: 'zh-CN', all_names: 'true', is_active: 'true', taxon_id: '47126', per_page: '30' }), options);
    const matches = (data.results || []).filter(taxon => exactPlantTaxon(taxon, name));
    if (matches.length !== 1) return notFound();
    const taxon = matches[0];
    let selected = licensedNaturalistPhoto(taxon.default_photo) ? taxon.default_photo : null;
    if (!selected) {
      const details = await download(inaturalistURL(`taxa/${taxon.id}`, { locale: 'zh-CN' }), options);
      const detail = details.results?.find(item => item.id === taxon.id && item.iconic_taxon_name === 'Plantae');
      selected = detail?.taxon_photos?.filter(item => item.taxon_id === taxon.id).map(item => item.photo).find(licensedNaturalistPhoto);
    }
    if (!selected) {
      const observations = await download(inaturalistURL('observations', { taxon_id: String(taxon.id), photos: 'true', photo_license: 'cc0,cc-by,cc-by-sa', order_by: 'votes', per_page: '5' }), options);
      // The API may include descendants or photos with different licenses in the
      // same observation. Recheck the exact taxon and each photo's own license.
      selected = (observations.results || []).filter(item => item.taxon?.id === taxon.id && item.taxon?.iconic_taxon_name === 'Plantae')
        .flatMap(item => item.photos || []).find(licensedNaturalistPhoto);
    }
    if (!selected) return notFound();
    const url = safeURL(selected.medium_url || selected.url, INATURALIST_IMAGE_HOSTS);
    if (!new RegExp(`^/photos/${selected.id}/(?:square|small|medium|large|original)\\.(?:jpe?g|png|webp)$`).test(url.pathname)) return notFound();
    // iNaturalist documents that size variants share the same file extension.
    url.pathname = url.pathname.replace(/\/(?:square|small|large|original)\./, '/medium.');
    const photo = await download(url, { kind: 'image', signal, source: 'inaturalist' });
    return savePhoto(key, photo, {
      matchedName: plainText(taxon.preferred_common_name || name, 100),
      sourceUrl: `https://www.inaturalist.org/photos/${selected.id}`,
      author: plainText(selected.attribution_name || selected.attribution) || '作者未注明',
      license: selected.license_code.toUpperCase().replace(/^CC-/, 'CC '),
      // Matches iNaturalist's Shared::LicenseModule (CC_VERSION 4.0, CC0 1.0).
      licenseUrl: selected.license_code === 'cc0' ? 'https://creativecommons.org/publicdomain/zero/1.0/' : `https://creativecommons.org/licenses/${selected.license_code.slice(3)}/4.0/`
    });
  }

  async function lookup(name, key) {
    const cached = await readCached(key);
    if (cached) return cached;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      if (provider === 'inaturalist') return await lookupNaturalist(name, key, signal);
      const props = { prop: 'pageimages|pageprops|extracts', piprop: 'name', pilicense: 'free', exintro: '1', explaintext: '1', exsentences: '5', exlimit: '3', redirects: '1', converttitles: '1', variant: 'zh-cn' };
      let data = await download(apiURL('zh.wikipedia.org', { ...props, titles: name }), { kind: 'json', signal });
      let page = data.query?.pages?.find(isPlantPage);
      if (!page) {
        data = await download(apiURL('zh.wikipedia.org', { ...props, generator: 'search', gsrsearch: name, gsrnamespace: '0', gsrlimit: '3' }), { kind: 'json', signal });
        page = (data.query?.pages || []).sort((a, b) => a.index - b.index).find(candidate => isPlantPage(candidate) && `${candidate.title} ${candidate.extract}`.normalize('NFKC').toLowerCase().includes(name.toLowerCase()));
      }
      if (!page) return notFound();
      const images = await download(apiURL('commons.wikimedia.org', { titles: `File:${page.pageimage}`, prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '640' }), { kind: 'json', signal });
      const info = images.query?.pages?.[0]?.imageinfo?.[0];
      const meta = info?.extmetadata || {};
      const license = plainText(meta.LicenseShortName?.value, 100);
      const author = plainText(meta.Artist?.value);
      if (!info || !/^(CC BY(?:-SA)? \d(?:\.\d)?(?: [a-z]{2})?|CC0(?: \d(?:\.\d)?)?|Public domain)$/i.test(license) || (meta.AttributionRequired?.value === 'true' && !author)) return notFound();
      const sourceUrl = safeURL(info.descriptionurl, new Set(['commons.wikimedia.org'])).href;
      if (!new URL(sourceUrl).pathname.startsWith('/wiki/File:')) return notFound();
      let licenseUrl = '';
      if (meta.LicenseUrl?.value) {
        const link = new URL(meta.LicenseUrl.value, 'https://creativecommons.org');
        // Older Commons metadata may still link to the HTTP version of a CC license.
        if (link.hostname === 'creativecommons.org' && link.protocol === 'http:') link.protocol = 'https:';
        licenseUrl = safeURL(link, new Set(['creativecommons.org'])).href;
      }
      if (/^CC /i.test(license) && !licenseUrl) return notFound();
      const photo = await download(info.thumburl || info.url, { kind: 'image', signal });
      return await savePhoto(key, photo, { matchedName: plainText(page.title, 100), sourceUrl, author: author || '作者未注明', license, licenseUrl });
    } catch { return unavailable(); }
  }

  async function match(value) {
    const name = normalizePlantName(value);
    if (!name) return notFound();
    const key = hash(name.toLowerCase());
    const cached = memory.get(key);
    if (cached && (cached.result.status === 'matched' || now() < cached.expires)) return cached.result;
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 3) return unavailable();
    const work = lookup(name, key).then(result => {
      memory.set(key, { result, expires: Math.max(now() + failureTtlMs, retryAfter) });
      if (memory.size > 200) memory.delete(memory.keys().next().value);
      return result;
    }).finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  }

  async function image(filename) {
    if (!CACHE_FILE.test(filename)) return null;
    try {
      const imagePath = path.join(cacheDir, filename);
      const details = await stat(imagePath);
      if (!details.isFile() || details.size > maxImageBytes) return null;
      return { bytes: await readFile(imagePath), type: Object.entries(IMAGE_TYPES).find(([, ext]) => filename.endsWith(`.${ext}`))[0] };
    } catch { return null; }
  }
  return { match, image };
}

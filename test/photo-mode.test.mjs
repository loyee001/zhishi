import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed, PRESETS, validatePlant } from '../dist/model.js';

const uploadedPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
const sample = () => createSeed(new Date(2026, 8, 1)).plants[0];

test('plants without uploaded images default to automatic matching', () => {
  const input = sample();
  delete input.image;
  assert.equal(validatePlant(input).image, 'auto');
  assert.equal(validatePlant({ ...input, image: 'auto' }).image, 'auto');
});

test('legacy presets become automatic images without changing care plans or source data', () => {
  const state = createSeed(new Date(2026, 8, 1));
  state.history.push({ plantId: state.plants[0].id, type: 'water', action: 'done', actualDate: '2026-08-25' });
  const before = structuredClone(state);
  for (const image of PRESETS) {
    const input = { ...state.plants[0], image };
    const saved = validatePlant(input);
    assert.equal(saved.image, 'auto');
    assert.deepEqual(saved.water, input.water);
    assert.deepEqual(saved.fertilizer, input.fertilizer);
    assert.equal(input.image, image);
  }
  assert.deepEqual(state, before);
});

test('uploaded images are preserved exactly when the plant is renamed', () => {
  const input = { ...sample(), image: uploadedPng, name: '窗边的龟背竹' };
  const saved = validatePlant(input);
  assert.equal(saved.image, uploadedPng);
  assert.deepEqual(saved.water, input.water);
  assert.deepEqual(saved.fertilizer, input.fertilizer);
  const renamed = validatePlant({ ...saved, name: '我的大龟背竹' });
  assert.equal(renamed.image, uploadedPng);
});

test('plant image values reject external URLs, unsupported data types and malformed image input', () => {
  const invalid = [
    'https://example.com/plant.jpg',
    '//example.com/plant.jpg',
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:text/html;base64,PGgxPnRlc3Q8L2gxPg==',
    'data:image/png;base64,',
    'data:image/png;base64,%%%not-base64',
    'data:image/png;base64,' + 'A'.repeat(1400000),
    '',
    {},
    12,
  ];
  for (const image of invalid) {
    const input = { ...sample(), image };
    const before = structuredClone(input);
    assert.throws(() => validatePlant(input), /自动配图|图片|照片/);
    assert.deepEqual(input, before);
  }
});

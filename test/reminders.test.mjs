import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCare, dueKey } from '../dist/model.js';
import { reminderId, dueReminders, pendingReminders } from '../dist/reminders.js';

function plan(nextDate, time, enabled = true) {
  return { enabled, intervalDays: 7, nextDate, time, lastDate: null };
}

function plant(id, water, fertilizer = plan('2031-01-01', '09:00', false)) {
  return { id, name: `植物 ${id}`, water, fertilizer };
}

function stateOf(...plants) { return { version: 1, plants, history: [] }; }

test('a reminder becomes due exactly at its scheduled minute, not at the start of the day', () => {
  const state = stateOf(plant('mint', plan('2030-10-01', '09:00')));
  assert.deepEqual(dueReminders(state, new Date(2030, 9, 1, 8, 59, 59, 999)), []);
  assert.equal(dueReminders(state, new Date(2030, 9, 1, 9, 0, 0, 0)).length, 1);
  assert.equal(dueReminders(state, new Date(2030, 9, 1, 9, 0, 0, 1)).length, 1);
});

test('due reminders include overdue plans, exclude later plans, and use the supplied clock date', () => {
  const state = stateOf(
    plant('tomorrow', plan('2030-10-02', '00:00')),
    plant('later', plan('2030-10-01', '18:00')),
    plant('now', plan('2030-10-01', '09:00')),
    plant('overdue', plan('2030-09-30', '23:59'))
  );
  assert.deepEqual(
    dueReminders(state, new Date(2030, 9, 1, 9, 0)).map(task => task.plant.id),
    ['overdue', 'now']
  );
});

test('a midnight reminder crosses the year boundary using local time', () => {
  const state = stateOf(plant('mint', plan('2031-01-01', '00:00')));
  assert.equal(dueReminders(state, new Date(2030, 11, 31, 23, 59, 59, 999)).length, 0);
  assert.equal(dueReminders(state, new Date(2031, 0, 1, 0, 0)).length, 1);
});

test('paused watering and fertilizer never trigger even when their dates are overdue', () => {
  const state = stateOf(plant('mint', plan('2030-09-01', '09:00', false), plan('2030-09-01', '09:00', false)));
  const now = new Date(2030, 9, 1, 12);
  assert.deepEqual(dueReminders(state, now), []);
  assert.deepEqual(pendingReminders(state, {}, now), []);
  state.plants[0].fertilizer.enabled = true;
  assert.deepEqual(dueReminders(state, now).map(task => task.type), ['fertilizer']);
});

test('seen reminders are isolated by plant and care type, and checking leaves data untouched', () => {
  const state = stateOf(
    plant('mint', plan('2030-10-01', '09:00'), plan('2030-10-01', '09:00')),
    plant('rubber', plan('2030-10-01', '09:00'))
  );
  const now = new Date(2030, 9, 1, 9);
  const watering = dueReminders(state, now).find(task => task.plant.id === 'mint' && task.type === 'water');
  const seen = { [reminderId(watering)]: now.getTime() };
  const before = structuredClone({ state, seen });
  assert.deepEqual(
    pendingReminders(state, seen, now).map(task => `${task.plant.id}:${task.type}`).sort(),
    ['mint:fertilizer', 'rubber:water']
  );
  assert.deepEqual({ state, seen }, before);
});

test('snoozing a seen reminder creates a new reminder that waits for the new time', () => {
  const state = stateOf(plant('mint', plan('2030-10-01', '09:00')));
  const now = new Date(2030, 9, 1, 9);
  const previous = dueReminders(state, now)[0];
  const previousId = reminderId(previous);
  const seen = { [previousId]: now.getTime() };
  assert.deepEqual(pendingReminders(state, seen, now), []);

  applyCare(state, { plantId: 'mint', type: 'water', action: 'snooze', minutes: 60, expected: dueKey(previous.plan) }, now);
  assert.deepEqual(pendingReminders(state, seen, new Date(2030, 9, 1, 9, 59, 59)), []);
  const pending = pendingReminders(state, seen, new Date(2030, 9, 1, 10));
  assert.equal(pending.length, 1);
  assert.notEqual(reminderId(pending[0]), previousId);
});

test('recording actual care schedules a fresh reminder without suppressing the next cycle', () => {
  const state = stateOf(plant('mint', plan('2030-10-01', '09:00')));
  const now = new Date(2030, 9, 1, 9);
  const previous = dueReminders(state, now)[0];
  const previousId = reminderId(previous);
  const seen = { [previousId]: now.getTime() };

  applyCare(state, { plantId: 'mint', type: 'water', action: 'done', actualDate: '2030-10-01', expected: dueKey(previous.plan) }, now);
  assert.deepEqual(pendingReminders(state, seen, new Date(2030, 9, 8, 8, 59, 59)), []);
  const pending = pendingReminders(state, seen, new Date(2030, 9, 8, 9));
  assert.equal(pending.length, 1);
  assert.notEqual(reminderId(pending[0]), previousId);
});

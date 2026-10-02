import { dateKey, dueAt, dueKey, tasksFor } from './model.js';

export const reminderId = task => `${task.plant.id}:${task.type}:${dueKey(task.plan)}`;

export function dueReminders(state, now = new Date()) {
  return tasksFor(state, dateKey(now)).filter(task => dueAt(task.plan).getTime() <= now.getTime());
}

export function pendingReminders(state, seen, now = new Date()) {
  return dueReminders(state, now).filter(task => !seen[reminderId(task)]);
}

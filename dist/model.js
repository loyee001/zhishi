export const TYPES = { water: '浇水', fertilizer: '施肥' };
export const PRESETS = ['monstera', 'mint', 'rubber'];
export function dateKey(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDays(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  return dateKey(new Date(y, m - 1, d + days, 12));
}
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  return y >= 2000 && y <= 2200 && dateKey(new Date(y, m - 1, d, 12)) === value;
}
export function dueAt(schedule) { return new Date(`${schedule.nextDate}T${schedule.time}:00`); }
export function dueKey(schedule) { return `${schedule.nextDate}T${schedule.time}`; }
export function nextCareDate(plan, actualDate, today = dateKey()) {
  if (!actualDate) throw new Error('请先填写实际养护日期');
  if (!validDate(actualDate)) throw new Error('请填写有效的实际养护日期');
  if (actualDate > today) throw new Error('实际养护日期不能晚于今天');
  if (plan.lastDate && actualDate < plan.lastDate) throw new Error('实际养护日期不能早于上次养护日期');
  if (actualDate === plan.lastDate) throw new Error('这一天已记录过本项养护，请勿重复确认');
  return addDays(actualDate, plan.intervalDays);
}
export function tasksFor(state, day = dateKey(), includeOverdue = true) {
  return state.plants.flatMap(plant => Object.keys(TYPES).flatMap(type => {
    const plan = plant[type];
    return plan.enabled && (includeOverdue ? plan.nextDate <= day : plan.nextDate === day)
      ? [{ plant, type, plan }] : [];
  })).sort((a, b) => dueKey(a.plan).localeCompare(dueKey(b.plan)) || a.plant.name.localeCompare(b.plant.name));
}
export function createSeed(now = new Date()) {
  const today = dateKey(now);
  const plan = (intervalDays, delta, time, last) => ({ enabled: true, intervalDays, nextDate: addDays(today, delta), time, lastDate: addDays(today, -last) });
  return { version: 1, plants: [
    { id: 'sample-monstera', name: '龟背竹', location: '客厅', image: 'monstera', notes: '', isDemo: true, water: plan(7, 0, '09:00', 7), fertilizer: plan(30, 12, '09:00', 18) },
    { id: 'sample-mint', name: '薄荷', location: '阳台', image: 'mint', notes: '', isDemo: true, water: plan(3, 0, '18:00', 3), fertilizer: plan(30, 15, '09:00', 15) },
    { id: 'sample-rubber', name: '橡皮树', location: '书房', image: 'rubber', notes: '', isDemo: true, water: plan(7, 3, '09:00', 4), fertilizer: plan(30, 0, '18:00', 30) }
  ], history: [] };
}
function requireText(value, label, max, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`${label}请填写${required ? '1–' : '不超过'}${max}个字符`);
  return value.trim();
}
export function validatePlant(input) {
  if (!input || typeof input !== 'object') throw new Error('植物信息不完整');
  const plant = { name: requireText(input.name, '植物名称', 40), location: requireText(input.location, '摆放位置', 40, false), notes: requireText(input.notes || '', '备注', 500, false) };
  const image = input.image ?? 'auto';
  if (typeof image !== 'string' || (image !== 'auto' && !PRESETS.includes(image) && !(image.length < 1400000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(image)))) throw new Error('请选择自动配图，或重新上传照片');
  plant.image = PRESETS.includes(image) ? 'auto' : image;
  for (const type of Object.keys(TYPES)) {
    const p = input[type];
    if (!p || typeof p.enabled !== 'boolean' || !Number.isInteger(p.intervalDays) || p.intervalDays < 1 || p.intervalDays > 365 || !validDate(p.nextDate) || typeof p.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time) || (p.lastDate !== null && !validDate(p.lastDate))) throw new Error(`${TYPES[type]}计划无效，请检查日期、时间和周期（1–365天）`);
    if (p.lastDate && p.lastDate > dateKey()) throw new Error('上次养护日期不能在未来');
    plant[type] = { enabled: p.enabled, intervalDays: p.intervalDays, nextDate: p.nextDate, time: p.time, lastDate: p.lastDate };
  }
  return plant;
}
export function applyCare(state, input, now = new Date()) {
  const plant = state.plants.find(p => p.id === input.plantId);
  if (!plant || !Object.hasOwn(TYPES, input.type)) throw new Error('找不到这项养护计划');
  const plan = plant[input.type];
  if (!plan.enabled) throw new Error('这项提醒已暂停');
  if (input.expected !== dueKey(plan)) { const error = new Error('计划已更新，请刷新后再处理'); error.status = 409; throw error; }
  if (input.expectedRevision !== undefined && input.expectedRevision !== (plant.revision || 0)) { const error = new Error('养护计划已修改，请关闭并重新打开确认窗口'); error.status = 409; throw error; }
  if (!['done', 'skip', 'snooze'].includes(input.action)) throw new Error('未知的养护操作');
  const note = requireText(input.note || '', '养护备注', 300, false);
  const previous = { ...plan };
  const today = dateKey(now);
  if (input.action === 'done') {
    const nextDate = nextCareDate(plan, input.actualDate, today);
    plan.lastDate = input.actualDate;
    plan.nextDate = nextDate;
  } else if (input.action === 'skip') {
    plan.nextDate = addDays(plan.nextDate > today ? plan.nextDate : today, plan.intervalDays);
  } else {
    if (![60, 1440, 4320].includes(input.minutes)) throw new Error('请选择1小时、1天或3天后提醒');
    const next = new Date(Math.max(now.getTime(), dueAt(plan).getTime()));
    if (input.minutes === 60) next.setHours(next.getHours() + 1);
    else next.setDate(next.getDate() + input.minutes / 1440);
    plan.nextDate = dateKey(next);
    plan.time = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`;
  }
  const entry = { id: globalThis.crypto.randomUUID(), plantId: plant.id, plantName: plant.name, type: input.type, action: input.action, at: now.toISOString(), ...(input.action === 'done' ? { actualDate: input.actualDate } : {}), previous, nextDate: plan.nextDate, nextTime: plan.time, note };
  plant.revision = (plant.revision || 0) + 1;
  state.history.unshift(entry);
  return entry;
}

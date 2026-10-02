import { TYPES, dateKey, addDays, dueAt, dueKey, tasksFor, nextCareDate } from './model.js';
import { reminderId, dueReminders, pendingReminders } from './reminders.js';
const paths = {
  leaf: '<path d="M20 3C9 2 3 7 4 14s8 8 13 2c3-4 3-9 3-13Z"/><path d="M4 21 15 9"/>',
  water: '<path d="M12 3C9 8 5 11 5 15a7 7 0 0 0 14 0c0-4-4-7-7-12Z"/><path d="M8 15a4 4 0 0 0 4 4"/>',
  fertilizer: '<path d="M12 21v-9M12 14C4 15 3 9 4 5c7 0 9 5 8 9ZM12 11c0-6 3-9 8-9 1 6-3 10-8 9Z"/>',
  home: '<path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18M8 15h2M14 15h2"/>',
  settings: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8ZM10 21h4"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.leaf}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Resolve every app resource within its own directory, including subpath deployments.
const APP_ROOT = new URL('./', import.meta.url);
const appUrl = path => new URL(path.replace(/^\//, ''), APP_ROOT).href;
const storageKey = key => APP_ROOT.pathname === '/' ? key : `${key}:${APP_ROOT.pathname}`;
let hosted = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const PLACEHOLDER = appUrl('assets/plant-placeholder.svg');
const connectionMessage = () => hosted
  ? '与服务器暂时断开，正按页面已读取的计划提醒。连接恢复后才能保存修改。'
  : '本地服务暂时断开，正按页面已读取的计划提醒。请重新启动服务后保存修改。';
const connectionBanner = () => `<p class="connection-banner" role="status">${connectionMessage()}</p>`;
const isUploaded = image => typeof image === 'string' && image.startsWith('data:image/');
const photoResults = new Map();
const photoRequests = new Map();
function photoAttributes(plant) {
  if (isUploaded(plant.image)) return `src="${esc(plant.image)}"`;
  const result = photoResults.get(plant.name.trim())?.result;
  return `src="${esc(result?.imageUrl || PLACEHOLDER)}" data-auto-photo="${esc(plant.name.trim())}"`;
}
function photoCredit(plant) { return isUploaded(plant.image) ? '' : `<p class="photo-credit" data-photo-credit="${esc(plant.name.trim())}">按名称匹配网络图片…</p>`; }
function imageSourceLink(result) {
  return `<a href="${esc(result.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(result.matchedName)} · 图片来源</a><span>${esc(result.author)} · ${esc(result.license)}</span>`;
}
async function lookupPhoto(name) {
  name = name.trim();
  if (!name) return {status:'empty'};
  const cached = photoResults.get(name);
  if (cached && cached.expires > Date.now()) return cached.result;
  if (photoRequests.has(name)) return photoRequests.get(name);
  const request = api(`/api/plant-photo?name=${encodeURIComponent(name)}`).catch(() => ({status:'unavailable'})).then(result => {
    photoResults.set(name,{result,expires:Date.now() + (result.status === 'matched' ? 86400000 : 30000)});
    return result;
  }).finally(() => photoRequests.delete(name));
  photoRequests.set(name,request);
  return request;
}
function photoMessage(result) {
  if (result.status === 'matched') return `已自动匹配：${result.matchedName}`;
  if (result.status === 'empty') return '填写植物名称，自动匹配网络图片';
  return result.status === 'not-found' ? '未找到合适图片，可填写常见植物名或上传照片' : '暂时无法联网配图，可先保存，稍后自动重试';
}
function hydratePlantPhotos(root = main) {
  for (const img of root.querySelectorAll('img[data-auto-photo]')) {
    const name = img.dataset.autoPhoto;
    lookupPhoto(name).then(result => {
      if (!img.isConnected || img.dataset.autoPhoto !== name) return;
      img.src = result.imageUrl || PLACEHOLDER;
      img.title = photoMessage(result);
      for (const credit of root.querySelectorAll('[data-photo-credit]')) {
        if (credit.dataset.photoCredit === name) credit.innerHTML = result.status === 'matched' ? imageSourceLink(result) : esc(photoMessage(result));
      }
    });
  }
}
function retryPlantPhotos() {
  hydratePlantPhotos();
  const form = document.querySelector('#plant-form');
  if (!form || isUploaded(editingImage) || form.dataset.photoUploading === 'true') return;
  const cached = photoResults.get(form.elements.name.value.trim());
  if (cached?.result.status === 'unavailable' && cached.expires <= Date.now()) void updatePhotoPreview();
}
let photoLookupTimer, photoEditVersion = 0;
async function updatePhotoPreview() {
  const form = document.querySelector('#plant-form');
  if (!form) return;
  const version = ++photoEditVersion, img = form.querySelector('#plant-photo-preview'), status = form.querySelector('#photo-status'), credit = form.querySelector('#photo-credit');
  const name = form.elements.name.value.trim();
  credit.innerHTML = '';
  if (isUploaded(editingImage)) {
    img.src = editingImage; status.textContent = '已使用你上传的照片';
    form.querySelector('[data-action="photo-auto"]').textContent = '改用自动配图';
    return;
  }
  form.querySelector('[data-action="photo-auto"]').textContent = '按名称自动配图';
  img.src = photoResults.get(name)?.result.imageUrl || PLACEHOLDER;
  status.textContent = name ? '正在按名称查找图片…' : photoMessage({status:'empty'});
  const result = await lookupPhoto(name);
  if (!form.isConnected || version !== photoEditVersion || isUploaded(editingImage) || form.elements.name.value.trim() !== name) return;
  img.src = result.imageUrl || PLACEHOLDER;
  status.textContent = photoMessage(result);
  credit.innerHTML = result.status === 'matched' ? imageSourceLink(result) : '';
}
const monthDay = key => `${Number(key.slice(5, 7))}月${Number(key.slice(8, 10))}日`;
const fullDate = key => `${Number(key.slice(0, 4))}年${monthDay(key)}`;
const main = document.querySelector('#main');
const modal = document.querySelector('#modal');
const reminderDialog = document.querySelector('#reminder-dialog');
let state, filter = 'all', selectedDate = dateKey(), calendarMonth = dateKey().slice(0, 7), toastTimer, editingImage = 'auto', busy = false;
let view = () => ['today', 'plants', 'calendar', 'settings', 'history'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'today';
function toast(message, error = false) {
  const el = document.querySelector('#toast'); el.textContent = message; el.className = `toast visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), error ? 6000 : 3500);
}
async function api(url, method = 'GET', payload) {
  const response = await fetch(appUrl(url), { method, headers: payload ? { 'Content-Type': 'application/json' } : undefined, body: payload ? JSON.stringify(payload) : undefined });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '暂时无法保存，请重试'); return data;
}
function badge(type) { return `<span class="care-badge ${type}">${icon(type)}${type === 'water' ? '检查浇水' : '施肥提醒'}</span>`; }
function dueText(plan) { return `${plan.nextDate === dateKey() ? '今天' : plan.nextDate < dateKey() ? `${monthDay(plan.nextDate)} 待处理` : monthDay(plan.nextDate)} ${plan.time}`; }
function taskTiming(plan) { return dueAt(plan).getTime() <= Date.now() ? '已到提醒时间' : '尚未到提醒时间'; }
function taskCard({ plant, type, plan }) {
  return `<article class="task-card"><div class="task-top"><img class="plant-photo" ${photoAttributes(plant)} alt="${esc(plant.name)}"><div class="task-info"><button class="plant-title" data-action="edit" data-id="${esc(plant.id)}">${esc(plant.name)}</button><p class="plant-location">${icon('home')}${esc(plant.location || '家中的一角')}</p>${badge(type)}<p class="due-time ${plan.nextDate < dateKey() ? 'overdue' : ''}">${dueText(plan)}</p><p class="task-timing" data-due="${dueKey(plan)}">${taskTiming(plan)}</p><p class="last-care">上次${TYPES[type]}：${plan.lastDate ? monthDay(plan.lastDate) : '还未记录'}</p></div></div><div class="card-actions"><button class="button primary" data-action="care" data-id="${esc(plant.id)}" data-type="${type}">记录养护</button><button class="button secondary" data-action="snooze" data-id="${esc(plant.id)}" data-type="${type}">稍后提醒</button></div></article>`;
}
function empty(title, text, add = false) { return `<div class="empty-state">${icon('leaf')}<h3>${title}</h3><p>${text}</p>${add ? '<button class="button primary" data-action="add">添加第一盆植物</button>' : ''}</div>`; }
function weekPanel() {
  const days = Array.from({ length: 7 }, (_, i) => addDays(dateKey(), i));
  return `<section class="week-panel" aria-label="未来七天的养护计划"><div class="week-label"><h2>本周养护</h2><p class="helper">提醒周期可自行设置</p></div><div class="week-days">${days.map(day => { const tasks = tasksFor(state, day, false); return `<button class="day-btn ${day === dateKey() ? 'today selected' : ''}" data-action="day" data-date="${day}" aria-label="查看${monthDay(day)}的养护"><span>${Number(day.slice(5, 7))}/${Number(day.slice(8))}</span><span>${new Date(`${day}T12:00:00`).toLocaleDateString('zh-CN', { weekday: 'short' })}</span><span class="dots">${Object.keys(TYPES).filter(type => tasks.some(t => t.type === type)).map(type => `<i class="dot ${type}" title="${TYPES[type]}"></i>`).join('')}</span></button>`; }).join('')}</div><div class="legend"><span><i class="dot water"></i>浇水</span><span><i class="dot fertilizer"></i>施肥</span></div></section>`;
}
function todayPage() {
  const tasks = tasksFor(state), visible = tasks.filter(t => filter === 'all' || t.type === filter);
  return `<section class="hero"><img class="hero-photo" src="${appUrl('assets/monstera.png')}" alt="" aria-hidden="true"><div class="hero-content"><p class="eyebrow">${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })} · ${new Date().toLocaleDateString('zh-CN', { weekday: 'long' })}</p><h1>${tasks.length ? `今天有 ${tasks.length} 项照料提醒` : '今天的绿意，已照顾妥当'}</h1><p class="hero-subtitle">记得照料，也记得留一点时间给自己。</p><div class="stats"><div class="stat"><span class="stat-symbol water">${icon('water')}</span><div><strong>${tasks.filter(t => t.type === 'water').length}</strong><small>待检查浇水</small></div></div><div class="stat"><span class="stat-symbol fertilizer">${icon('fertilizer')}</span><div><strong>${tasks.filter(t => t.type === 'fertilizer').length}</strong><small>待检查施肥</small></div></div><div class="stat"><span class="stat-symbol">${icon('leaf')}</span><div><strong>${state.plants.length}</strong><small>盆植物</small></div></div></div></div></section><section class="section"><div class="section-heading"><h2>今日待办</h2><div class="filter-group" aria-label="养护类型筛选">${[['all','全部'],['water','浇水'],['fertilizer','施肥']].map(([key, text]) => `<button class="filter ${filter === key ? 'active' : ''}" aria-pressed="${filter === key}" data-action="filter" data-filter="${key}">${text}</button>`).join('')}</div><p class="helper">到时间先检查，再决定是否需要养护。</p></div>${visible.length ? `<div class="task-grid">${visible.map(taskCard).join('')}</div>` : empty(state.plants.length ? '这一刻，可以安心赏绿了' : '给生活添一点绿', state.plants.length ? '暂时没有待处理的提醒，下次照料会在这里出现。' : '添加你的植物，分别安排浇水与施肥的提醒。', !state.plants.length)}</section>${weekPanel()}<div class="recent-panel"><p>${state.history[0] ? `最近记录 · ${esc(state.history[0].plantName)} · ${actionLabel(state.history[0])}` : '每一次用心照料，都值得被记下来。'}</p><a class="text-button" href="#history">查看养护记录</a></div>`;
}
function actionLabel(h) { return h.action === 'done' ? `已${TYPES[h.type]}` : h.action === 'skip' ? '本次暂不需要' : '已推迟提醒'; }
function pageTop(title, subtitle, action = '') { return `<div class="page-top"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`; }
function plantsPage() {
  return `${pageTop('我的植物', `${state.plants.length} 盆绿意，各有自己的生长节奏。`)}${state.plants.some(p => p.isDemo) ? '<p class="sample-note">'+icon('leaf')+'已放入 3 盆示例植物，可编辑或移除。提醒周期仅作示例，请按实际情况调整。</p>' : ''}${state.plants.length ? `<div class="plants-grid">${state.plants.map(p => `<article class="plant-tile"><img ${photoAttributes(p)} alt="${esc(p.name)}" loading="lazy"><div class="plant-tile-content">${photoCredit(p)}<div class="plant-tile-head"><h2 class="plant-title">${esc(p.name)} ${p.isDemo ? '<span class="demo-tag">示例</span>' : ''}</h2><button class="icon-button" data-action="edit" data-id="${esc(p.id)}" aria-label="编辑${esc(p.name)}">${icon('more')}</button></div><p class="plant-location">${icon('home')}${esc(p.location || '家中的一角')}</p>${Object.keys(TYPES).map(type => `<div class="plan-row">${badge(type)}<span>${p[type].enabled ? `${monthDay(p[type].nextDate)} ${p[type].time}` : '提醒已暂停'}</span></div>`).join('')}${p.notes ? `<p class="helper plant-note">${esc(p.notes)}</p>` : ''}</div></article>`).join('')}</div>` : empty('从第一盆植物开始', '留下它的名字和位置，安排下一次养护。', true)}`;
}
function calendarPage() {
  const first = `${calendarMonth}-01`, weekday = new Date(`${first}T12:00:00`).getDay(), start = addDays(first, -(weekday + 6) % 7);
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const tasks = tasksFor(state, selectedDate, false);
  return `${pageTop('养护日历', '浇水与施肥，按自己的节奏安排。')}<section class="calendar-card"><div class="calendar-bar"><h2>${Number(calendarMonth.slice(0,4))} 年 ${Number(calendarMonth.slice(5))} 月</h2><div class="calendar-buttons"><button class="button subtle" data-action="month" data-delta="-1" aria-label="上个月">‹</button><button class="button subtle" data-action="calendar-today">今天</button><button class="button subtle" data-action="month" data-delta="1" aria-label="下个月">›</button></div></div><div class="calendar-week-labels">${'一二三四五六日'.split('').map(d => `<span>周${d}</span>`).join('')}</div><div class="month-grid">${days.map(day => { const items = tasksFor(state, day, false); return `<button class="month-cell ${day.slice(0,7) !== calendarMonth ? 'outside' : ''} ${day === dateKey() ? 'today' : ''} ${day === selectedDate ? 'selected' : ''}" aria-label="${monthDay(day)}，${items.length}项提醒" aria-pressed="${day === selectedDate}" data-action="select-date" data-date="${day}"><span class="date-number">${Number(day.slice(8))}</span><span class="dots">${Object.keys(TYPES).filter(t => items.some(i => i.type === t)).map(t => `<i class="dot ${t}"></i>`).join('')}</span>${items.length ? `<span class="cell-label">${items.length} 项提醒</span>` : ''}</button>`; }).join('')}</div><div class="calendar-bottom"><p class="helper">显示每项计划的下一次提醒；养护完成后自动更新。</p><div class="legend"><span><i class="dot water"></i>浇水</span><span><i class="dot fertilizer"></i>施肥</span></div></div></section><section class="section"><div class="section-heading"><h2>${monthDay(selectedDate)}的照料</h2><span class="helper">${tasks.length} 项提醒</span></div>${tasks.length ? `<div class="task-grid">${tasks.map(taskCard).join('')}</div>` : empty('这一天，让绿意自在生长', '没有安排提醒。你可以在“我的植物”中调整日期。')}</section>`;
}
function historyPage() {
  return `${pageTop('养护记录', '照料过的日子，都在这里。', '<a class="button subtle" href="#today">回到今天</a>')}${state.history.length ? `<div class="settings-card history-list">${state.history.slice(0,100).map(h => `<article class="history-row"><span class="history-symbol">${icon(h.action === 'done' ? 'check' : 'clock')}</span><div><h3>${esc(h.plantName)} · ${actionLabel(h)}</h3><p>${h.action === 'done' ? `实际${TYPES[h.type]}：${fullDate(h.actualDate || dateKey(h.at))}<br>` : ''}${TYPES[h.type]}计划 · 下次提醒 ${fullDate(h.nextDate)} ${h.nextTime}${h.note ? `<br>${esc(h.note)}` : ''}</p></div><time datetime="${h.at}">记录于<br>${new Date(h.at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time></article>`).join('')}${state.history.length > 100 ? '<p class="helper">显示最近 100 条记录，完整记录可在“我的”中导出备份。</p>' : ''}</div>` : empty('照料的故事，从今天开始', '记录一次浇水或施肥，日后就不必凭记忆猜测了。')}`;
}
function localRead(key) { try { return localStorage.getItem(storageKey(key)); } catch { return null; } }
function localWrite(key, value) { try { localStorage.setItem(storageKey(key), value); return true; } catch { return false; } }
function notificationEnabled() { return localRead('zhishi-notifications') === 'on' && 'Notification' in window && Notification.permission === 'granted'; }
function settingsPage() {
  const supported = 'Notification' in window && window.isSecureContext;
  return `${pageTop('我的植物角落', '少一点惦记，多一点安心。')}<div class="settings-grid"><section class="settings-card"><h2>到时间，轻轻提醒</h2><p>网页内弹窗已开启，到设定日期和时间会自动弹出，无需浏览器授权。请保持网页打开、设备唤醒；正在填写表单时，关闭表单后补弹。</p><button class="button secondary" data-action="reminder-test">测试网页提醒</button><p><strong>${!supported ? '当前浏览器不支持系统通知，页面提醒仍可使用。' : Notification.permission === 'denied' ? '通知权限已被关闭，可在浏览器的网站设置中修改。' : notificationEnabled() ? '浏览器通知已开启' : '浏览器通知尚未开启'}</strong></p><button class="button primary" data-action="notifications" ${!supported ? 'disabled' : ''}>${notificationEnabled() ? '关闭浏览器通知' : '开启浏览器通知'}</button><p class="helper">需要切换到其他应用后也能看到通知，可开启浏览器通知并允许权限。系统通知仍受浏览器、省电和勿扰设置影响。关闭网页或设备休眠时不会提醒，重新打开后会检查到期事项。</p></section><section class="settings-card"><h2>照料的痕迹，好好收着</h2><p>${hosted ? '植物和养护记录保存在服务器中，可在不同设备上查看和管理。' : '植物和养护记录保存在这台电脑中，刷新或重启服务后仍会保留。'}上传自己的植物照片，让每一盆都更好认。</p><a class="button secondary" href="#history">查看养护记录</a><button class="button subtle" data-action="export">导出数据备份</button><p class="helper">目前养着 ${state.plants.length} 盆植物，留下 ${state.history.filter(h => h.action === 'done').length} 次养护记录。</p></section></div>`;
}
function modalHeader(title, subtitle = '') { return `<div class="modal-header"><div><h2 id="modal-title">${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div><button class="icon-button" data-action="close" aria-label="关闭">${icon('close')}</button></div>`; }
function openModal(html) { document.querySelector('#modal-content').innerHTML = html; if (!modal.open) modal.showModal(); modal.scrollTop = 0; hydratePlantPhotos(modal); }
function defaultPlan(intervalDays) { return { enabled: true, intervalDays, nextDate: dateKey(), time: '09:00', lastDate: null }; }
function planFields(type, plan) {
  return `<fieldset class="plan-fieldset"><legend><label class="toggle-label"><input type="checkbox" name="${type}-enabled" ${plan.enabled ? 'checked' : ''}>${TYPES[type]}提醒</label></legend><div class="plan-fields"><div class="form-grid"><label class="field">下次${TYPES[type]}提醒<input type="date" name="${type}-date" value="${plan.nextDate}" min="2000-01-01" max="2200-12-31" required></label><label class="field">${TYPES[type]}提醒时间<input type="time" name="${type}-time" value="${plan.time}" required></label></div><div class="form-grid"><label class="field">${TYPES[type]}间隔（天）<input type="number" name="${type}-interval" value="${plan.intervalDays}" min="1" max="365" step="1" required></label><label class="field">上次${TYPES[type]}（可不填）<input type="date" name="${type}-last" min="2000-01-01" max="${dateKey()}" value="${plan.lastDate || ''}"></label></div></div></fieldset>`;
}
function openPlant(id) {
  const plant = id ? state.plants.find(p => p.id === id) : { name: '', location: '', notes: '', image: 'auto', water: defaultPlan(7), fertilizer: { ...defaultPlan(30), nextDate: addDays(dateKey(),30), enabled: false } };
  if (!plant) return;
  clearTimeout(photoLookupTimer); ++photoEditVersion;
  editingImage = isUploaded(plant.image) ? plant.image : 'auto';
  openModal(`${modalHeader(id ? '照顾这盆绿意' : '添一盆新绿', id ? '按实际情况，调整它的养护节奏。' : '取个名字，记下它在家中的小角落。')}<form id="plant-form" data-id="${esc(id || '')}" data-revision="${plant.revision || 0}"><div class="form-grid"><label class="field">植物名称<input name="name" maxlength="40" value="${esc(plant.name)}" placeholder="例如：窗边的龟背竹" required></label><label class="field">摆放位置<input name="location" maxlength="40" value="${esc(plant.location)}" placeholder="例如：客厅窗边"></label></div><section class="plant-photo-picker" aria-label="植物图片"><img id="plant-photo-preview" src="${isUploaded(editingImage) ? esc(editingImage) : PLACEHOLDER}" alt="植物图片预览"><div class="plant-photo-controls"><strong id="photo-status" aria-live="polite">填写名称后自动配图</strong><p class="helper">优先使用你上传的照片；未上传时按名称联网匹配，改名后会重新匹配。</p><div class="photo-buttons"><label class="upload-label">上传自己的照片<input type="file" name="photo" accept="image/jpeg,image/png,image/webp" aria-label="上传植物照片"></label><button type="button" class="button subtle" data-action="photo-auto">按名称自动配图</button></div></div><div id="photo-credit" class="photo-credit"></div></section>${planFields('water',plant.water)}${planFields('fertilizer',plant.fertilizer)}<p class="helper">周期是你的检查计划，并非必须浇水或施肥；请先观察植物与土壤。确认养护时需填写实际日期，并从该日期计算下一次提醒。</p><label class="field notes-field">养护备注<textarea name="notes" maxlength="500" placeholder="记下这盆植物的小习惯">${esc(plant.notes)}</textarea></label><p class="form-error" role="alert"></p><div class="modal-footer">${id ? `<button type="button" class="button danger" data-action="delete-ask" data-id="${esc(id)}">移除植物</button>` : ''}<button type="button" class="button subtle" data-action="close">取消</button><button type="submit" class="button primary">${id ? '保存修改' : '保存植物'}</button></div></form>`);
  void updatePhotoPreview();
}
function openCare(id, type, snooze = false) {
  const plant = state.plants.find(p => p.id === id); if (!plant || !TYPES[type]) return;
  const plan = plant[type];
  openModal(`${modalHeader(snooze ? '换个时间，记得回来' : `记录这次${TYPES[type]}`, '先检查，再按实际需要照料。')}<div class="care-summary"><img ${photoAttributes(plant)} alt="${esc(plant.name)}"><div><strong>${esc(plant.name)}</strong><p>${esc(plant.location)} · ${type === 'water' ? '检查浇水' : '施肥提醒'}<br>原定 ${dueText(plan)}<br>上次${TYPES[type]}：${plan.lastDate ? monthDay(plan.lastDate) : '还未记录'}</p></div></div><form id="care-form" data-id="${esc(id)}" data-type="${type}" data-expected="${dueKey(plan)}" data-revision="${plant.revision || 0}" data-interval="${plan.intervalDays}" data-time="${plan.time}" data-last="${plan.lastDate || ''}">${snooze ? `<p class="helper">从原定时间与当前时间中较晚的一个开始推迟，不会改变上次养护记录。</p><div class="choice-stack">${[[60,'1 小时后'],[1440,'1 天后'],[4320,'3 天后']].map(([minutes,label]) => `<button type="button" class="button secondary" data-action="care-save" data-kind="snooze" data-minutes="${minutes}">${icon('clock')}${label}再提醒</button>`).join('')}</div>` : `<section class="date-confirmation"><label class="field">实际${TYPES[type]}日期（必填）<input type="date" name="actual-date" required min="${plan.lastDate ? addDays(plan.lastDate,1) : '2000-01-01'}" max="${dateKey()}" aria-describedby="care-date-hint care-date-preview"></label><p id="care-date-hint" class="helper">请手动选择实际操作的日期，也可以补记之前的养护。</p><div id="care-date-preview" class="date-preview" aria-live="polite">填写日期后，将按 ${plan.intervalDays} 天的间隔计算下次${TYPES[type]}提醒。</div></section><label class="field">这次的小记录（可不填）<textarea name="note" maxlength="300" placeholder="例如：土壤已干，今天浇透了"></textarea></label><div class="choice-stack"><button type="button" class="button primary" data-action="care-save" data-kind="done" disabled>${icon('check')}确认日期并记录${TYPES[type]}</button><button type="button" class="button secondary" data-action="care-save" data-kind="skip">这次暂不需要，跳到下个周期</button></div><p class="helper">“暂不需要”只调整提醒日期，不会记录为已${TYPES[type]}。</p>`}<p class="form-error" role="alert"></p></form>`);
}
async function savePlant(form) {
  if (busy || form.dataset.photoUploading === 'true') return; busy = true;
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try {
    const data = new FormData(form), input = { name: data.get('name'), location: data.get('location'), notes: data.get('notes'), image: editingImage, revision: Number(form.dataset.revision) };
    for (const type of Object.keys(TYPES)) input[type] = { enabled: data.has(`${type}-enabled`), intervalDays: Number(data.get(`${type}-interval`)), nextDate: data.get(`${type}-date`), time: data.get(`${type}-time`), lastDate: data.get(`${type}-last`) || null };
    state = await api(form.dataset.id ? `/api/plants/${encodeURIComponent(form.dataset.id)}` : '/api/plants', form.dataset.id ? 'PUT' : 'POST', input);
    modal.close(); render(); toast(form.dataset.id ? '养护计划已更新' : '新植物已加入你的小花园');
  } catch (error) { form.querySelector('.form-error').textContent = error.message; }
  finally { busy = false; submit.disabled = false; }
}
function updateCareDatePreview(form) {
  const field = form.querySelector('[name="actual-date"]');
  if (!field) return true;
  const preview = form.querySelector('#care-date-preview'), button = form.querySelector('[data-kind="done"]');
  const plan = { intervalDays: Number(form.dataset.interval), lastDate: form.dataset.last || null };
  field.setAttribute('aria-invalid','false');
  preview.classList.remove('invalid-date');
  if (!field.value) {
    preview.textContent = `填写日期后，将按 ${plan.intervalDays} 天的间隔计算下次${TYPES[form.dataset.type]}提醒。`;
    button.disabled = true;
    return false;
  }
  try {
    const next = nextCareDate(plan,field.value);
    preview.innerHTML = `<span>实际${TYPES[form.dataset.type]} ${fullDate(field.value)} ＋ ${plan.intervalDays} 天</span><strong>下次提醒：${fullDate(next)} ${form.dataset.time}</strong>${next <= dateKey() ? '<p class="helper">下次提醒已到今天或更早，保存后会继续显示在今日待办中。</p>' : ''}`;
    button.disabled = busy;
    return true;
  } catch(error) {
    preview.textContent = error.message;
    preview.classList.add('invalid-date');
    field.setAttribute('aria-invalid','true');
    button.disabled = true;
    return false;
  }
}
async function saveCare(button) {
  if (busy) return;
  const form = button.closest('form');
  if (button.dataset.kind === 'done' && !updateCareDatePreview(form)) {
    form.querySelector('[name="actual-date"]').focus();
    return;
  }
  busy = true;
  form.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    state = await api('/api/care', 'POST', { plantId: form.dataset.id, type: form.dataset.type, expected: form.dataset.expected, expectedRevision: Number(form.dataset.revision), action: button.dataset.kind, actualDate: button.dataset.kind === 'done' ? form.querySelector('[name="actual-date"]').value : undefined, minutes: Number(button.dataset.minutes), note: form.querySelector('textarea')?.value || '' });
    modal.close(); render(); toast(button.dataset.kind === 'done' ? `已按实际${TYPES[form.dataset.type]}日期更新下次提醒` : button.dataset.kind === 'skip' ? '已跳过这次提醒，保留上次养护记录' : '提醒已推迟，养护记录保持不变');
  } catch (error) { form.querySelector('.form-error').textContent = error.message; }
  finally { busy = false; form.querySelectorAll('button').forEach(b => b.disabled = false); updateCareDatePreview(form); }
}
async function uploadPhoto(file) {
  if (!file) return;
  const form = document.querySelector('#plant-form');
  if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 15000000) { form.querySelector('.form-error').textContent = '请选择小于15MB的 JPG、PNG 或 WebP 图片'; return; }
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  clearTimeout(photoLookupTimer);
  const version = ++photoEditVersion; form.dataset.photoUploading = 'true';
  form.elements.photo.disabled = true;
  form.querySelector('[data-action="photo-auto"]').disabled = true;
  form.querySelector('#photo-status').textContent = '正在处理你的照片…';
  try {
    const bitmap = await createImageBitmap(file), canvas = document.createElement('canvas');
    const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f1f3eb'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(bitmap,0,0,canvas.width,canvas.height); bitmap.close();
    const result = canvas.toDataURL('image/jpeg',.82);
    if (result.length > 1400000) throw new Error('照片仍然过大，请换一张较小的照片');
    if (!form.isConnected || version !== photoEditVersion) return;
    editingImage = result;
    void updatePhotoPreview();
    form.querySelector('.form-error').textContent = '';
  } catch (error) { if (form.isConnected) form.querySelector('.form-error').textContent = error.message || '暂时无法读取这张照片，请换一张'; }
  finally { if (form.isConnected) { form.dataset.photoUploading = 'false'; submit.disabled = false; form.elements.photo.disabled = false; form.querySelector('[data-action="photo-auto"]').disabled = false; } }
}
async function toggleNotifications() {
  if (notificationEnabled()) { localWrite('zhishi-notifications','off'); render(); toast('已关闭浏览器通知，页面提醒仍会保留'); return; }
  if (!('Notification' in window)) return;
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') { if (!localWrite('zhishi-notifications','on')) throw new Error('浏览器无法保存通知偏好，请检查隐私设置'); toast('浏览器通知已开启，请保持网页打开'); }
    else toast(permission === 'denied' ? '未获得通知权限，页面提醒仍可使用' : '这次未开启通知');
    render(); await checkNotifications();
  } catch (error) { toast(error.message || '当前浏览器无法开启通知，页面提醒仍可使用',true); }
}
function readSeen(value) {
  try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}
function trimSeen(seen) { return Object.fromEntries(Object.entries(seen).sort((a,b) => b[1]-a[1]).slice(0,500)); }
let pageSeen = {};
try { pageSeen = readSeen(sessionStorage.getItem(storageKey('zhishi-page-reminders'))); } catch {}
let displayedReminders = [], reminderTest = false, reminderSignature = '', connectionLost = false;
function reminderBanner() {
  const due = dueReminders(state);
  return `<aside id="reminder-status" class="reminder-status ${due.length ? 'is-due' : ''}" aria-label="提醒状态"><span class="reminder-status-copy">${icon('bell')}<span>${due.length ? `有 ${due.length} 项照料已到提醒时间` : '网页内提醒已开启 · 请保持网页打开'}</span></span><button class="text-button" data-action="${due.length ? 'reminder-view' : 'reminder-settings'}">${due.length ? '查看提醒' : '提醒设置'}</button></aside>`;
}
function showReminder(due, test = false) {
  reminderTest = test;
  displayedReminders = due;
  const signature = test ? 'test' : due.map(reminderId).join('|');
  if (signature !== reminderSignature) {
    reminderSignature = signature;
    document.querySelector('#reminder-title').textContent = test ? '提醒测试成功' : `该照顾植物啦 · ${due.length} 项提醒`;
    document.querySelector('#reminder-description').textContent = test ? '你已看到网页弹窗。保持网页打开，实际到点时也会这样提醒。此测试不会修改养护计划。' : '以下照料已到设定时间。关闭提示后，事项仍会保留在今日待办中。';
    document.querySelector('#reminder-items').innerHTML = due.map(t => `<li><span class="care-badge ${t.type}">${icon(t.type)}${TYPES[t.type]}</span><div><strong>${esc(t.plant.name)}</strong><span>${dueText(t.plan)}</span></div></li>`).join('');
  }
  if (!reminderDialog.open) reminderDialog.showModal();
}
function dismissReminder() {
  if (!reminderTest) {
    displayedReminders.forEach(t => { pageSeen[reminderId(t)] = Date.now(); });
    pageSeen = trimSeen(pageSeen);
    try { sessionStorage.setItem(storageKey('zhishi-page-reminders'),JSON.stringify(pageSeen)); } catch {}
  }
  reminderDialog.close();
  displayedReminders = []; reminderSignature = ''; reminderTest = false;
}
function checkPageReminders() {
  if (!state) return;
  const due = dueReminders(state), banner = document.querySelector('#reminder-status');
  if (banner && banner.dataset.count !== String(due.length)) {
    banner.outerHTML = reminderBanner();
    document.querySelector('#reminder-status').dataset.count = String(due.length);
  }
  document.querySelectorAll('.task-timing').forEach(el => {
    const reached = new Date(el.dataset.due).getTime() <= Date.now();
    el.textContent = reached ? '已到提醒时间' : '尚未到提醒时间';
    el.classList.toggle('is-due',reached);
  });
  document.title = due.length ? `(${due.length}) 植时 · 养护到时间了` : '植时 · 把绿意照顾好';
  if (modal.open || busy || document.hidden || (reminderDialog.open && reminderTest)) return;
  const displayedIds = new Set(reminderDialog.open ? displayedReminders.map(reminderId) : []);
  const pending = due.filter(task => displayedIds.has(reminderId(task)) || !pageSeen[reminderId(task)]);
  if (pending.length) showReminder(pending);
  else if (reminderDialog.open) { reminderDialog.close(); displayedReminders = []; reminderSignature = ''; }
}
let notificationCheckRunning = false;
async function checkNotifications() {
  if (!state || !notificationEnabled() || notificationCheckRunning) return;
  notificationCheckRunning = true;
  try {
    const seen = readSeen(localRead('zhishi-notified'));
    const due = pendingReminders(state,seen);
    if (!due.length) return;
    const title = `植时 · ${due.length} 项养护提醒`, options = { body: due.map(t => `${t.plant.name}：${t.type === 'water' ? '检查土壤，按需浇水' : '检查是否需要施肥'}`).join('\n'), tag: 'zhishi-care', icon: appUrl('assets/monstera.png') };
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration(APP_ROOT.href) : null;
    if (registration?.active) await registration.showNotification(title,options);
    else new Notification(title,options);
    due.forEach(t => { seen[reminderId(t)] = Date.now(); });
    localWrite('zhishi-notified',JSON.stringify(trimSeen(seen)));
  } catch { localWrite('zhishi-notifications','off'); toast('系统通知暂不可用，网页弹窗仍会正常提醒',true); if (view() === 'settings') render(); }
  finally { notificationCheckRunning = false; }
}
function checkReminders() { checkPageReminders(); void checkNotifications(); }
function render() {
  if (!state) return;
  const current = view();
  document.querySelectorAll('.desktop-nav a').forEach(a => a.classList.toggle('active', a.hash === `#${current}`));
  document.querySelector('.settings-link').innerHTML = icon('leaf');
  document.querySelector('.mobile-nav').innerHTML = [['today','home','今日'],['plants','leaf','植物'],['calendar','calendar','日历'],['settings','settings','我的']].map(([v,i,label]) => `<a href="#${v}" class="${current === v || (v === 'settings' && current === 'history') ? 'active' : ''}" ${current === v ? 'aria-current="page"' : ''}>${icon(i)}${label}</a>`).join('');
  main.innerHTML = reminderBanner() + (connectionLost ? connectionBanner() : '') + { today: todayPage, plants: plantsPage, calendar: calendarPage, settings: settingsPage, history: historyPage }[current]();
  checkPageReminders();
  hydratePlantPhotos();
}
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  if (button.dataset.action === 'filter') { filter = button.dataset.filter; render(); }
  if (button.dataset.action === 'day') { selectedDate = button.dataset.date; calendarMonth = selectedDate.slice(0,7); location.hash = 'calendar'; }
  if (button.dataset.action === 'add') openPlant();
  if (button.dataset.action === 'edit') openPlant(button.dataset.id);
  if (button.dataset.action === 'close' && !busy) { modal.close(); refresh(); }
  if (button.dataset.action === 'care') openCare(button.dataset.id,button.dataset.type);
  if (button.dataset.action === 'snooze') openCare(button.dataset.id,button.dataset.type,true);
  if (button.dataset.action === 'care-save') await saveCare(button);
  if (button.dataset.action === 'photo-auto') { const form = button.closest('form'); if (form.dataset.photoUploading !== 'true') { editingImage = 'auto'; form.elements.photo.value = ''; void updatePhotoPreview(); } }
  if (button.dataset.action === 'select-date') { selectedDate = button.dataset.date; render(); }
  if (button.dataset.action === 'month') { const [y,m] = calendarMonth.split('-').map(Number); calendarMonth = dateKey(new Date(y,m-1+Number(button.dataset.delta),1,12)).slice(0,7); selectedDate = `${calendarMonth}-01`; render(); }
  if (button.dataset.action === 'calendar-today') { selectedDate = dateKey(); calendarMonth = selectedDate.slice(0,7); render(); }
  if (button.dataset.action === 'reminder-test') showReminder([],true);
  if (button.dataset.action === 'reminder-view') showReminder(dueReminders(state));
  if (button.dataset.action === 'reminder-settings') location.hash = 'settings';
  if (button.dataset.action === 'reminder-dismiss') dismissReminder();
  if (button.dataset.action === 'reminder-today') { dismissReminder(); filter = 'all'; location.hash = 'today'; render(); window.scrollTo({top:0,behavior:'instant'}); }
  if (button.dataset.action === 'notifications') await toggleNotifications();
  if (button.dataset.action === 'export') { const blob = new Blob([JSON.stringify(state,null,2)],{type:'application/json'}); const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `植时-养护备份-${dateKey()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); toast('已导出植物与养护记录'); }
  if (button.dataset.action === 'delete-ask') { const p = state.plants.find(p => p.id === button.dataset.id); openModal(`${modalHeader('移除这盆植物', `确定移除“${esc(p.name)}”吗？它的提醒会停止，已有养护记录会保留。`)}<p class="form-error" role="alert"></p><div class="modal-footer"><button class="button subtle" data-action="edit" data-id="${esc(p.id)}">保留植物</button><button class="button danger" data-action="delete" data-id="${esc(p.id)}">确认移除</button></div>`); }
  if (button.dataset.action === 'delete' && !busy) { busy = true; button.disabled = true; try { state = await api(`/api/plants/${encodeURIComponent(button.dataset.id)}`,'DELETE',{}); modal.close(); render(); toast('植物已移除，已有养护记录仍然保留'); } catch(error) { document.querySelector('.form-error').textContent = error.message; } finally { busy = false; button.disabled = false; } }
});
document.addEventListener('submit', event => { if (event.target.id === 'plant-form') { event.preventDefault(); savePlant(event.target); } else if (event.target.id === 'care-form') { event.preventDefault(); const button = event.target.querySelector('[data-kind="done"]'); if (button) saveCare(button); } });
document.addEventListener('change', event => { if (event.target.matches('input[name=photo]')) uploadPhoto(event.target.files[0]); if (event.target.matches('[name=actual-date]')) updateCareDatePreview(event.target.form); });
document.addEventListener('input', event => {
  if (event.target.matches('[name=actual-date]')) updateCareDatePreview(event.target.form);
  if (event.target.matches('#plant-form [name=name]') && !isUploaded(editingImage) && event.target.form.dataset.photoUploading !== 'true') {
    ++photoEditVersion; clearTimeout(photoLookupTimer);
    event.target.form.querySelector('#plant-photo-preview').src = PLACEHOLDER;
    event.target.form.querySelector('#photo-credit').innerHTML = '';
    event.target.form.querySelector('#photo-status').textContent = '等待名称输入完成…';
    photoLookupTimer = setTimeout(updatePhotoPreview,650);
  }
});
document.addEventListener('error', event => {
  if (event.target instanceof HTMLImageElement && event.target.getAttribute('src') !== PLACEHOLDER && event.target.matches('[data-auto-photo],#plant-photo-preview')) {
    event.target.src = PLACEHOLDER;
    event.target.title = '图片暂时无法加载';
    if (event.target.id === 'plant-photo-preview') document.querySelector('#photo-status').textContent = '图片暂时无法加载，可上传自己的照片或稍后重试';
  }
},true);
reminderDialog.querySelector('.reminder-symbol').innerHTML = icon('bell');
reminderDialog.addEventListener('cancel', event => { event.preventDefault(); dismissReminder(); });
modal.addEventListener('close', checkReminders);
modal.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
window.addEventListener('hashchange', () => { render(); window.scrollTo({ top: 0, behavior: 'instant' }); });
try {
  const config = await api('/api/config');
  if (typeof config.hosted === 'boolean') hosted = config.hosted;
} catch { /* Older local servers remain usable while being updated. */ }
try { state = await api('/api/state'); render(); }
catch { main.innerHTML = empty('暂时没有连接上', hosted ? '请检查网络连接，然后刷新页面重试。' : '请确认本地服务正在运行，然后刷新页面。'); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register(appUrl('sw.js'), { scope: APP_ROOT.pathname }).catch(() => {});
async function refresh() {
  if (busy) return;
  try { const next = await api('/api/state'); const changed = JSON.stringify(next) !== JSON.stringify(state); state = next; const recovered = connectionLost; connectionLost = false; if (!modal.open && (changed || view() === 'today' || recovered)) render(); }
  catch { connectionLost = true; if (!document.querySelector('.connection-banner')) main.insertAdjacentHTML('afterbegin',connectionBanner()); }
  finally { checkReminders(); }
}
setInterval(refresh,30000);
setInterval(retryPlantPhotos,30000);
window.addEventListener('online', () => {
  for (const [name,cached] of photoResults) if (cached.result.status === 'unavailable') cached.expires = 0;
  retryPlantPhotos();
});
setInterval(checkReminders,1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkReminders(); void refresh(); } });
window.addEventListener('focus', () => { checkReminders(); void refresh(); });
checkReminders();
const context = document.modelContext;
if (context?.registerTool) {
  const lifecycle = new AbortController();
  const register = tool => { try { Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(() => {}); } catch {} };
  register({ name:'list_plant_care_reminders', description:'Read the current personal plant care reminders, including overdue tasks. Does not modify any data.', inputSchema:{type:'object',properties:{},additionalProperties:false}, annotations:{readOnlyHint:true,untrustedContentHint:true}, async execute(input) { if (!input || typeof input !== 'object' || Object.keys(input).length) throw new Error('No arguments expected'); state = await api('/api/state'); render(); return { date:dateKey(),reminders:tasksFor(state).map(t => ({plantId:t.plant.id,plantName:t.plant.name,type:t.type,nextDate:t.plan.nextDate,time:t.plan.time})) }; } });
  register({ name:'start_add_plant', description:'Open the add-plant form for the user to complete. Does not save or create a plant.', inputSchema:{type:'object',properties:{},additionalProperties:false}, annotations:{readOnlyHint:false}, async execute(input) { if (!input || typeof input !== 'object' || Object.keys(input).length) throw new Error('No arguments expected'); if (modal.open) throw new Error('Finish or close the current dialog first'); openPlant(); return {status:'form_opened',saved:false}; } });
  window.addEventListener('pagehide', () => lifecycle.abort(),{once:true});
}

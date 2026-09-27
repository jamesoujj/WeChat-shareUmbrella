'use strict';
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const stamp = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '待确认';
const statusText = { available: '可借用', pendingPickup: '待取伞', borrowed: '已借出', maintenance: '待维修', lost: '已登记遗失' };
const activeStatus = status => ['pendingPickup', 'borrowed', 'returnPending'].includes(status);
const umbrellaSvg = '<svg class="umbrella-art" viewBox="0 0 60 90" fill="none" aria-hidden="true"><path d="M30 8v-4M30 39v37c0 11 15 11 15 0" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M3 40C4 1 56 1 57 40c-9-8-18-8-27 0C21 32 12 32 3 40Z" fill="currentColor"/><path d="M30 12c-6 6-10 16-10 23M30 12c6 6 10 16 10 23" stroke="#ffffff" opacity=".4" stroke-width="1.5"/></svg>';
let state;
let tab = 'cabinet';
let renderedTab = '';
let toastTimer;
let selectedAccount = 0;
const scanParams = new URLSearchParams(location.search);
const scannedKind = scanParams.has('umbrella') ? 'umbrella' : scanParams.has('slot') ? 'slot' : '';
const scannedId = Number(scanParams.get(scannedKind));
let photoUrls = [];
const tokens = { user: localStorage.getItem('umbrella-user') || '', admin: localStorage.getItem('umbrella-admin') || '' };

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4800);
}
async function api(endpoint, input, token = tokens.user) {
  const response = await fetch(endpoint, { method: input === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: input === undefined ? undefined : JSON.stringify(input) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || '操作失败，请重试。'), { status: response.status });
  return result;
}
function saveToken(kind, value) {
  tokens[kind] = value;
  if (value) localStorage.setItem('umbrella-' + kind, value);
  else localStorage.removeItem('umbrella-' + kind);
}
async function refresh() {
  const previous = JSON.stringify({ ...state, now: 0 });
  const kind = tab === 'admin' ? 'admin' : 'user';
  try { state = await api('/api/state', undefined, tokens[kind]); }
  catch (error) {
    if (error.status !== 401) throw error;
    saveToken(kind, '');
    if (tab === 'admin') tab = 'cabinet';
    state = await api('/api/state', undefined, tokens.user);
    toast('服务重新启动或登录已过期，请重新选择演示身份。');
  }
  if (previous !== JSON.stringify({ ...state, now: 0 }) || renderedTab !== tab) render();
  else $('#clock').textContent = '实验时间 ' + stamp(state.now);
}
function modal(content) {
  $('#modal-content').innerHTML = content;
  if (!$('#modal').open) $('#modal').showModal();
}
async function photoFromFile(file) {
  if (!file || !file.size) return null;
  if (!file.type.startsWith('image/')) throw new Error('请拍摄或选择照片。');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('照片无法读取，请改用JPG或PNG格式。')); image.src = url; });
    const scale = Math.min(1, 1200 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', .72);
    if (data.length > 2000000) throw new Error('照片过大，请换一张照片。');
    return data;
  } finally { URL.revokeObjectURL(url); }
}
function damageFields(report) {
  return `<div class="damage-fields"><label for="damage-note">损坏位置和情况</label><textarea class="field" id="damage-note" name="damageNote" rows="3" maxlength="300" placeholder="例如：伞骨弯曲，撑开后无法固定">${escapeHtml(report?.description || '')}</textarea>
    <label for="damage-photo">拍照或选择损坏照片（选填）</label><input class="field" id="damage-photo" name="damagePhoto" type="file" accept="image/*"><p class="hint">照片只供本人和维修管理员查看，上传前会在设备上压缩。</p>
    ${report?.hasPhoto ? '<p class="hint">已有照片；选择新照片可替换。</p>' : ''}<img id="damage-preview" class="damage-preview" alt="损坏照片预览" hidden></div>`;
}
function reportCard(report) {
  return `<article class="record"><div class="record-top"><strong>${report.umbrellaId}号伞 · ${escapeHtml(report.userName)}</strong><span class="tag ${report.returned ? '' : 'overdue'}">${report.returned ? '已归还，待维修' : '借用中，已报修'}</span></div>
    <p>${stamp(report.updatedAt)} · ${escapeHtml(report.description)}</p>${report.hasPhoto ? `<img class="report-photo" data-report-photo="${report.id}" alt="${report.umbrellaId}号伞损坏照片">` : '<small>未附照片</small>'}</article>`;
}
async function loadReportPhotos() {
  const token = tab === 'admin' ? tokens.admin : tokens.user;
  for (const img of document.querySelectorAll('[data-report-photo]')) {
    try {
      const response = await fetch('/api/damage/photo/' + img.dataset.reportPhoto, { headers: { Authorization: 'Bearer ' + token } });
      if (!response.ok) continue;
      const blob = await response.blob();
      if (!img.isConnected) continue;
      const url = URL.createObjectURL(blob);
      photoUrls.push(url);
      img.src = url;
    } catch { /* A missing photo does not block borrowing or returning. */ }
  }
}
function accountPanel() {
  if (!state.user) {
    const selected = state.demoUsers[selectedAccount] || state.demoUsers[0];
    return `<aside class="identity-panel"><h3>先认识一下你</h3><p class="hint">使用虚构校内名单，模拟实名身份核验。<br>不采集真实学籍或个人信息。</p>
      <div class="segmented">${state.demoUsers.map((user, index) => `<button data-account="${index}" class="${index === selectedAccount ? 'selected' : ''}">${user.role === 'teacher' ? '教师' : '学生' + (index + 1)}</button>`).join('')}</div>
      <form id="login-form"><input type="hidden" name="role" value="${selected.role}"><label for="login-name">姓名</label><input id="login-name" name="name" value="${escapeHtml(selected.name)}" required autocomplete="off">
      <label for="login-number">${selected.role === 'teacher' ? '教师编号' : '学籍号'}</label><input id="login-number" name="number" value="${selected.number}" required autocomplete="off">
      <label for="login-detail">${selected.role === 'teacher' ? '联系电话（演示号码）' : '班级'}</label><input id="login-detail" name="${selected.role === 'teacher' ? 'phone' : 'className'}" value="${escapeHtml(selected.role === 'teacher' ? selected.phone : selected.className)}" required autocomplete="off">
      <label for="login-pin">演示口令</label><input id="login-pin" name="pin" value="123456" required inputmode="numeric" autocomplete="off"><button class="primary wide" type="submit">认证并进入</button><p class="error" id="login-error"></p></form><p class="hint">口令仅用于本实验；访客可以查看库存，认证后才能借伞。</p></aside>`;
  }
  const loan = state.loans.find(item => activeStatus(item.status));
  const limited = state.user.score < state.rules.minimumScore;
  return `<aside class="identity-panel"><div class="account-title"><span class="avatar">${state.user.role === 'teacher' ? '师' : '生'}</span><div><h3>${escapeHtml(state.user.name)}</h3><small>${escapeHtml(state.user.number)} · ${escapeHtml(state.user.role === 'teacher' ? state.user.phone : state.user.className)} · 模拟认证通过</small></div></div>
    <button class="text-button" id="logout">切换身份</button><div class="score-row"><span>我的信用积分</span><strong>${state.user.score}<small> 分</small></strong></div><div class="score-meter"><progress max="120" value="${state.user.score}" aria-label="信用积分"></progress></div>
    <div class="notice ${limited ? 'warning' : ''}">${limited ? '积分低于60分，借用权限暂时受限。归还雨伞后低于60分恢复到70分。' : loan ? '这把伞正在借还流程中，完成归还后可以再次借用。' : '借用权限正常，可以选择一把雨伞。'}</div>
    <p class="hint">按时归还 +2分；逾期每满24小时扣10分。<br>每人同时借一把，借期48小时。</p>
    ${loan ? `<div class="current-loan"><h3>${loan.status === 'pendingPickup' ? '待取走' : '正在借用'} ${loan.umbrellaId} 号伞</h3><p>归还仓位：${loan.slotId} 号<br>应还时间：${stamp(loan.dueAt)}</p>${loan.overdue ? '<span class="tag overdue">已逾期，请尽快归还</span>' : ''}${state.damageReports.some(item => item.loanId === loan.id) ? '<p class="hint">已上报损坏，归还后自动转入待维修。</p>' : ''}${loan.status === 'pendingPickup' ? `<button class="primary wide" data-pickup="${loan.id}">模拟检测到取伞</button>` : `<button class="wide" data-report="${loan.id}">${state.damageReports.some(item => item.loanId === loan.id) ? '补充报修说明' : '上报雨伞损坏'}</button><button class="yellow wide" data-return="${loan.id}">归还这把伞</button>`}</div>` : ''}</aside>`;
}
function cabinetView() {
  const scannedItem = Number.isInteger(scannedId) ? state.umbrellas.find(item => item.id === scannedId) : null;
  const scannedLoan = state.loans.find(item => ['borrowed', 'returnPending'].includes(item.status));
  const scanPanel = scannedItem && scannedKind ? `<div class="section-panel scan-panel"><h2>扫码识别：${scannedId}号${scannedKind === 'umbrella' ? '爱心伞' : '归还仓位'}</h2><p>所属：上海市格致中学 · 晴雨之间<br>对应雨伞：${scannedId}号 · 对应仓位：${scannedId}号<br>当前状态：${statusText[scannedItem.status]}</p>${scannedKind === 'slot' && scannedLoan ? (scannedLoan.slotId === scannedId ? `<button class="primary" data-return="${scannedLoan.id}">归还到这个仓位</button>` : '<p class="warning">你借用的伞应归还到其他编号仓位。</p>') : ''}</div>` : '';
  return `${scanPanel}<div class="workbench">${accountPanel()}<section><div class="cabinet-heading"><h2>校园爱心伞柜</h2><span class="availability"><i class="status-dot"></i>${state.totals.available} 把可借</span></div>
    <div class="cabinet"><div class="cabinet-top"><strong>格致中学 · 晴雨之间</strong><span>借一把 · 还一份温暖</span></div><div class="slots">${state.umbrellas.map(item => `<div class="slot ${item.status}" id="slot-${item.id}"><div class="slot-top"><span class="slot-number">${String(item.id).padStart(2, '0')}</span><span class="slot-status">${statusText[item.status]}</span></div>${umbrellaSvg}<button data-borrow="${item.id}" ${!state.canBorrow || item.status !== 'available' ? 'disabled' : ''}>${item.status === 'available' ? '借这把伞' : statusText[item.status]}</button></div>`).join('')}</div></div>
    <p class="cabinet-note">每个仓位对应同编号雨伞。点击借伞后模拟解锁，归还时核对雨伞与仓位编号。</p>
    <div class="entry-strip"><div class="entry-copy"><h3>打印伞与仓位标识</h3><p>选择编号，打印一张贴在伞柄、一张贴在对应仓位。二维码会打开该编号的信息页。</p><select id="label-id" aria-label="标识编号">${state.umbrellas.map(item => `<option value="${item.id}">${item.id}号伞 / ${item.slotId}号仓位</option>`).join('')}</select><div class="label-links"><a id="umbrella-label" target="_blank" rel="noopener" href="/api/label?kind=umbrella&id=1">查看伞标识</a><a id="slot-label" target="_blank" rel="noopener" href="/api/label?kind=slot&id=1">查看仓位标识</a></div></div></div>
    <div class="entry-strip"><img class="qr-code" id="entry-qr" src="/api/qr?url=${encodeURIComponent(state.urls[0])}" alt="当前演示入口二维码"><div class="entry-copy"><h3>扫码进入爱心伞</h3><p>${state.lan ? '手机和电脑连接同一网络，选择电脑对应地址。' : '当前为本机入口。手机扫码请先运行“启动手机演示.cmd”。'}<br>此二维码打开网页演示，不是已发布的微信小程序码。</p><select id="entry-url" aria-label="二维码目标地址">${state.urls.map(url => `<option value="${escapeHtml(url)}">${escapeHtml(url)}</option>`).join('')}</select></div></div>
    </section></div>`;
}
function recordList(loans) {
  return loans.length ? loans.map(loan => `<article class="record"><div class="record-top"><strong>${loan.umbrellaId}号雨伞</strong><span class="tag ${loan.overdue ? 'overdue' : ''}">${loan.status === 'cancelled' ? '取伞超时取消' : loan.status === 'exception' ? '异常已结案' : loan.status === 'pendingPickup' ? '等待取伞' : loan.status === 'returnPending' ? '归还待检测' : loan.returnedAt ? (loan.onTime ? '按时归还' : '逾期已归还') : loan.overdue ? '逾期未还' : '借用中'}</span></div><p>${loan.userName ? escapeHtml(loan.userName) + '　' : ''}借出：${stamp(loan.borrowedAt)}<br>应还：${stamp(loan.dueAt)}${loan.returnedAt ? '<br>归还：' + stamp(loan.returnedAt) : ''}${loan.damaged ? '<br>已报修，归还后转待维修。' : ''}</p></article>`).join('') : '<p class="empty">还没有借还记录。<br>借出第一把伞后，这里会记下它的旅程。</p>';
}
function reminderList() {
  return state.reminders.length ? state.reminders.map(item => `<article class="record"><div class="record-top"><strong>${escapeHtml(item.stage)}</strong><small>${stamp(item.at)}</small></div><p>${item.umbrellaId}号伞：${escapeHtml(item.text)}</p><small>站内消息 · 模拟推送</small></article>`).join('') : '<p class="empty">暂时没有归还提醒。<br>借伞后可在实验控制台推进时间查看。</p>';
}
function recordsView() {
  if (!state.user) return '<div class="section-panel empty">请先在“借还雨伞”中完成演示身份认证。</div>';
  return `<div class="records-layout"><section class="section-panel"><h2>我的借还记录</h2>${recordList(state.loans)}<h3 class="subheading">我的报修</h3>${state.damageReports.length ? state.damageReports.map(reportCard).join('') : '<p class="empty">暂无报修记录。</p>'}<h3 class="subheading">积分明细</h3>${state.scoreEvents.length ? state.scoreEvents.map(item => `<div class="record"><div class="record-top"><span>${escapeHtml(item.reason)}</span><strong>${item.change >= 0 ? '+' : ''}${item.change}</strong></div><p>${stamp(item.at)}　积分余额：${item.score}</p></div>`).join('') : '<p class="empty">暂时没有积分变动。</p>'}</section><section class="section-panel"><h2>归还提醒</h2><p class="hint">本页展示分级提醒的实验效果，不会发送微信通知或短信。</p>${reminderList()}</section></div>`;
}
function adminView() {
  if (!state.admin) return '<div class="section-panel empty">请使用管理员演示口令进入。</div>';
  const overdue = state.loans.filter(item => item.overdue);
  return `<div class="metrics">${[['可借雨伞', state.totals.available], ['已借出', state.totals.borrowed], ['逾期未还', overdue.length], ['待修 / 遗失', state.totals.maintenance + ' / ' + state.totals.lost]].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>
    <section class="section-panel"><h2>雨伞与仓位管理</h2><div class="table-wrap"><table><thead><tr><th>雨伞</th><th>仓位</th><th>当前状态</th><th>状态调整</th></tr></thead><tbody>${state.umbrellas.map(item => `<tr><td>${item.id}号伞</td><td>${item.slotId}号仓位</td><td>${statusText[item.status]}</td><td>${['borrowed', 'pendingPickup'].includes(item.status) ? '借用流程中，等待归还' : `<select data-status="${item.id}" aria-label="${item.id}号伞状态">${['available', 'maintenance', 'lost'].map(status => `<option value="${status}" ${item.status === status ? 'selected' : ''}>${statusText[status]}</option>`).join('')}</select>`}</td></tr>`).join('')}</tbody></table></div></section>
    <div class="admin-grid"><section class="section-panel"><h2>逾期名单</h2>${recordList(overdue)}</section><section class="section-panel"><h2>用户积分</h2>${state.users.map(user => `<div class="record"><div class="record-top"><strong>${escapeHtml(user.name)}</strong><span class="tag ${user.score < 60 ? 'overdue' : ''}">${user.score}分</span></div><p>${user.role === 'teacher' ? '教师' : '学生'}　${escapeHtml(user.number)}${user.score < 60 ? '　借用权限受限' : ''}</p></div>`).join('')}</section></div>
    <section class="section-panel"><h2>全部借还记录</h2>${recordList(state.loans)}</section><div class="admin-grid"><section class="section-panel"><h2>模拟开锁记录</h2>${state.lockEvents.length ? state.lockEvents.map(item => `<div class="record"><div class="record-top"><strong>${item.slotId}号仓位 · ${item.purpose === 'borrow' ? '借伞开锁' : '归还开锁'}</strong><span class="tag muted">模拟</span></div><p>${stamp(item.at)}　对应${item.umbrellaId}号伞</p></div>`).join('') : '<p class="empty">借还操作后生成开锁记录。</p>'}</section><section class="section-panel"><h2>报修照片与说明</h2>${state.damageReports.length ? state.damageReports.map(reportCard).join('') : '<p class="empty">暂时没有报修记录。</p>'}</section></div>`;
}
function render() {
  renderedTab = tab;
  photoUrls.forEach(URL.revokeObjectURL);
  photoUrls = [];
  $('#app').innerHTML = tab === 'cabinet' ? cabinetView() : tab === 'records' ? recordsView() : adminView();
  document.querySelectorAll('[data-tab]').forEach(button => { button.classList.toggle('active', button.dataset.tab === tab); button.setAttribute('aria-current', button.dataset.tab === tab ? 'page' : 'false'); });
  $('#clock').textContent = '实验时间 ' + stamp(state.now);
  $('#reminder-count').textContent = tab !== 'admin' && state.reminders.length ? `(${state.reminders.length})` : '';
  loadReportPhotos();
}
function withAdmin(callback) {
  if (tokens.admin) return callback().catch(error => {
    if (error.status === 401) { saveToken('admin', ''); withAdmin(callback); }
    else toast(error.message);
  });
  modal('<h2>管理员演示身份</h2><p>管理后台与实验控制台使用同一个演示口令。</p><form id="admin-login"><label for="admin-pin">管理员口令</label><input id="admin-pin" class="field" name="pin" value="2026" required autocomplete="off"><p class="error" id="admin-error"></p><div class="dialog-actions"><button type="button" data-close>取消</button><button class="primary" type="submit">进入</button></div></form>');
  $('#admin-login').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try { const result = await api('/api/admin/login', { pin: new FormData(event.target).get('pin') }, ''); saveToken('admin', result.token); $('#modal').close(); await callback(); }
    catch (error) { if ($('#admin-error')) $('#admin-error').textContent = error.message; else toast(error.message); }
    finally { button.disabled = false; }
  });
}
async function openReturn(loanId) {
  const result = await api('/api/return/open', { loanId });
  const loan = result.loan;
  const report = state.damageReports.find(item => item.loanId === loanId);
  modal(`<h2>${loan.slotId}号归还仓位已解锁</h2><p>请把 <strong>${loan.umbrellaId}号伞</strong> 放回 <strong>${loan.slotId}号仓位</strong>。</p><p class="hint">当前为设备模拟：勾选后提交归还信息，模拟在位检测与锁闭通过后才完成归还。</p>
    <form id="return-form"><label for="return-umbrella">放入的雨伞编号</label><select class="field" id="return-umbrella" name="umbrellaId">${state.umbrellas.map(item => `<option value="${item.id}" ${item.id === loan.umbrellaId ? 'selected' : ''}>${item.id}号伞</option>`).join('')}</select>
    <label for="return-slot">放入的仓位编号</label><select class="field" id="return-slot" name="slotId">${state.umbrellas.map(item => `<option value="${item.slotId}" ${item.slotId === loan.slotId ? 'selected' : ''}>${item.slotId}号仓位</option>`).join('')}</select>
    <label class="checkbox-label"><input type="checkbox" name="confirmed" required>我已将雨伞放入上述仓位并关好柜门（模拟确认）。</label><label class="checkbox-label"><input id="return-damaged" type="checkbox" name="damaged" ${report ? 'checked disabled' : ''}>这把伞已经坏了，需要报修</label>
    <div id="return-damage-fields" ${report ? '' : 'hidden'}>${damageFields(report)}</div><p class="error" id="return-error"></p><div class="dialog-actions"><button type="button" data-close>暂不归还</button><button type="submit" class="primary">确认归还</button></div></form>`);
  $('#return-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    const data = new FormData(event.target);
    try {
      const damaged = !!report || data.has('damaged');
      const photoData = damaged ? await photoFromFile(data.get('damagePhoto')) : null;
      await api('/api/return', { loanId, umbrellaId: Number(data.get('umbrellaId')), slotId: Number(data.get('slotId')),
        confirmed: data.has('confirmed'), damaged, damageNote: damaged ? data.get('damageNote') : '', photoData });
      const response = await api('/api/demo/device', { event: 'return-confirm', loanId, umbrellaId: Number(data.get('umbrellaId')),
        slotId: Number(data.get('slotId')), present: true, locked: true, stableMs: 3000 });
      $('#modal').close(); await refresh(); toast(response.message);
    } catch (error) { $('#return-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
}
function openDamageReport(loanId) {
  const loan = state.loans.find(item => item.id === loanId && ['borrowed', 'returnPending'].includes(item.status));
  if (!loan) return toast('请先借用雨伞。');
  const report = state.damageReports.find(item => item.loanId === loanId);
  modal(`<h2>${loan.umbrellaId}号伞损坏上报</h2><p>拍下损坏部位并简单说明。现在上报后仍需把伞放回${loan.slotId}号仓位，系统会自动停用待修。</p>
    <form id="damage-form">${damageFields(report)}<p class="error" id="damage-error"></p><div class="dialog-actions"><button type="button" data-close>取消</button><button type="submit" class="primary">提交报修</button></div></form>`);
  $('#damage-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    const data = new FormData(event.target);
    try {
      const photoData = await photoFromFile(data.get('damagePhoto'));
      const response = await api('/api/damage/report', { loanId, description: data.get('damageNote'), photoData });
      $('#modal').close(); await refresh(); toast(response.message);
    } catch (error) { $('#damage-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
}
document.addEventListener('submit', async event => {
  if (event.target.id !== 'login-form') return;
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { const result = await api('/api/login', Object.fromEntries(new FormData(event.target)), ''); saveToken('user', result.token); await refresh(); toast('演示身份认证通过，可以借伞了。'); }
  catch (error) { if ($('#login-error')) $('#login-error').textContent = error.message; else toast(error.message); }
  finally { button.disabled = false; }
});
document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  try {
    if (button.hasAttribute('data-close')) return $('#modal').close();
    if (button.hasAttribute('data-tab')) {
      if (button.dataset.tab === 'admin') return withAdmin(async () => { tab = 'admin'; await refresh(); });
      tab = button.dataset.tab; return await refresh();
    }
    if (button.hasAttribute('data-account')) { selectedAccount = Number(button.dataset.account); return render(); }
    if (button.id === 'logout') { await api('/api/logout', {}); saveToken('user', ''); return await refresh(); }
    if (button.hasAttribute('data-borrow')) {
      button.disabled = true;
      const result = await api('/api/borrow', { umbrellaId: Number(button.dataset.borrow) });
      await refresh(); $('#slot-' + result.loan.slotId)?.classList.add('flash');
      return modal(`<h2>${result.loan.slotId}号仓位已模拟解锁</h2><p>请取走 <strong>${result.loan.umbrellaId}号雨伞</strong>。检测到取伞后才开始48小时借期。</p><div class="notice">按时归还可获得2积分。</div><div class="dialog-actions"><button data-close>暂不确认</button><button class="primary" data-pickup="${result.loan.id}">模拟检测到取伞</button></div>`);
    }
    if (button.hasAttribute('data-pickup')) {
      button.disabled = true;
      const response = await api('/api/demo/device', { event: 'pickup', loanId: button.dataset.pickup });
      if ($('#modal').open) $('#modal').close();
      await refresh(); return toast(`借伞成功，请在${stamp(response.loan.dueAt)}前归还。`);
    }
    if (button.hasAttribute('data-return')) { button.disabled = true; await openReturn(button.dataset.return); button.disabled = false; return; }
    if (button.hasAttribute('data-report')) return openDamageReport(button.dataset.report);
    if (button.hasAttribute('data-advance')) return withAdmin(async () => {
      await api('/api/demo/advance', { hours: Number(button.dataset.advance) }, tokens.admin); await refresh(); toast('实验时间已推进，提醒和积分已更新。');
    });
    if (button.id === 'reset-demo') return withAdmin(async () => {
      modal('<h2>重新开始实验？</h2><p>这会清空本原型的借还、积分和提醒记录，恢复6把可借雨伞。</p><div class="dialog-actions"><button data-close>保留记录</button><button class="primary" id="confirm-reset">确认重置</button></div>');
    });
    if (button.id === 'confirm-reset') { button.disabled = true; await api('/api/demo/reset', { confirm: 'RESET' }, tokens.admin); $('#modal').close(); await refresh(); return toast('实验已重置。'); }
  } catch (error) { button.disabled = false; toast(error.message); }
});
document.addEventListener('change', async event => {
  const select = event.target;
  if (select.id === 'return-damaged') $('#return-damage-fields').hidden = !select.checked;
  if (select.id === 'damage-photo') {
    try {
      const data = await photoFromFile(select.files[0]);
      const preview = $('#damage-preview');
      if (preview && data) { preview.src = data; preview.hidden = false; }
    } catch (error) { const message = $('#return-error') || $('#damage-error'); if (message) message.textContent = error.message; }
  }
  if (select.id === 'entry-url') $('#entry-qr').src = '/api/qr?url=' + encodeURIComponent(select.value);
  if (select.id === 'entry-url' || select.id === 'label-id') {
    const id = $('#label-id')?.value || '1';
    const url = $('#entry-url')?.value || state.urls[0];
    $('#umbrella-label').href = `/api/label?kind=umbrella&id=${id}&url=${encodeURIComponent(url)}`;
    $('#slot-label').href = `/api/label?kind=slot&id=${id}&url=${encodeURIComponent(url)}`;
  }
  if (select.hasAttribute('data-status')) {
    select.disabled = true;
    try { await api('/api/admin/umbrella', { umbrellaId: Number(select.dataset.status), status: select.value }, tokens.admin); await refresh(); toast('雨伞状态已更新。'); }
    catch (error) { select.disabled = false; toast(error.message); await refresh(); }
  }
});
refresh().catch(error => { $('#app').innerHTML = '<p class="empty">暂时无法连接，请确认启动窗口仍在运行，然后刷新页面。</p>'; toast(error.message); });
setInterval(() => {
  if (!document.hidden && !$('#modal').open && !['INPUT', 'SELECT'].includes(document.activeElement?.tagName)) refresh().catch(() => {});
}, 5000);

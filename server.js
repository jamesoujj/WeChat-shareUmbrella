'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { openStore } = require('./lib/store');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const RULES = { borrowHours: 48, initialScore: 100, minimumScore: 60, maximumScore: 120,
  onTimeReward: 2, overduePenaltyPerDay: 10, restoreScore: 70, pickupSeconds: 60, stableSeconds: 3 };
const STAGES = [
  { hours: 24, label: '借出24小时', text: '您借用的爱心伞尚未归还，请留意归还时间。' },
  { hours: 72, label: '逾期1天', text: '您借用的爱心伞已经逾期，请尽快放回对应仓位。' },
  { hours: 120, label: '逾期3天', text: '爱心伞已逾期3天，请尽快归还。' }
];
const DEMO_USERS = [
  { id: 'student-1', role: 'student', number: 'S2026001', name: '演示同学一', className: '高二（1）班' },
  { id: 'student-2', role: 'student', number: 'S2026002', name: '演示同学二', className: '高二（2）班' },
  { id: 'teacher-1', role: 'teacher', number: 'T0001', name: '演示老师', phone: '00000000000' }
];

function seed() {
  return {
    version: 2, offsetMs: 0,
    users: DEMO_USERS.map(user => ({ ...user, score: RULES.initialScore })),
    umbrellas: Array.from({ length: 6 }, (_, index) => ({ id: index + 1, slotId: index + 1, status: 'available' })),
    loans: [], reminders: [], scoreEvents: [], lockEvents: [], maintenance: [], damageReports: [], deviceEvents: []
  };
}

function createDemoServer({ dataFile = path.join(__dirname, 'data', 'state.sqlite'), lan = false } = {}) {
  const store = openStore(dataFile, seed);
  let db = store.read();
  const photoDir = path.join(path.dirname(dataFile), 'photos');
  const sessions = new Map();
  const now = () => Date.now() + db.offsetMs;
  const save = () => {
    try { store.write(db); }
    catch (error) { db = store.read(); throw error; }
  };
  function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
  function changeScore(user, change, reason, loanId, at, day = null) {
    const before = user.score;
    user.score = Math.max(0, Math.min(RULES.maximumScore, before + change));
    db.scoreEvents.push({ id: crypto.randomUUID(), userId: user.id, loanId, at, day,
      change: user.score - before, reason, score: user.score });
  }
  function applyRules() {
    const at = now();
    let changed = false;
    for (const loan of db.loans) {
      if (loan.status === 'pendingPickup' && at >= loan.reservedUntil) {
        loan.status = 'cancelled'; loan.closedAt = at;
        const umbrella = db.umbrellas.find(item => item.id === loan.umbrellaId);
        if (umbrella.status === 'pendingPickup') umbrella.status = 'available';
        changed = true;
      }
      if (!['borrowed', 'returnPending'].includes(loan.status)) continue;
      const user = db.users.find(item => item.id === loan.userId);
      const effectiveAt = loan.penaltyFrozenAt ? Math.min(at, loan.penaltyFrozenAt) : at;
      for (const stage of STAGES) {
        if (effectiveAt >= loan.borrowedAt + stage.hours * HOUR && !loan.reminded.includes(stage.hours)) {
          db.reminders.push({ id: crypto.randomUUID(), userId: user.id, loanId: loan.id, umbrellaId: loan.umbrellaId,
            at, scheduledAt: loan.borrowedAt + stage.hours * HOUR, stage: stage.label, text: stage.text,
            status: 'recorded', simulated: true });
          loan.reminded.push(stage.hours);
          changed = true;
        }
      }
      const elapsedDays = Math.max(0, Math.floor((effectiveAt - loan.dueAt) / DAY));
      for (let day = loan.penalizedDays + 1; day <= elapsedDays; day++) {
        changeScore(user, -RULES.overduePenaltyPerDay, '逾期扣分', loan.id, at, day);
        loan.penalizedDays = day;
        changed = true;
      }
    }
    if (changed) save();
  }
  function lock(loan, purpose) {
    const event = { id: crypto.randomUUID(), at: now(), slotId: loan.slotId, umbrellaId: loan.umbrellaId,
      userId: loan.userId, loanId: loan.id, purpose, mode: 'simulated', result: 'opened' };
    db.lockEvents.push(event);
    return event;
  }
  function getActor(req, adminOnly = false) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const session = sessions.get(token);
    if (!session || session.expires < Date.now()) fail('请先登录演示身份。', 401);
    if (adminOnly && session.role !== 'admin') fail('请使用管理员身份。', 403);
    return session;
  }
  function getUser(req) {
    const actor = getActor(req);
    const user = db.users.find(item => item.id === actor.userId);
    if (!user) fail('请先选择学生或教师身份。', 403);
    return user;
  }
  const activeLoan = userId => db.loans.find(loan => loan.userId === userId && ['pendingPickup', 'borrowed', 'returnPending'].includes(loan.status));
  function decodePhoto(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 2100000) fail('照片过大，请选择不超过1.5MB的照片。', 413);
    const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match) fail('照片只支持JPG、PNG或WEBP格式。');
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > 1500000) fail('照片过大，请选择不超过1.5MB的照片。', 413);
    const type = match[1];
    const valid = type === 'jpeg' ? buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) :
      type === 'png' ? buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) :
      buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) fail('照片内容与文件格式不匹配。');
    return { buffer, type, extension: type === 'jpeg' ? 'jpg' : type };
  }
  function saveDamage(loan, user, description, photoData, at) {
    const note = String(description || '').trim();
    if (note.length < 2 || note.length > 300) fail('请用2至300字说明损坏位置和情况。');
    const photo = decodePhoto(photoData);
    let report = db.damageReports.find(item => item.loanId === loan.id);
    let photoFile = report?.photoFile || null;
    if (photo) {
      fs.mkdirSync(photoDir, { recursive: true });
      photoFile = `${crypto.randomUUID()}.${photo.extension}`;
      fs.writeFileSync(path.join(photoDir, photoFile), photo.buffer, { flag: 'wx' });
    }
    if (report) {
      if (photo && report.photoFile) fs.unlinkSync(path.join(photoDir, report.photoFile));
      Object.assign(report, { description: note, photoFile, updatedAt: at });
    } else {
      report = { id: crypto.randomUUID(), loanId: loan.id, userId: user.id, umbrellaId: loan.umbrellaId,
        at, updatedAt: at, description: note, photoFile };
      db.damageReports.push(report);
    }
    return report;
  }
  const publicReport = report => ({ id: report.id, loanId: report.loanId, umbrellaId: report.umbrellaId,
    userName: db.users.find(item => item.id === report.userId)?.name, at: report.at, updatedAt: report.updatedAt,
    description: report.description, hasPhoto: !!report.photoFile,
    returned: !!db.loans.find(item => item.id === report.loanId)?.returnedAt });
  function recordDevice(loan, type, at, detail = {}) {
    const event = { id: crypto.randomUUID(), loanId: loan?.id || null, umbrellaId: loan?.umbrellaId || null,
      at, type, simulated: true, ...detail };
    db.deviceEvents.push(event);
    return event;
  }
  function finalizeReturn(loan, observedAt) {
    const user = db.users.find(item => item.id === loan.userId);
    const validDays = Math.max(0, Math.floor((observedAt - loan.dueAt) / DAY));
    if (loan.penalizedDays > validDays) {
      const refund = db.scoreEvents.filter(event => event.loanId === loan.id && event.reason === '逾期扣分' &&
        event.day > validDays && !event.reversedAt).reduce((total, event) => {
        event.reversedAt = now();
        return total - event.change;
      }, 0);
      if (refund) changeScore(user, refund, '设备事件补传校正', loan.id, now());
      loan.penalizedDays = validDays;
    }
    loan.status = 'returned'; loan.returnedAt = observedAt; loan.onTime = observedAt <= loan.dueAt;
    loan.damaged = loan.returnIntent.damaged;
    const umbrella = db.umbrellas.find(item => item.id === loan.umbrellaId);
    umbrella.status = loan.damaged ? 'maintenance' : 'available';
    if (loan.onTime) changeScore(user, RULES.onTimeReward, '按时归还奖励', loan.id, observedAt);
    if (user.score < RULES.minimumScore) changeScore(user, RULES.restoreScore - user.score, '归还后恢复借用权限', loan.id, observedAt);
    if (loan.damaged) db.maintenance.push({ id: crypto.randomUUID(), at: observedAt, umbrellaId: umbrella.id,
      status: 'maintenance', note: db.damageReports.find(item => item.loanId === loan.id)?.description || '归还时报告损坏' });
    for (const reminder of db.reminders.filter(item => item.loanId === loan.id && item.scheduledAt >= observedAt))
      reminder.status = 'cancelled';
  }
  function view(req) {
    let actor;
    if (req.headers.authorization) actor = getActor(req);
    const admin = actor?.role === 'admin';
    const user = db.users.find(item => item.id === actor?.userId) || null;
    const at = now();
    const loans = db.loans.filter(loan => admin || loan.userId === user?.id).map(loan => ({ ...loan,
      overdue: ['borrowed', 'returnPending'].includes(loan.status) && at > loan.dueAt,
      userName: db.users.find(item => item.id === loan.userId)?.name,
      userRole: db.users.find(item => item.id === loan.userId)?.role
    })).reverse();
    const port = server.address()?.port || 8766;
    const localUrl = `http://127.0.0.1:${port}/`;
    const addresses = Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal);
    const urls = lan ? [...new Set(addresses.map(item => `http://${item.address}:${port}/`)), localUrl] : [localUrl];
    return { now: at, rules: RULES, stages: STAGES, user, admin, demoUsers: DEMO_USERS,
      umbrellas: db.umbrellas.map(item => ({ ...item })), loans,
      reminders: db.reminders.filter(item => admin || (user && item.userId === user.id && item.status !== 'cancelled')).slice().reverse(),
      scoreEvents: db.scoreEvents.filter(item => admin || item.userId === user?.id).slice().reverse(),
      lockEvents: db.lockEvents.filter(item => admin || item.userId === user?.id).slice(-12).reverse(),
      deviceEvents: db.deviceEvents.filter(item => admin || (user && db.loans.find(loan => loan.id === item.loanId)?.userId === user.id)).slice(-20).reverse(),
      users: admin ? db.users : [], maintenance: admin ? db.maintenance.slice().reverse() : [],
      damageReports: db.damageReports.filter(item => admin || item.userId === user?.id).slice().reverse().map(publicReport),
      canBorrow: !!user && user.score >= RULES.minimumScore && !activeLoan(user.id),
      urls, lan, simulation: { identity: true, locks: true, push: true, device: true },
      totals: { available: db.umbrellas.filter(item => item.status === 'available').length,
        borrowed: db.umbrellas.filter(item => item.status === 'borrowed').length,
        maintenance: db.umbrellas.filter(item => item.status === 'maintenance').length,
        lost: db.umbrellas.filter(item => item.status === 'lost').length,
        loans: admin ? db.loans.length : undefined }
    };
  }
  async function body(req, limit = 16384) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) fail('提交内容过长。', 413);
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { fail('请求内容不是有效的JSON。'); }
  }
  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/health') return json(res, 200, { ok: true, app: 'gezhi-umbrella-experiment' });
      if (url.pathname === '/api/qr' && req.method === 'GET') {
        const allowed = view({ headers: {} }).urls;
        const target = url.searchParams.get('url') || allowed[0];
        if (!allowed.includes(target)) fail('请选择当前演示地址。');
        const svg = await QRCode.toString(target, { type: 'svg', margin: 4, width: 240, errorCorrectionLevel: 'M' });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        return res.end(svg);
      }
      if (url.pathname === '/api/label' && req.method === 'GET') {
        const kind = url.searchParams.get('kind');
        const id = Number(url.searchParams.get('id'));
        if (!['umbrella', 'slot'].includes(kind) || !Number.isInteger(id) || !db.umbrellas.some(item => item.id === id)) fail('标识编号不正确。');
        const allowed = view({ headers: {} }).urls;
        const base = url.searchParams.get('url') || allowed[0];
        if (!allowed.includes(base)) fail('请选择当前演示地址。');
        const target = new URL(base);
        target.searchParams.set(kind, String(id));
        const qr = await QRCode.toString(target.toString(), { type: 'svg', margin: 2, width: 180, errorCorrectionLevel: 'M' });
        const inner = qr.replace('<svg ', '<svg x="120" y="180" ');
        const title = kind === 'umbrella' ? `${id}号爱心伞` : `${id}号归还仓位`;
        const detail = kind === 'umbrella' ? '扫码查看雨伞状态与归还位置' : '扫码确认仓位并自助归还';
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="540" viewBox="0 0 420 540"><rect width="420" height="540" rx="24" fill="#fff"/><rect x="10" y="10" width="400" height="520" rx="20" fill="none" stroke="#205b87" stroke-width="3"/><text x="210" y="68" text-anchor="middle" fill="#205b87" font-size="26" font-family="sans-serif" font-weight="bold">上海市格致中学</text><text x="210" y="115" text-anchor="middle" fill="#16354d" font-size="32" font-family="sans-serif" font-weight="bold">${title}</text><text x="210" y="150" text-anchor="middle" fill="#557085" font-size="16" font-family="sans-serif">校园公益 · 免费借还 · 无需押金</text>${inner}<text x="210" y="395" text-anchor="middle" fill="#16354d" font-size="18" font-family="sans-serif">${detail}</text><text x="210" y="430" text-anchor="middle" fill="#557085" font-size="15" font-family="sans-serif">雨伞 ${id} ↔ 仓位 ${id}</text><text x="210" y="470" text-anchor="middle" fill="#557085" font-size="14" font-family="sans-serif">晴雨之间 · 校园爱心伞实验</text></svg>`;
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(svg);
      }
      if (req.method === 'GET' && /^\/api\/damage\/photo\/[a-f0-9-]{36}$/.test(url.pathname)) {
        const actor = getActor(req);
        const report = db.damageReports.find(item => item.id === url.pathname.split('/').at(-1));
        if (!report || !report.photoFile || (actor.role !== 'admin' && actor.userId !== report.userId)) fail('照片不存在或无权查看。', 404);
        const extension = path.extname(report.photoFile).toLowerCase();
        if (!/^\/[a-f0-9-]{36}\.(jpg|png|webp)$/.test('/' + report.photoFile)) fail('照片文件不正确。', 500);
        res.writeHead(200, { 'Content-Type': extension === '.jpg' ? 'image/jpeg' : extension === '.png' ? 'image/png' : 'image/webp',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(fs.readFileSync(path.join(photoDir, report.photoFile)));
      }
      if (url.pathname.startsWith('/api/')) {
        applyRules();
        if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, view(req));
        if (req.method !== 'POST') fail('接口不存在。', 404);
        const input = await body(req, url.pathname === '/api/return' || url.pathname === '/api/damage/report' ? 2200000 : 16384);
        // Recheck time after reading the request body; a deadline may have passed while it arrived.
        applyRules();
        if (url.pathname === '/api/login') {
          const user = db.users.find(item => item.role === input.role && item.number === String(input.number || '').trim());
          const identityDetail = user?.role === 'student' ? String(input.className || '').trim() === user.className : String(input.phone || '').trim() === user?.phone;
          if (!user || String(input.name || '').trim() !== user.name || !identityDetail || input.pin !== '123456') fail('演示身份不匹配，请核对姓名、编号、班级或电话及口令。', 401);
          const token = crypto.randomBytes(24).toString('hex');
          sessions.set(token, { role: user.role, userId: user.id, expires: Date.now() + 24 * HOUR });
          return json(res, 200, { token, user });
        }
        if (url.pathname === '/api/admin/login') {
          if (input.pin !== '2026') fail('管理员演示口令不正确。', 401);
          const token = crypto.randomBytes(24).toString('hex');
          sessions.set(token, { role: 'admin', expires: Date.now() + 24 * HOUR });
          return json(res, 200, { token });
        }
        if (url.pathname === '/api/logout') {
          sessions.delete((req.headers.authorization || '').replace(/^Bearer /, ''));
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/borrow') {
          const user = getUser(req);
          if (user.score < RULES.minimumScore) fail('积分低于60分，借用权限暂时受限；归还雨伞后恢复。', 409);
          const existing = activeLoan(user.id);
          if (existing) {
            if (existing.status === 'pendingPickup' && existing.umbrellaId === Number(input.umbrellaId))
              return json(res, 200, { ok: true, loan: existing, pending: true, repeated: true,
                message: '仓位已开锁，请取走雨伞。' });
            fail('每人同时只能借一把伞，请先归还当前雨伞。', 409);
          }
          const umbrella = db.umbrellas.find(item => item.id === Number(input.umbrellaId));
          if (!umbrella || umbrella.status !== 'available') fail('这把雨伞当前不可借，请选择其他雨伞。', 409);
          if (umbrella.offline) fail('该仓位暂时离线，请选择其他雨伞。', 409);
          if (umbrella.failNextOpen) {
            umbrella.failNextOpen = false;
            recordDevice(null, 'lock-failed', now(), { umbrellaId: umbrella.id, slotId: umbrella.slotId });
            save(); fail('仓位开锁失败，未产生借用记录。', 409);
          }
          const at = now();
          const loan = { id: crypto.randomUUID(), userId: user.id, umbrellaId: umbrella.id, slotId: umbrella.slotId,
            status: 'pendingPickup', reservedAt: at, reservedUntil: at + RULES.pickupSeconds * 1000,
            borrowedAt: null, dueAt: null, returnedAt: null, reminded: [], penalizedDays: 0, returnOpenedAt: null };
          db.loans.push(loan);
          umbrella.status = 'pendingPickup';
          const event = lock(loan, 'borrow');
          recordDevice(loan, 'lock-opened', at, { slotId: loan.slotId });
          save();
          return json(res, 200, { ok: true, loan, lock: event, pending: true,
            message: `${umbrella.slotId}号仓位已模拟解锁；检测到取走后才会借伞成功。` });
        }
        if (url.pathname === '/api/demo/device') {
          const actor = getActor(req);
          const eventType = String(input.event || '');
          if (['fail-next-open', 'set-offline'].includes(eventType)) {
            if (actor.role !== 'admin') fail('只有管理员可以设置设备故障。', 403);
            const umbrella = db.umbrellas.find(item => item.slotId === Number(input.slotId));
            if (!umbrella) fail('仓位不存在。', 404);
            if (eventType === 'fail-next-open') umbrella.failNextOpen = true;
            else umbrella.offline = input.offline === true;
            recordDevice(null, eventType, now(), { umbrellaId: umbrella.id, slotId: umbrella.slotId });
            save(); return json(res, 200, { ok: true });
          }
          const loan = db.loans.find(item => item.id === input.loanId);
          if (!loan || (actor.role !== 'admin' && actor.userId !== loan.userId)) fail('借用单不存在或无权操作。', 404);
          if (eventType === 'pickup') {
            if (loan.status === 'borrowed') return json(res, 200, { ok: true, loan, repeated: true });
            if (loan.status !== 'pendingPickup') fail('当前借用单不能确认取伞。', 409);
            if (now() >= loan.reservedUntil) fail('取伞超时，请重新借用。', 409);
            const at = now();
            loan.status = 'borrowed'; loan.borrowedAt = at; loan.dueAt = at + RULES.borrowHours * HOUR;
            db.umbrellas.find(item => item.id === loan.umbrellaId).status = 'borrowed';
            recordDevice(loan, 'pickup', at, { slotId: loan.slotId });
            save(); return json(res, 200, { ok: true, loan, message: '已检测到雨伞取走，借用成功。' });
          }
          if (eventType === 'fault') {
            if (!['borrowed', 'returnPending'].includes(loan.status)) fail('当前借用单不能登记设备故障。', 409);
            loan.penaltyFrozenAt ||= now();
            recordDevice(loan, 'fault', now(), { slotId: loan.slotId });
            save(); return json(res, 200, { ok: true, message: '已登记设备异常，暂停新增逾期扣分。' });
          }
          if (eventType === 'return-confirm') {
            if (loan.status === 'returned') return json(res, 200, { ok: true, loan, repeated: true,
              user: db.users.find(item => item.id === loan.userId) });
            if (loan.status !== 'returnPending') fail('请先提交归还信息。', 409);
            const umbrella = db.umbrellas.find(item => item.id === loan.umbrellaId);
            if (umbrella.offline || Number(input.slotId) !== loan.slotId || Number(input.umbrellaId) !== loan.umbrellaId ||
                input.present !== true || input.locked !== true || Number(input.stableMs) < RULES.stableSeconds * 1000) {
              recordDevice(loan, 'return-rejected', now(), { slotId: Number(input.slotId) || null });
              save(); fail('仓位编号、在位检测或锁闭状态未通过，暂未完成归还。', 409);
            }
            // Only the administrator simulates an authenticated device event observed earlier.
            const observedAt = actor.role === 'admin' && Number.isFinite(Number(input.observedAt)) && input.observedAt != null
              ? Number(input.observedAt) : now();
            if (observedAt < loan.returnOpenedAt || observedAt > now()) fail('设备事件时间不可信。', 409);
            finalizeReturn(loan, observedAt);
            recordDevice(loan, 'return-confirm', observedAt, { slotId: loan.slotId, receivedAt: now() });
            save(); return json(res, 200, { ok: true, loan, user: db.users.find(item => item.id === loan.userId),
              message: loan.damaged ? '归还成功，雨伞已标记待维修。' : '归还成功，谢谢你把温暖传递下去。' });
          }
          fail('设备模拟事件不存在。', 400);
        }
        if (url.pathname === '/api/damage/report') {
          const user = getUser(req);
          const loan = db.loans.find(item => item.id === input.loanId && item.userId === user.id && ['borrowed', 'returnPending'].includes(item.status));
          if (!loan) fail('只能上报自己正在借用的雨伞。', 404);
          const report = saveDamage(loan, user, input.description, input.photoData, now());
          save();
          return json(res, 200, { ok: true, report: publicReport(report), message: '报修已记录。归还后这把伞会自动转入待维修。' });
        }
        if (url.pathname === '/api/return/open' || url.pathname === '/api/return') {
          const user = getUser(req);
          const loan = db.loans.find(item => item.id === input.loanId && item.userId === user.id);
          if (!loan) fail('没有找到属于你的待归还雨伞。', 404);
          if (url.pathname.endsWith('/open')) {
            if (!['borrowed', 'returnPending'].includes(loan.status)) fail('当前借用单不能打开归还仓位。', 409);
            if (db.umbrellas.find(item => item.id === loan.umbrellaId).offline) fail('该仓位暂时离线，请稍后重试或报障。', 409);
            loan.returnOpenedAt = now();
            const event = lock(loan, 'return');
            save();
            return json(res, 200, { ok: true, loan, lock: event });
          }
          if (loan.status === 'returned') return json(res, 200, { ok: true, pending: false, repeated: true,
            loan, user, message: '这把伞已经归还。' });
          if (!['borrowed', 'returnPending'].includes(loan.status)) fail('当前借用单不能归还。', 409);
          if (!loan.returnOpenedAt) fail('请先打开对应归还仓位。', 409);
          if (Number(input.umbrellaId) !== loan.umbrellaId || Number(input.slotId) !== loan.slotId) fail('雨伞编号与仓位不匹配，请放回对应编号仓位。', 409);
          if (input.confirmed !== true || typeof input.damaged !== 'boolean') fail('请确认雨伞已放入，并填写完好状态。');
          if (loan.returnIntent) {
            if (loan.returnIntent.damaged !== input.damaged) fail('归还信息已提交，不能更改报修状态。', 409);
            return json(res, 200, { ok: true, pending: true, repeated: true, loan,
              message: '归还信息已提交，正在等待仓位检测与锁闭。' });
          }
          const earlierReport = db.damageReports.find(item => item.loanId === loan.id);
          if (earlierReport && !input.damaged) fail('这把伞已有报修记录，请按损坏雨伞归还。', 409);
          if (!input.damaged && (input.damageNote || input.photoData)) fail('请先勾选报修，再填写损坏情况。');
          if (input.damaged && !earlierReport && !input.damageNote) fail('请说明雨伞哪里坏了。');
          if (input.damaged && (input.damageNote || input.photoData)) saveDamage(loan, user, input.damageNote || earlierReport?.description, input.photoData, now());
          loan.status = 'returnPending'; loan.returnIntent = { damaged: input.damaged, at: now() };
          save();
          return json(res, 200, { ok: true, pending: true, loan, message: '正在等待仓位检测与锁闭，尚未完成归还。' });
        }
        if (url.pathname === '/api/admin/umbrella') {
          getActor(req, true);
          const umbrella = db.umbrellas.find(item => item.id === Number(input.umbrellaId));
          if (!umbrella || !['available', 'maintenance', 'lost'].includes(input.status)) fail('雨伞或状态不正确。');
          if (umbrella.status === 'borrowed') fail('这把雨伞仍在借用中，不能直接修改库存状态。', 409);
          if (umbrella.status !== input.status) {
            umbrella.status = input.status;
            db.maintenance.push({ id: crypto.randomUUID(), at: now(), umbrellaId: umbrella.id, status: input.status, note: String(input.note || '管理员更新状态').slice(0, 120) });
            save();
          }
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/admin/loan/exception') {
          getActor(req, true);
          const loan = db.loans.find(item => item.id === input.loanId);
          if (!loan || !['borrowed', 'returnPending'].includes(loan.status)) fail('找不到需要处理的借用单。', 409);
          const note = String(input.note || '').trim();
          if (note.length < 2 || note.length > 300) fail('请填写2至300字的异常处理说明。');
          if (!['maintenance', 'lost'].includes(input.umbrellaStatus)) fail('请选择待维修或遗失。');
          loan.status = 'exception'; loan.closedAt = now(); loan.penaltyFrozenAt ||= now();
          loan.exceptionNote = note;
          db.umbrellas.find(item => item.id === loan.umbrellaId).status = input.umbrellaStatus;
          db.maintenance.push({ id: crypto.randomUUID(), at: now(), umbrellaId: loan.umbrellaId,
            status: input.umbrellaStatus, note });
          recordDevice(loan, 'exception-closed', now(), { note });
          save(); return json(res, 200, { ok: true, loan });
        }
        if (url.pathname === '/api/demo/advance') {
          getActor(req, true);
          const hours = Number(input.hours);
          if (!Number.isFinite(hours) || hours <= 0 || hours > 168) fail('每次可推进0到168小时之间的时间。');
          db.offsetMs += hours * HOUR;
          save();
          applyRules();
          return json(res, 200, { ok: true, now: now() });
        }
        if (url.pathname === '/api/demo/reset') {
          getActor(req, true);
          if (input.confirm !== 'RESET') fail('请确认重置实验。');
          const oldPhotos = db.damageReports.map(item => item.photoFile).filter(Boolean);
          db = seed();
          save();
          for (const filename of oldPhotos) fs.rmSync(path.join(photoDir, filename), { force: true });
          return json(res, 200, { ok: true });
        }
        fail('接口不存在。', 404);
      }
      const assets = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method !== 'GET' || !Object.hasOwn(assets, url.pathname)) fail('页面不存在。', 404);
      const [file, type] = assets[url.pathname];
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'", 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(path.join(__dirname, 'public', file)));
    } catch (error) {
      if (!error.status) console.error(error);
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '保存或处理失败，请查看启动窗口后重试。' });
      else res.end();
    }
  });
  const timer = setInterval(() => { try { applyRules(); } catch (error) { console.error('提醒检查失败：', error.message); } }, 1000);
  timer.unref();
  server.on('close', () => { clearInterval(timer); store.close(); });
  return server;
}

if (require.main === module) {
  const lan = process.argv.includes('--lan');
  const port = Number(process.env.UMBRELLA_PORT || 8766);
  const server = createDemoServer({ lan });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口${port}已被使用。若演示已经打开，可继续使用原窗口。` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(`校园爱心伞实验已启动：http://127.0.0.1:${port}/`);
    console.log('演示身份口令：123456；管理员口令：2026。关闭此窗口停止服务。');
    console.log(lan ? '已启用同一局域网手机演示。页面二维码处可选择本机网络地址。' : '当前仅本机访问。手机演示请使用“启动手机演示.cmd”。');
  });
}
module.exports = { createDemoServer };

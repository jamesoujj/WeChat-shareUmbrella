'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createDemoServer } = require('./server');

test('第二阶段：软件规则、设备模拟与 SQLite 持久化', async context => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'umbrella-phase2-'));
  const dataFile = path.join(temporary, 'state.sqlite');
  const photoData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/N3sAAAAASUVORK5CYII=';
  let server = createDemoServer({ dataFile });
  const listen = () => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise(resolve => server.close(resolve));
  await listen();
  let base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, input, token) {
    const response = await fetch(base + route, { method: input === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: response.status, data: await response.json() };
  }
  async function login(role, number, name) {
    const detail = role === 'teacher' ? { phone: '00000000000' } : { className: number === 'S2026002' ? '高二（2）班' : '高二（1）班' };
    const result = await request('/api/login', { role, number, name, ...detail, pin: '123456' });
    assert.equal(result.status, 200); return result.data.token;
  }
  let student, teacher, admin;
  const state = token => request('/api/state', undefined, token).then(result => { assert.equal(result.status, 200); return result.data; });
  const reset = async () => assert.equal((await request('/api/demo/reset', { confirm: 'RESET' }, admin)).status, 200);
  const advance = async hours => assert.equal((await request('/api/demo/advance', { hours }, admin)).status, 200);
  async function borrowAndPickup(umbrellaId, token) {
    const reserved = await request('/api/borrow', { umbrellaId }, token);
    assert.equal(reserved.status, 200); assert.equal(reserved.data.loan.status, 'pendingPickup');
    const picked = await request('/api/demo/device', { event: 'pickup', loanId: reserved.data.loan.id }, token);
    assert.equal(picked.status, 200); assert.equal(picked.data.loan.status, 'borrowed');
    return picked.data.loan;
  }
  async function returnIntent(loan, token, damaged = false, detail = {}) {
    assert.equal((await request('/api/return/open', { loanId: loan.id }, token)).status, 200);
    return request('/api/return', { loanId: loan.id, umbrellaId: loan.umbrellaId, slotId: loan.slotId,
      confirmed: true, damaged, ...detail }, token);
  }
  async function confirmReturn(loan, token, detail = {}) {
    return request('/api/demo/device', { event: 'return-confirm', loanId: loan.id,
      umbrellaId: loan.umbrellaId, slotId: loan.slotId, present: true, locked: true, stableMs: 3000, ...detail }, token);
  }
  try {
    await context.test('R01–R04：身份、开锁失败、竞借、待取伞超时', async () => {
      assert.equal((await request('/api/borrow', { umbrellaId: 1 })).status, 401);
      assert.equal((await request('/api/login', { role: 'student', number: 'S2026001', name: '错误姓名', pin: '123456' })).status, 401);
      student = await login('student', 'S2026001', '演示同学一');
      teacher = await login('teacher', 'T0001', '演示老师');
      admin = (await request('/api/admin/login', { pin: '2026' })).data.token;
      assert.equal((await request('/api/demo/device', { event: 'fail-next-open', slotId: 1 }, student)).status, 403);
      assert.equal((await request('/api/demo/device', { event: 'fail-next-open', slotId: 1 }, admin)).status, 200);
      assert.equal((await request('/api/borrow', { umbrellaId: 1 }, student)).status, 409);
      assert.equal((await state(admin)).loans.length, 0);
      const contenders = await Promise.all([request('/api/borrow', { umbrellaId: 1 }, student), request('/api/borrow', { umbrellaId: 1 }, teacher)]);
      assert.deepEqual(contenders.map(item => item.status).sort(), [200, 409]);
      const winner = contenders.findIndex(item => item.status === 200);
      const winnerToken = [student, teacher][winner];
      const pending = contenders[winner].data.loan;
      assert.equal(pending.borrowedAt, null);
      assert.equal((await request('/api/borrow', { umbrellaId: 1 }, winnerToken)).data.loan.id, pending.id);
      assert.equal((await request('/api/borrow', { umbrellaId: 2 }, winnerToken)).status, 409);
      await advance(1);
      const afterTimeout = await state(admin);
      assert.equal(afterTimeout.loans[0].status, 'cancelled');
      assert.equal(afterTimeout.umbrellas[0].status, 'available');
      assert.equal((await request('/api/demo/device', { event: 'pickup', loanId: pending.id }, winnerToken)).status, 409);
      await reset();
    });
    await context.test('R05、R10–R11：仅设备确认可归还，重复事件不重复加分', async () => {
      const loan = await borrowAndPickup(1, student);
      assert.equal(loan.dueAt - loan.borrowedAt, 48 * 3600000);
      assert.equal((await request('/api/demo/device', { event: 'pickup', loanId: loan.id }, student)).data.repeated, true);
      assert.equal((await request('/api/return/open', { loanId: loan.id }, teacher)).status, 404);
      assert.equal((await request('/api/return', { loanId: loan.id, umbrellaId: 1, slotId: 1, confirmed: true, damaged: false }, student)).status, 409);
      assert.equal((await request('/api/return/open', { loanId: loan.id }, student)).status, 200);
      assert.equal((await request('/api/return', { loanId: loan.id, umbrellaId: 1, slotId: 2, confirmed: true, damaged: false }, student)).status, 409);
      const intent = await request('/api/return', { loanId: loan.id, umbrellaId: 1, slotId: 1, confirmed: true, damaged: false }, student);
      assert.equal(intent.status, 200); assert.equal(intent.data.pending, true);
      assert.equal((await state(student)).user.score, 100);
      assert.equal((await confirmReturn(loan, student, { slotId: 2 })).status, 409);
      assert.equal((await confirmReturn(loan, student, { locked: false })).status, 409);
      assert.equal((await confirmReturn(loan, student, { stableMs: 2999 })).status, 409);
      assert.equal((await state(student)).loans[0].status, 'returnPending');
      assert.equal((await confirmReturn(loan, student)).status, 200);
      assert.equal((await confirmReturn(loan, student)).data.repeated, true);
      assert.equal((await state(student)).user.score, 102);
      assert.equal((await state(student)).scoreEvents.filter(item => item.reason === '按时归还奖励').length, 1);
      await reset();
    });
    await context.test('R06–R08、R14：48小时和整日扣分边界、三级提醒、归还恢复', async () => {
      const loan = await borrowAndPickup(1, student);
      await advance(24);
      assert.equal((await state(student)).reminders.length, 1);
      await advance(24);
      assert.equal((await state(student)).user.score, 100);
      await advance(23 + 59 / 60);
      assert.equal((await state(student)).user.score, 100);
      await advance(1 / 60);
      assert.equal((await state(student)).user.score, 90);
      assert.equal((await state(student)).reminders.length, 2);
      await advance(24);
      assert.equal((await state(student)).user.score, 80);
      await advance(24);
      assert.equal((await state(student)).user.score, 70);
      assert.equal((await state(student)).reminders.length, 3);
      await advance(48);
      assert.equal((await state(student)).user.score, 50);
      assert.equal((await request('/api/borrow', { umbrellaId: 2 }, student)).status, 409);
      assert.equal((await returnIntent(loan, student)).status, 200);
      assert.equal((await confirmReturn(loan, student)).status, 200);
      assert.equal((await state(student)).user.score, 70);
      assert.equal((await state(student)).canBorrow, true);
      assert.equal((await state(student)).reminders.length, 3);
      await reset();
    });
    await context.test('R12–R13、R17：报修照片隔离、待修停借', async () => {
      const loan = await borrowAndPickup(2, teacher);
      assert.equal((await request('/api/damage/report', { loanId: loan.id, description: '伞骨弯曲', photoData }, student)).status, 404);
      const report = await request('/api/damage/report', { loanId: loan.id, description: '伞骨弯曲，无法撑开', photoData }, teacher);
      assert.equal(report.status, 200);
      assert.equal((await state(teacher)).loans[0].status, 'borrowed');
      assert.equal((await state(student)).damageReports.length, 0);
      const photoUrl = base + '/api/damage/photo/' + report.data.report.id;
      assert.equal((await fetch(photoUrl)).status, 401);
      assert.equal((await fetch(photoUrl, { headers: { Authorization: 'Bearer ' + student } })).status, 404);
      assert.equal((await fetch(photoUrl, { headers: { Authorization: 'Bearer ' + teacher } })).status, 200);
      assert.equal((await fetch(photoUrl, { headers: { Authorization: 'Bearer ' + admin } })).status, 200);
      assert.equal((await returnIntent(loan, teacher, false)).status, 409);
      assert.equal((await returnIntent(loan, teacher, true)).status, 200);
      assert.equal((await state(teacher)).umbrellas[1].status, 'borrowed');
      assert.equal((await confirmReturn(loan, teacher)).status, 200);
      assert.equal((await state(teacher)).umbrellas[1].status, 'maintenance');
      assert.equal((await request('/api/borrow', { umbrellaId: 2 }, student)).status, 409);
      assert.equal((await request('/api/admin/umbrella', { umbrellaId: 2, status: 'available' }, admin)).status, 200);
      const second = await borrowAndPickup(2, student);
      assert.equal((await returnIntent(second, student, true, { damageNote: '伞面破损', photoData })).status, 200);
      assert.equal((await confirmReturn(second, student)).status, 200);
      assert.equal((await state(student)).umbrellas[1].status, 'maintenance');
      await reset();
    });
    await context.test('R05、R09：恰好到期仍算按时，积分不超过120', async () => {
      const exact = await borrowAndPickup(1, student);
      assert.equal((await returnIntent(exact, student)).status, 200);
      await advance(72);
      const atDeadline = await confirmReturn(exact, admin, { observedAt: exact.dueAt });
      assert.equal(atDeadline.status, 200);
      assert.equal(atDeadline.data.loan.onTime, true);
      assert.equal(atDeadline.data.loan.returnedAt, exact.dueAt);
      assert.equal((await state(student)).user.score, 102);
      assert.equal((await state(student)).reminders.length, 1);
      await reset();
      for (let index = 0; index < 11; index++) {
        const loan = await borrowAndPickup(1, student);
        assert.equal((await returnIntent(loan, student)).status, 200);
        assert.equal((await confirmReturn(loan, student)).status, 200);
      }
      assert.equal((await state(student)).user.score, 120);
      await reset();
    });
    await context.test('R15：SQLite 重启与补传实体事件按发生时间结算', async () => {
      const loan = await borrowAndPickup(3, student);
      assert.equal((await returnIntent(loan, student)).status, 200);
      const original = (await state(student)).loans.find(item => item.id === loan.id);
      await advance(168);
      assert.equal((await state(student)).user.score, 50);
      const returned = await confirmReturn(loan, admin, { observedAt: original.returnOpenedAt + 1000 });
      assert.equal(returned.status, 200);
      assert.equal(returned.data.loan.onTime, true);
      assert.equal((await state(student)).user.score, 102);
      assert.equal((await state(student)).reminders.length, 0);
      assert.equal((await state(admin)).reminders.filter(item => item.status === 'cancelled').length, 3);
      await close();
      server = createDemoServer({ dataFile }); await listen();
      base = `http://127.0.0.1:${server.address().port}`;
      assert.equal((await request('/api/state', undefined, student)).status, 401);
      student = await login('student', 'S2026001', '演示同学一');
      const snapshot = await state(student);
      assert.equal(snapshot.user.score, 102);
      assert.equal(snapshot.loans[0].status, 'returned');
      assert.equal(snapshot.deviceEvents[0].type, 'return-confirm');
      const sqlite = new DatabaseSync(dataFile);
      assert.equal(sqlite.prepare('SELECT count(*) AS n FROM loans').get().n, 1);
      assert.equal(sqlite.prepare('SELECT count(*) AS n FROM scoreEvents').get().n > 0, true);
      sqlite.close();
      admin = (await request('/api/admin/login', { pin: '2026' })).data.token;
      await reset();
    });
    await context.test('R16、R18：故障暂停新增扣分，管理员结案阻止无限逾期', async () => {
      const loan = await borrowAndPickup(4, student);
      assert.equal((await request('/api/demo/device', { event: 'fault', loanId: loan.id }, student)).status, 200);
      await advance(168);
      assert.equal((await state(student)).user.score, 100);
      assert.equal((await request('/api/admin/loan/exception', { loanId: loan.id, umbrellaStatus: 'lost', note: '实物盘点确认遗失' }, student)).status, 403);
      assert.equal((await request('/api/admin/loan/exception', { loanId: loan.id, umbrellaStatus: 'lost', note: '实物盘点确认遗失' }, admin)).status, 200);
      await advance(168);
      const snapshot = await state(student);
      assert.equal(snapshot.user.score, 100);
      assert.equal(snapshot.loans[0].status, 'exception');
      assert.equal(snapshot.umbrellas[3].status, 'lost');
      assert.equal(snapshot.canBorrow, true);
    });
    await context.test('二维码标识与服务文件访问边界', async () => {
      const qr = await fetch(base + '/api/qr');
      assert.equal(qr.status, 200); assert.match(await qr.text(), /<svg/);
      for (const kind of ['umbrella', 'slot']) {
        const label = await fetch(base + `/api/label?kind=${kind}&id=1`);
        assert.equal(label.status, 200);
        assert.match(await label.text(), /上海市格致中学/);
      }
      for (const route of ['/', '/app.js', '/style.css']) assert.equal((await fetch(base + route)).status, 200);
      for (const route of ['/server.js', '/lib/store.js', '/data/state.sqlite']) assert.equal((await fetch(base + route)).status, 404);
    });
  } finally {
    await close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

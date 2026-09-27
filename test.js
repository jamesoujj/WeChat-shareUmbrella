'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDemoServer } = require('./server');

test('校园爱心伞：完整实验流程与异常处理', async context => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'umbrella-check-'));
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.match(path.basename(temporary), /^umbrella-check-/);
  const dataFile = path.join(temporary, 'state.json');
  const photoData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/N3sAAAAASUVORK5CYII=';
  let server = createDemoServer({ dataFile });
  const listen = () => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise(resolve => server.close(resolve));
  await listen();
  let base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, input, token) {
    const response = await fetch(base + route, { method: input === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(input ? { 'Content-Type': 'application/json' } : {}) },
      body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: response.status, data: await response.json() };
  }
  async function login(role, number, name) {
    const detail = role === 'teacher' ? { phone: '00000000000' } : { className: number === 'S2026002' ? '高二（2）班' : '高二（1）班' };
    const result = await request('/api/login', { role, number, name, ...detail, pin: '123456' });
    assert.equal(result.status, 200); return result.data.token;
  }
  let student, teacher, admin, studentLoan;
  try {
    await context.test('访客不能借伞，身份和管理员权限得到校验', async () => {
      assert.equal((await request('/api/borrow', { umbrellaId: 1 })).status, 401);
      assert.equal((await request('/api/login', { role: 'student', number: 'S2026001', name: '错误姓名', pin: '123456' })).status, 401);
      assert.equal((await request('/api/login', { role: 'student', number: 'S2026001', name: '演示同学一', className: '错误班级', pin: '123456' })).status, 401);
      assert.equal((await request('/api/login', { role: 'teacher', number: 'T0001', name: '演示老师', phone: '错误号码', pin: '123456' })).status, 401);
      assert.equal((await request('/api/admin/login', { pin: 'wrong' })).status, 401);
      student = await login('student', 'S2026001', '演示同学一');
      teacher = await login('teacher', 'T0001', '演示老师');
      admin = (await request('/api/admin/login', { pin: '2026' })).data.token;
      assert.equal((await request('/api/demo/advance', { hours: 25 }, student)).status, 403);
      assert.deepEqual((await request('/api/state')).data.users, []);
    });
    await context.test('两人同时借同一把伞只允许一人成功，归还必须匹配编号', async () => {
      const results = await Promise.all([request('/api/borrow', { umbrellaId: 1 }, student), request('/api/borrow', { umbrellaId: 1 }, teacher)]);
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
      const winnerIndex = results.findIndex(result => result.status === 200);
      const token = [student, teacher][winnerIndex];
      const loan = results[winnerIndex].data.loan;
      assert.equal((await request('/api/borrow', { umbrellaId: 2 }, token)).status, 409);
      assert.equal((await request('/api/return', { loanId: loan.id, umbrellaId: 1, slotId: 1, confirmed: true, damaged: false }, token)).status, 409);
      assert.equal((await request('/api/return/open', { loanId: loan.id }, token)).status, 200);
      assert.equal((await request('/api/return', { loanId: loan.id, umbrellaId: 1, slotId: 2, confirmed: true, damaged: false }, token)).status, 409);
      assert.equal((await request('/api/return', { loanId: loan.id, umbrellaId: 1, slotId: 1, confirmed: false, damaged: false }, token)).status, 400);
      const returned = await request('/api/return', { loanId: loan.id, umbrellaId: 1, slotId: 1, confirmed: true, damaged: false }, token);
      assert.equal(returned.status, 200); assert.equal(returned.data.user.score, 105);
      assert.equal((await request('/api/return', { loanId: loan.id, umbrellaId: 1, slotId: 1, confirmed: true, damaged: false }, token)).status, 404);
      await request('/api/demo/reset', { confirm: 'RESET' }, admin);
    });
    await context.test('师生均可借用，个人记录隔离，不能归还别人的雨伞', async () => {
      studentLoan = (await request('/api/borrow', { umbrellaId: 1 }, student)).data.loan;
      const teacherLoan = (await request('/api/borrow', { umbrellaId: 2 }, teacher)).data.loan;
      assert.equal((await request('/api/return/open', { loanId: studentLoan.id }, teacher)).status, 404);
      const studentState = (await request('/api/state', undefined, student)).data;
      assert.equal(studentState.loans.length, 1); assert.equal(studentState.loans[0].umbrellaId, 1);
      assert.deepEqual(studentState.users, []);
      await request('/api/return/open', { loanId: teacherLoan.id }, teacher);
      const result = await request('/api/return', { loanId: teacherLoan.id, umbrellaId: 2, slotId: 2, confirmed: true, damaged: false }, teacher);
      assert.equal(result.data.user.score, 105);
    });
    await context.test('借用期间可自行拍照报修，仅本人和管理员能查看照片', async () => {
      assert.equal((await request('/api/damage/report', { loanId: studentLoan.id, description: '伞骨弯曲', photoData }, teacher)).status, 404);
      assert.equal((await request('/api/damage/report', { loanId: studentLoan.id, description: '', photoData }, student)).status, 400);
      assert.equal((await request('/api/damage/report', { loanId: studentLoan.id, description: '伞骨弯曲', photoData: 'data:image/png;base64,/9j/' }, student)).status, 400);
      const result = await request('/api/damage/report', { loanId: studentLoan.id, description: '伞骨弯曲，无法撑开', photoData }, student);
      assert.equal(result.status, 200); assert.equal(result.data.report.hasPhoto, true);
      const reportId = result.data.report.id;
      assert.equal((await request('/api/state', undefined, student)).data.damageReports.length, 1);
      assert.equal((await request('/api/state', undefined, teacher)).data.damageReports.length, 0);
      assert.equal((await request('/api/state', undefined, admin)).data.damageReports[0].description, '伞骨弯曲，无法撑开');
      const photoUrl = base + '/api/damage/photo/' + reportId;
      assert.equal((await fetch(photoUrl)).status, 401);
      assert.equal((await fetch(photoUrl, { headers: { Authorization: 'Bearer ' + teacher } })).status, 404);
      assert.equal((await fetch(photoUrl, { headers: { Authorization: 'Bearer ' + student } })).status, 200);
      assert.equal((await fetch(photoUrl, { headers: { Authorization: 'Bearer ' + admin } })).status, 200);
      assert.equal((await request('/api/return/open', { loanId: studentLoan.id }, student)).status, 200);
      assert.equal((await request('/api/return', { loanId: studentLoan.id, umbrellaId: 1, slotId: 1, confirmed: true, damaged: false }, student)).status, 409);
    });
    await context.test('三级提醒和扣分不重复，低分限制借用', async () => {
      for (const [hours, score, count] of [[168, 90, 1], [25, 80, 2], [48, 50, 3]]) {
        assert.equal((await request('/api/demo/advance', { hours }, admin)).status, 200);
        const snapshot = (await request('/api/state', undefined, student)).data;
        assert.equal(snapshot.user.score, score); assert.equal(snapshot.reminders.length, count);
        const repeated = (await request('/api/state', undefined, student)).data;
        assert.equal(repeated.user.score, score); assert.equal(repeated.reminders.length, count);
      }
      const denied = await request('/api/borrow', { umbrellaId: 2 }, student);
      assert.equal(denied.status, 409); assert.match(denied.data.error, /积分低于60/);
      assert.equal((await request('/api/demo/advance', { hours: -2 }, admin)).status, 400);
      const overdue = (await request('/api/state', undefined, admin)).data.loans.filter(item => item.overdue);
      assert.equal(overdue.length, 1);
    });
    await context.test('逾期还伞恢复权限，损坏转维修，管理员可恢复库存', async () => {
      const returned = await request('/api/return', { loanId: studentLoan.id, umbrellaId: 1, slotId: 1, confirmed: true, damaged: true }, student);
      assert.equal(returned.status, 200); assert.equal(returned.data.user.score, 60);
      const snapshot = (await request('/api/state', undefined, student)).data;
      assert.equal(snapshot.canBorrow, true); assert.equal(snapshot.umbrellas[0].status, 'maintenance');
      assert.equal((await request('/api/borrow', { umbrellaId: 1 }, student)).status, 409);
      assert.equal((await request('/api/admin/umbrella', { umbrellaId: 1, status: 'available' }, student)).status, 403);
      assert.equal((await request('/api/admin/umbrella', { umbrellaId: 1, status: 'available' }, admin)).status, 200);
      const newLoan = (await request('/api/borrow', { umbrellaId: 1 }, student)).data.loan;
      assert.ok(newLoan.id);
      assert.equal((await request('/api/admin/umbrella', { umbrellaId: 1, status: 'lost' }, admin)).status, 409);
      await request('/api/return/open', { loanId: newLoan.id }, student);
      const result = await request('/api/return', { loanId: newLoan.id, umbrellaId: 1, slotId: 1, confirmed: true, damaged: false }, student);
      assert.equal(result.data.user.score, 65);
      await request('/api/admin/umbrella', { umbrellaId: 3, status: 'lost' }, admin);
    });
    await context.test('还伞时也能直接填写损坏说明并拍照', async () => {
      const loan = (await request('/api/borrow', { umbrellaId: 4 }, teacher)).data.loan;
      await request('/api/return/open', { loanId: loan.id }, teacher);
      assert.equal((await request('/api/return', { loanId: loan.id, umbrellaId: 4, slotId: 4, confirmed: true, damaged: true }, teacher)).status, 400);
      const result = await request('/api/return', { loanId: loan.id, umbrellaId: 4, slotId: 4, confirmed: true, damaged: true, damageNote: '伞面破损', photoData }, teacher);
      assert.equal(result.status, 200);
      const snapshot = (await request('/api/state', undefined, admin)).data;
      assert.equal(snapshot.umbrellas[3].status, 'maintenance');
      assert.equal(snapshot.damageReports.find(item => item.loanId === loan.id).hasPhoto, true);
    });
    await context.test('生成真实二维码，页面可用，服务文件不能通过网页读取', async () => {
      const response = await fetch(base + '/api/qr');
      assert.equal(response.status, 200); assert.match(await response.text(), /<svg/);
      for (const kind of ['umbrella', 'slot']) {
        const label = await fetch(base + `/api/label?kind=${kind}&id=1`);
        assert.equal(label.status, 200);
        const svg = await label.text();
        assert.match(svg, /上海市格致中学/);
        assert.match(svg, /1号/);
        assert.match(svg, /<svg x="120" y="180"[^>]*viewBox=/);
      }
      assert.equal((await request('/api/label?kind=slot&id=99')).status, 400);
      assert.equal((await request('/api/qr?url=https://example.com')).status, 400);
      for (const route of ['/', '/app.js', '/style.css']) assert.equal((await fetch(base + route)).status, 200);
      for (const route of ['/server.js', '/constructor', '/toString', '/data/state.json']) assert.equal((await fetch(base + route)).status, 404);
    });
    await context.test('服务重启保留积分与记录，并使旧登录失效', async () => {
      await close(); server = createDemoServer({ dataFile }); await listen();
      base = `http://127.0.0.1:${server.address().port}`;
      assert.equal((await request('/api/state', undefined, student)).status, 401);
      student = await login('student', 'S2026001', '演示同学一');
      const snapshot = (await request('/api/state', undefined, student)).data;
      assert.equal(snapshot.user.score, 65); assert.equal(snapshot.reminders.length, 3);
      assert.equal(snapshot.loans.length, 2); assert.equal(snapshot.umbrellas[2].status, 'lost');
      assert.equal(snapshot.damageReports.length, 1);
    });
  } finally {
    await close(); fs.rmSync(temporary, { recursive: true, force: true });
  }
});

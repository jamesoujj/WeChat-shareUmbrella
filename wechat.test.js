'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDemoServer } = require('./server');
const { createWechatAdapter } = require('./lib/wechat');

test('第四阶段：微信身份绑定、一次性订阅与提醒状态（模拟微信接口）', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'umbrella-wechat-'));
  const sent = [];
  const adapter = {
    templateId: 'test-template',
    async exchangeCode(code) {
      if (!['student-code', 'student-again', 'teacher-code'].includes(code)) throw new Error('模拟微信登录失败');
      return { openid: code.startsWith('student') ? 'openid-student' : 'openid-teacher' };
    },
    async sendReminder(openid, reminder, loan) {
      sent.push({ openid, reminderId: reminder.id, loanId: loan.id });
      return { msgid: 'provider-1' };
    }
  };
  const roster = [
    { id: 's1', role: 'student', name: '测试学生', number: 'S1', className: '高二（1）班' },
    { id: 't1', role: 'teacher', name: '测试教师', number: 'T1', phone: '00000000000' }
  ];
  const server = createDemoServer({ dataFile: path.join(temporary, 'wechat.sqlite'),
    wechatAdapter: adapter, roster, adminPin: 'long-admin-pin-123', allowDemoControls: true,
    publicUrl: 'https://umbrella.example.org/' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, input, token) => {
    const response = await fetch(base + route, { method: input === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const guest = await request('/api/state');
    assert.equal(guest.data.authMode, 'wechat');
    assert.equal(guest.data.wechatTemplateId, 'test-template');
    assert.equal(guest.data.urls[0], 'https://umbrella.example.org/');
    assert.deepEqual(guest.data.demoUsers, []);
    assert.equal((await request('/api/login', { role: 'student', number: 'S1', pin: '123456' })).status, 403);
    assert.equal((await request('/api/admin/login', { pin: '2026' })).status, 401);
    const admin = (await request('/api/admin/login', { pin: 'long-admin-pin-123' })).data.token;
    assert.equal((await request('/api/admin/binding-code', { role: 'student', number: 'S1' })).status, 401);
    const issued = await request('/api/admin/binding-code', { role: 'student', number: 'S1' }, admin);
    assert.equal(issued.status, 200);
    assert.equal(issued.data.code.length, 32);
    assert.equal(JSON.stringify((await request('/api/state', undefined, admin)).data.users).includes(issued.data.code), false);
    const identity = { role: 'student', number: 'S1', name: '测试学生', className: '高二（1）班',
      bindingCode: issued.data.code, code: 'student-code' };
    assert.equal((await request('/api/wechat/bind', { ...identity, className: '错班' })).status, 401);
    const bound = await request('/api/wechat/bind', identity);
    assert.equal(bound.status, 200);
    assert.equal(bound.data.user.wechatBound, true);
    assert.equal(JSON.stringify(bound.data).includes('openid-student'), false);
    assert.equal((await request('/api/wechat/bind', identity)).status, 401);
    assert.equal((await request('/api/wechat/login', { code: 'teacher-code' })).status, 409);
    const student = (await request('/api/wechat/login', { code: 'student-again' })).data.token;
    assert.equal((await request('/api/admin/binding-code', { role: 'student', number: 'S1' }, admin)).status, 409);
    const reserve = await request('/api/borrow', { umbrellaId: 1 }, student);
    assert.equal(reserve.status, 200);
    const loanId = reserve.data.loan.id;
    assert.equal((await request('/api/wechat/subscription', { loanId, templateId: 'test-template', accepted: true }, student)).status, 409);
    assert.equal((await request('/api/demo/device', { event: 'pickup', loanId }, student)).status, 200);
    assert.equal((await request('/api/wechat/subscription', { loanId, templateId: 'test-template', accepted: false }, student)).status, 400);
    assert.equal((await request('/api/wechat/subscription', { loanId, templateId: 'test-template', accepted: true }, student)).data.remaining, 1);
    assert.equal((await request('/api/demo/advance', { hours: 24 }, admin)).status, 200);
    await server.processWeChatReminders();
    let snapshot = (await request('/api/state', undefined, admin)).data;
    assert.equal(sent.length, 1);
    assert.equal(snapshot.reminders[0].deliveryStatus, 'accepted');
    assert.equal(snapshot.reminders[0].providerMessageId, 'provider-1');
    assert.equal(snapshot.loans[0].subscriptionCredits, 0);
    await server.processWeChatReminders();
    assert.equal(sent.length, 1);
    assert.equal((await request('/api/demo/advance', { hours: 48 }, admin)).status, 200);
    await server.processWeChatReminders();
    snapshot = (await request('/api/state', undefined, admin)).data;
    assert.equal(snapshot.reminders[0].deliveryStatus, 'not_authorized');
    assert.equal(sent.length, 1);
    assert.equal((await request('/api/return/open', { loanId }, student)).status, 200);
    assert.equal((await request('/api/return', { loanId, umbrellaId: 1, slotId: 1, confirmed: true, damaged: false }, student)).status, 200);
    assert.equal((await request('/api/demo/device', { event: 'return-confirm', loanId, umbrellaId: 1, slotId: 1, present: true, locked: true, stableMs: 3000 }, student)).status, 200);
    assert.equal((await request('/api/demo/advance', { hours: 48 }, admin)).status, 200);
    await server.processWeChatReminders();
    assert.equal(sent.length, 1);
    adapter.sendReminder = async () => { throw new Error('模拟微信接口拒绝'); };
    const second = await request('/api/borrow', { umbrellaId: 2 }, student);
    assert.equal(second.status, 200);
    const secondId = second.data.loan.id;
    assert.equal((await request('/api/demo/device', { event: 'pickup', loanId: secondId }, student)).status, 200);
    assert.equal((await request('/api/wechat/subscription', { loanId: secondId, templateId: 'test-template', accepted: true }, student)).status, 200);
    assert.equal((await request('/api/demo/advance', { hours: 24 }, admin)).status, 200);
    await server.processWeChatReminders();
    snapshot = (await request('/api/state', undefined, admin)).data;
    assert.equal(snapshot.reminders[0].deliveryStatus, 'failed');
    assert.equal(snapshot.reminders[0].providerError, '模拟微信接口拒绝');
    await server.processWeChatReminders();
    assert.equal(snapshot.reminders.filter(item => item.deliveryStatus === 'failed').length, 1);
    assert.equal((await request('/api/admin/loan/exception', { loanId: secondId, umbrellaStatus: 'maintenance', note: '测试接口故障后人工结案' }, admin)).status, 200);
    adapter.sendReminder = async (openid, reminder, loan) => {
      sent.push({ openid, reminderId: reminder.id, loanId: loan.id, stage: reminder.stage });
      return { msgid: 'provider-backlog' };
    };
    const third = await request('/api/borrow', { umbrellaId: 3 }, student);
    assert.equal(third.status, 200);
    const thirdId = third.data.loan.id;
    assert.equal((await request('/api/demo/device', { event: 'pickup', loanId: thirdId }, student)).status, 200);
    for (let i = 0; i < 3; i++)
      assert.equal((await request('/api/wechat/subscription', { loanId: thirdId, templateId: 'test-template', accepted: true }, student)).status, 200);
    assert.equal((await request('/api/demo/advance', { hours: 120 }, admin)).status, 200);
    await server.processWeChatReminders();
    snapshot = (await request('/api/state', undefined, admin)).data;
    const latest = snapshot.reminders.filter(item => item.loanId === thirdId);
    assert.deepEqual(latest.map(item => item.deliveryStatus), ['accepted', 'superseded', 'superseded']);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].stage, '逾期3天');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('微信联调模式默认关闭时间快进和数据重置', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'umbrella-wechat-locked-'));
  const server = createDemoServer({ dataFile: path.join(temporary, 'wechat.sqlite'),
    wechatAdapter: { templateId: 'test', exchangeCode: async () => ({ openid: 'test' }), sendReminder: async () => ({}) },
    roster: [{ id: 's1', role: 'student', name: '测试学生', number: 'S1', className: '高二（1）班' }],
    adminPin: 'long-admin-pin-123' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: 'long-admin-pin-123' }) });
    const { token } = await login.json();
    const post = route => fetch(base + route, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(route.endsWith('advance') ? { hours: 24 } : { confirm: 'RESET' }) });
    assert.equal((await post('/api/demo/advance')).status, 403);
    assert.equal((await post('/api/demo/reset')).status, 403);
    const state = await fetch(base + '/api/state');
    assert.equal((await state.json()).demoControls, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('微信适配器只在服务端交换 code 并发送已配置的模板字段', async () => {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push({ url: String(url), body: options.body });
    const data = String(url).includes('jscode2session') ? { openid: 'wx-user' } :
      String(url).includes('/cgi-bin/token') ? { access_token: 'access', expires_in: 7200 } : { errcode: 0, msgid: 'message-1' };
    return { ok: true, json: async () => data };
  };
  const adapter = createWechatAdapter({ appId: 'test-app', appSecret: 'test-secret', templateId: 'template-1',
    templateData: { thing1: '{{umbrellaId}}号伞', thing2: '{{stage}}' }, fetchImpl });
  assert.deepEqual(await adapter.exchangeCode('one-time-code'), { openid: 'wx-user' });
  const response = await adapter.sendReminder('wx-user', { umbrellaId: 3, stage: '借出24小时', text: '请归还' }, { dueAt: Date.now() });
  assert.equal(response.msgid, 'message-1');
  assert.equal(seen.length, 3);
  const payload = JSON.parse(seen[2].body);
  assert.equal(payload.touser, 'wx-user');
  assert.deepEqual(payload.data.thing1, { value: '3号伞' });
  assert.equal(payload.template_id, 'template-1');
});

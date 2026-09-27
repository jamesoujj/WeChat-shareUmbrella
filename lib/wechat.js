'use strict';

function createWechatAdapter({ appId, appSecret, templateId, templateData, miniprogramState = 'formal', fetchImpl = fetch }) {
  if (!appId || !appSecret || !templateId || !templateData || typeof templateData !== 'object')
    throw new Error('微信接入需要 AppID、AppSecret、订阅模板 ID 和模板字段配置。');
  if (!['developer', 'trial', 'formal'].includes(miniprogramState)) throw new Error('小程序消息跳转版本不正确。');
  let accessToken = '';
  let tokenExpires = 0;
  async function request(url, options) {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`微信接口 HTTP ${response.status}`);
    const data = await response.json();
    if (data.errcode && data.errcode !== 0) throw Object.assign(new Error(`微信接口错误 ${data.errcode}`), { code: data.errcode });
    return data;
  }
  async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpires) return accessToken;
    const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
    url.search = new URLSearchParams({ grant_type: 'client_credential', appid: appId, secret: appSecret }).toString();
    const data = await request(url);
    if (!data.access_token) throw new Error('微信未返回 access_token。');
    accessToken = data.access_token;
    tokenExpires = Date.now() + Math.max(60, Number(data.expires_in || 7200) - 300) * 1000;
    return accessToken;
  }
  function values(reminder, loan) {
    const variables = {
      umbrellaId: String(reminder.umbrellaId),
      stage: reminder.stage,
      dueAt: new Date(loan.dueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
      message: reminder.text
    };
    return Object.fromEntries(Object.entries(templateData).map(([field, text]) => [field,
      { value: String(text).replace(/\{\{(umbrellaId|stage|dueAt|message)\}\}/g, (_, key) => variables[key]).slice(0, 100) }]));
  }
  return {
    templateId,
    async exchangeCode(code) {
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
      url.search = new URLSearchParams({ appid: appId, secret: appSecret, js_code: code, grant_type: 'authorization_code' }).toString();
      const data = await request(url);
      if (!data.openid) throw new Error('微信未返回 OpenID。');
      return { openid: data.openid };
    },
    async sendReminder(openid, reminder, loan) {
      const payload = { touser: openid, template_id: templateId, page: 'pages/index/index',
        data: values(reminder, loan), miniprogram_state: miniprogramState };
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await getAccessToken();
        const url = new URL('https://api.weixin.qq.com/cgi-bin/message/subscribe/send');
        url.searchParams.set('access_token', token);
        try { return await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
        catch (error) {
          if (attempt === 0 && [40001, 42001].includes(error.code)) { accessToken = ''; continue; }
          throw error;
        }
      }
    }
  };
}

module.exports = { createWechatAdapter };

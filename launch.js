'use strict';
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const url = 'http://127.0.0.1:8766/';
const lan = process.argv.includes('--lan');
function openBrowser() { spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref(); }
function health() {
  return new Promise(resolve => {
    const req = http.get(url + 'api/health', { timeout: 600 }, response => {
      let text = ''; response.on('data', part => { text += part; });
      response.on('end', () => { try { resolve(JSON.parse(text).app === 'gezhi-umbrella-experiment'); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
(async () => {
  if (await health()) {
    if (lan) console.log('已有演示服务正在运行。要切换手机模式，请先关闭原启动窗口，再打开本文件。');
    openBrowser(); return;
  }
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js'), ...(lan ? ['--lan'] : [])], { stdio: 'inherit' });
  let opened = false;
  const timer = setInterval(async () => { if (!opened && await health()) { opened = true; clearInterval(timer); openBrowser(); } }, 400);
  child.on('exit', code => { clearInterval(timer); process.exitCode = code || 0; });
  child.on('error', error => { clearInterval(timer); console.error(error.message); process.exitCode = 1; });
})();

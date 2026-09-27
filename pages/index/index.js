const accounts = [
  { role: 'student', number: 'S2026001', name: '演示同学一', className: '高二（1）班' },
  { role: 'student', number: 'S2026002', name: '演示同学二', className: '高二（2）班' },
  { role: 'teacher', number: 'T0001', name: '演示老师', phone: '00000000000' }
];
const statuses = { available: '可借用', pendingPickup: '待取伞', borrowed: '已借出', maintenance: '待维修', lost: '已登记遗失', retired: '已报废' };
const stamp = value => {
  if (!value) return '待确认';
  const date = new Date(value); const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
Page({
  data: { tab: 'cabinet', account: accounts[0], pin: '123456', accountIndex: 0, state: null, busy: false, currentLoan: null, connected: false, error: '', adminPin: '2026', adminReady: false, scanResult: '', adminNote: '', faultNote: '',
    damageMode: '', damageNote: '', damagePhotoPath: '', damageFlag: false, returnConfirmed: false },
  onLoad() { this.refresh(); },
  onShow() { this.timer = setInterval(() => { if (!this.data.busy) this.refresh(); }, 5000); },
  onHide() { clearInterval(this.timer); },
  onUnload() { clearInterval(this.timer); },
  request(route, input, admin = false) {
    return new Promise((resolve, reject) => {
      const token = wx.getStorageSync(admin ? 'umbrella-admin' : 'umbrella-user');
      wx.request({ url: getApp().globalData.baseUrl + route, method: input === undefined ? 'GET' : 'POST', data: input,
        header: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        success: response => {
          if (response.statusCode >= 200 && response.statusCode < 300) return resolve(response.data);
          if (response.statusCode === 401) { wx.removeStorageSync(admin ? 'umbrella-admin' : 'umbrella-user'); if (admin) this.setData({ adminReady: false }); }
          reject(new Error(response.data.error || '请求失败'));
        }, fail: () => reject(new Error('无法连接实验服务，请检查电脑启动窗口、baseUrl和开发工具的本地调试设置。')) });
    });
  },
  async run(action) {
    if (this.data.busy) return; this.setData({ busy: true, error: '' });
    try { await action(); } catch (error) { this.setData({ error: error.message }); wx.showToast({ title: error.message, icon: 'none', duration: 3000 }); }
    finally { this.setData({ busy: false }); }
  },
  async refresh() {
    try {
      const admin = this.data.tab === 'admin' && !!wx.getStorageSync('umbrella-admin');
      const state = await this.request('/api/state', undefined, admin);
      state.umbrellas = state.umbrellas.map(item => ({ ...item, statusText: statuses[item.status] }));
      state.loans = state.loans.map(item => ({ ...item, borrowedText: stamp(item.borrowedAt), dueText: stamp(item.dueAt), returnedText: item.returnedAt ? stamp(item.returnedAt) : '', statusText: item.status === 'pendingPickup' ? '待取伞' : item.status === 'cancelled' ? '取伞超时取消' : item.status === 'exception' ? '异常已结案' : item.status === 'returnPending' ? '归还待检测' : item.returnedAt ? '已归还' : item.overdue ? '逾期未还' : '借用中' }));
      state.reminders = state.reminders.map(item => ({ ...item, timeText: stamp(item.at) }));
      state.damageReports = state.damageReports.map(item => ({ ...item, timeText: stamp(item.updatedAt), statusText: item.returned ? '已归还，待维修' : '借用中，已报修' }));
      this.setData({ state, connected: true, currentLoan: state.loans.find(item => ['pendingPickup', 'borrowed', 'returnPending'].includes(item.status)) || null, nowText: stamp(state.now), overdue: state.loans.filter(item => item.overdue), adminReady: !!wx.getStorageSync('umbrella-admin') });
    } catch (error) { this.setData({ error: error.message, connected: false }); }
  },
  selectAccount(event) { const index = Number(event.currentTarget.dataset.index); this.setData({ accountIndex: index, account: { ...accounts[index] } }); },
  scanLabel() {
    this.run(async () => {
      const result = await new Promise((resolve, reject) => wx.scanCode({ onlyFromCamera: false, success: resolve, fail: reject }));
      const match = /[?&](umbrella|slot)=(\d+)(?:&|$)/.exec(result.result || '');
      if (!match) throw new Error('这不是本实验的雨伞或仓位二维码。');
      const kind = match[1]; const id = Number(match[2]);
      const asset = await this.request(`/api/asset?kind=${kind}&id=${id}`);
      const umbrella = asset.umbrella;
      this.setData({ tab: 'cabinet', scanResult: `${asset.cabinet.school} · ${asset.cabinet.id} · ${asset.cabinet.location}\n${umbrella.id}号伞 / ${umbrella.slotId}号仓位 · ${statuses[umbrella.status]}${umbrella.current ? '' : '（旧伞，仅供查阅）'}` });
      if (kind === 'slot' && this.data.currentLoan && this.data.currentLoan.slotId === id && this.data.currentLoan.umbrellaId === umbrella.id) wx.showToast({ title: '编号匹配，请点击归还这把伞', icon: 'none' });
    });
  },
  input(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }); },
  login() { this.run(async () => { const result = await this.request('/api/login', { ...this.data.account, pin: this.data.pin }); wx.setStorageSync('umbrella-user', result.token); await this.refresh(); }); },
  logout() { this.run(async () => { await this.request('/api/logout', {}); wx.removeStorageSync('umbrella-user'); await this.refresh(); }); },
  changeTab(event) { this.setData({ tab: event.currentTarget.dataset.tab }); this.refresh(); },
  borrow(event) { this.run(async () => {
    const result = await this.request('/api/borrow', { umbrellaId: Number(event.currentTarget.dataset.id) });
    await this.refresh(); wx.showModal({ title: `${result.loan.slotId}号仓位已模拟解锁`, content: `请取走${result.loan.umbrellaId}号伞；检测到取走后开始48小时借期。`, showCancel: false });
  }); },
  confirmPickup() { this.run(async () => {
    const loan = this.data.currentLoan;
    if (!loan || loan.status !== 'pendingPickup') throw new Error('没有待取走的雨伞。');
    const result = await this.request('/api/demo/device', { event: 'pickup', loanId: loan.id });
    await this.refresh(); wx.showToast({ title: `借伞成功，请在${stamp(result.loan.dueAt)}前归还`, icon: 'none' });
  }); },
  beginDamage(mode) { this.run(async () => {
    const loan = this.data.currentLoan;
    if (!loan) throw new Error('请先借用雨伞。');
    if (mode === 'return') await this.request('/api/return/open', { loanId: loan.id });
    const report = this.data.state.damageReports.find(item => item.loanId === loan.id);
    this.photoData = '';
    this.setData({ damageMode: mode, damageNote: report ? report.description : '', damageFlag: !!report,
      damagePhotoPath: '', returnConfirmed: false });
  }); },
  startReturn() { this.beginDamage('return'); },
  startReport() { this.beginDamage('report'); },
  reportFault() { this.run(async () => {
    const loan = this.data.currentLoan;
    if (!loan || !['borrowed', 'returnPending'].includes(loan.status)) throw new Error('当前没有可登记故障的借用单。');
    const note = this.data.faultNote.trim();
    if (note.length < 2) throw new Error('请填写仓位故障说明。');
    const result = await this.request('/api/demo/device', { event: 'fault', loanId: loan.id, note });
    this.setData({ faultNote: '' }); await this.refresh(); wx.showToast({ title: result.message, icon: 'none' });
  }); },
  cancelDamage() { this.photoData = ''; this.setData({ damageMode: '', damagePhotoPath: '' }); },
  toggleDamage(event) {
    const report = this.data.state.damageReports.find(item => item.loanId === this.data.currentLoan?.id);
    if (report && !event.detail.value) return wx.showToast({ title: '已报修的雨伞请按损坏状态归还', icon: 'none' });
    this.setData({ damageFlag: !!event.detail.value });
  },
  toggleConfirmed(event) { this.setData({ returnConfirmed: !!event.detail.value }); },
  chooseDamagePhoto() { this.run(async () => {
    const result = await new Promise((resolve, reject) => wx.chooseImage({ count: 1, sizeType: ['compressed'], sourceType: ['camera', 'album'], success: resolve, fail: reject }));
    let file = result.tempFiles[0];
    if (file.size > 1500000) {
      const compressed = await new Promise((resolve, reject) => wx.compressImage({ src: file.path, quality: 55, compressedWidth: 1200, success: resolve, fail: reject }));
      const info = await new Promise((resolve, reject) => wx.getFileInfo({ filePath: compressed.tempFilePath, success: resolve, fail: reject }));
      file = { path: compressed.tempFilePath, size: info.size };
    }
    if (file.size > 1500000) throw new Error('照片仍大于1.5MB，请换一张照片。');
    const data = await new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath: file.path, encoding: 'base64', success: item => resolve(item.data), fail: reject }));
    const type = data.startsWith('/9j/') ? 'jpeg' : data.startsWith('iVBORw0KGgo') ? 'png' : data.startsWith('UklGR') ? 'webp' : '';
    if (!type) throw new Error('请选择JPG、PNG或WEBP照片。');
    this.photoData = `data:image/${type};base64,${data}`;
    this.setData({ damagePhotoPath: file.path });
  }); },
  submitDamage() { this.run(async () => {
    const loan = this.data.currentLoan;
    if (!loan) throw new Error('当前没有借用中的雨伞。');
    const report = this.data.state.damageReports.find(item => item.loanId === loan.id);
    const damaged = this.data.damageMode === 'report' || this.data.damageFlag || !!report;
    if (damaged && this.data.damageNote.trim().length < 2) throw new Error('请说明雨伞哪里坏了。');
    if (this.data.damageMode === 'return' && !this.data.returnConfirmed) throw new Error('请确认雨伞已放入对应仓位。');
    let result = this.data.damageMode === 'report'
      ? await this.request('/api/damage/report', { loanId: loan.id, description: this.data.damageNote, photoData: this.photoData || '' })
      : await this.request('/api/return', { loanId: loan.id, umbrellaId: loan.umbrellaId, slotId: loan.slotId,
        confirmed: true, damaged, damageNote: damaged ? this.data.damageNote : '', photoData: damaged ? this.photoData || '' : '' });
    if (this.data.damageMode === 'return') result = await this.request('/api/demo/device', { event: 'return-confirm', loanId: loan.id,
      umbrellaId: loan.umbrellaId, slotId: loan.slotId, present: true, locked: true, stableMs: 3000 });
    this.cancelDamage(); await this.refresh(); wx.showToast({ title: result.message, icon: 'none' });
  }); },
  previewReport(event) { this.run(async () => {
    const id = event.currentTarget.dataset.id;
    const token = wx.getStorageSync(this.data.tab === 'admin' ? 'umbrella-admin' : 'umbrella-user');
    const result = await new Promise((resolve, reject) => wx.downloadFile({ url: getApp().globalData.baseUrl + '/api/damage/photo/' + id,
      header: { Authorization: 'Bearer ' + token }, success: resolve, fail: reject }));
    if (result.statusCode !== 200) throw new Error('照片读取失败。');
    wx.previewImage({ urls: [result.tempFilePath] });
  }); },
  adminLogin() { this.run(async () => { const result = await this.request('/api/admin/login', { pin: this.data.adminPin }); wx.setStorageSync('umbrella-admin', result.token); this.setData({ adminReady: true }); await this.refresh(); }); },
  advance(event) { this.run(async () => { await this.request('/api/demo/advance', { hours: Number(event.currentTarget.dataset.hours) }, true); await this.refresh(); wx.showToast({ title: '实验时间已推进', icon: 'none' }); }); },
  changeStatus(event) { this.run(async () => {
    const note = this.data.adminNote.trim();
    if (note.length < 2) throw new Error('请先填写2至300字的维修或盘点说明。');
    const item = this.data.state.umbrellas.find(asset => asset.id === Number(event.currentTarget.dataset.id));
    const choices = { available: [['maintenance','标记待维修'],['lost','登记遗失']], maintenance: [['available','恢复可借'],['retired','报废']], lost: [['available','盘点后恢复'],['retired','报废']], retired: [] }[item.status] || [];
    if (!choices.length) throw new Error('当前状态不能直接调整。');
    const index = await new Promise(resolve => wx.showActionSheet({ itemList: choices.map(choice => choice[1]), success: result => resolve(result.tapIndex), fail: () => resolve(-1) }));
    if (index < 0) return;
    await this.request('/api/admin/umbrella', { umbrellaId: item.id, status: choices[index][0], note }, true); this.setData({ adminNote: '' }); await this.refresh();
  }); },
  replenish(event) { this.run(async () => {
    const note = this.data.adminNote.trim();
    if (note.length < 2) throw new Error('请先填写补货说明。');
    const result = await this.request('/api/admin/umbrella/replenish', { slotId: Number(event.currentTarget.dataset.slot), note }, true);
    this.setData({ adminNote: '' }); await this.refresh(); wx.showModal({ title: '补货完成', content: result.message, showCancel: false });
  }); },
  closeException(event) { this.run(async () => {
    const note = this.data.adminNote.trim();
    if (note.length < 2) throw new Error('请先填写异常核查说明。');
    const index = await new Promise(resolve => wx.showActionSheet({ itemList: ['核实后转待维修','核实后登记遗失'], success: result => resolve(result.tapIndex), fail: () => resolve(-1) }));
    if (index < 0) return;
    await this.request('/api/admin/loan/exception', { loanId: event.currentTarget.dataset.id, umbrellaStatus: ['maintenance','lost'][index], note }, true);
    this.setData({ adminNote: '' }); await this.refresh();
  }); },
  reset() { this.run(async () => {
    const ok = await new Promise(resolve => wx.showModal({ title: '重置实验？', content: '将清空本原型的借还、积分和提醒记录。', success: result => resolve(result.confirm), fail: () => resolve(false) }));
    if (ok) { await this.request('/api/demo/reset', { confirm: 'RESET' }, true); await this.refresh(); }
  }); }
});

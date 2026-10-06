const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function app() {
    const storage = new Map();
    const elements = new Map();
    const timers = new Map();
    const alerts = [];
    let timerId = 0;
    const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    function element(id = '') {
        if (elements.has(id)) return elements.get(id);
        const classes = new Set(id === 'setup-screen' ? ['active'] : []);
        const el = {
            style: {}, value: '', scrollTop: 0, offsetWidth: 100, files: [], tagName: 'DIV',
            classList: { add(...xs) { xs.forEach(x => classes.add(x)); }, remove(...xs) { xs.forEach(x => classes.delete(x)); }, contains(x) { return classes.has(x); }, toggle(x, yes) { if (yes) classes.add(x); else classes.delete(x); } },
            addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
            appendChild() {}, removeChild() {}, focus() {}, select() {}, click() {}, setAttribute() {}, getAttribute() { return ''; },
            getBoundingClientRect() { return { top: 0, height: 44 }; }
        };
        let text = '', markup = '';
        Object.defineProperties(el, {
            innerText: { get() { return text; }, set(v) { text = String(v); markup = escape(v); } },
            textContent: { get() { return text; }, set(v) { text = String(v); markup = escape(v); } },
            innerHTML: { get() { return markup; }, set(v) { markup = String(v); } }
        });
        elements.set(id, el);
        return el;
    }
    let failKey = null;
    const context = vm.createContext({
        document: { title: 'timing计时器', hidden: false, visibilityState: 'visible', getElementById: element, querySelector: element, createElement: (tag) => element('new-' + tag + '-' + (++timerId)), addEventListener() {}, body: element('body'), documentElement: element('html') },
        window: { addEventListener() {} }, navigator: {}, location: { protocol: 'file:', hostname: '', reload() {} },
        localStorage: { getItem: k => storage.has(k) ? storage.get(k) : null, setItem(k, v) { if (k === failKey) { failKey = null; throw new Error('quota'); } storage.set(k, String(v)); }, removeItem: k => storage.delete(k) },
        performance: { now: () => 1000 },
        setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
        setInterval(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearInterval: id => timers.delete(id),
        requestAnimationFrame() { return ++timerId; }, cancelAnimationFrame() {},
        Image: class { constructor() { this.complete = true; this.naturalWidth = 100; } addEventListener() {} decode() { return Promise.resolve(); } },
        AbortController, Blob, URL, FileReader: class {},
        fetch: async () => ({ ok: true }), confirm: () => true, alert: message => alerts.push(message),
        console: { log() {}, warn() {}, error() {} }
    });
    vm.runInContext(script, context, { filename: 'index.html' });
    return { context, storage, elements, alerts, run: code => vm.runInContext(code, context), set: (k, v) => storage.set(k, JSON.stringify(v)), get: k => JSON.parse(storage.get(k)), failNext: key => { failKey = key; } };
}

function record(id = 1, task = '背单词') {
    return { id, task, startTime: '2026/10/5 21:00:00', duration: '0小时25分0秒', note: '' };
}

function attachBackup(a, existing, permission = true) {
    const env = { data: existing, permission, writes: 0 };
    a.context.backupTestHandle = {
        name: 'backup.json', queryPermission: async () => env.permission ? 'granted' : 'prompt', requestPermission: async () => env.permission ? 'granted' : 'denied',
        getFile: async () => ({ text: async () => typeof env.data === 'string' ? env.data : JSON.stringify(env.data) }),
        createWritable: async () => { let staged; return { write: async data => { staged = JSON.parse(data); }, close: async () => { env.data = staged; env.writes++; } }; }
    };
    a.run('backupFileHandle = backupTestHandle');
    return env;
}

test('删除时未获授权，再备份也不能复活记录', async () => {
    const a = app();
    a.set('immersiveHistory', [record()]);
    const file = attachBackup(a, { history: [record()], stats: {} }, false);
    a.run('deleteHistoryItem(0)');
    await a.run('writeBackupFile({})');
    file.permission = true;
    assert.equal(await a.run('writeBackupFile({requestPermission:true})'), true);
    assert.equal(file.data.history.length, 0);
});

test('损坏 JSON 或读取异常时不覆盖备份文件', async () => {
    const a = app();
    a.set('immersiveHistory', [record()]);
    const file = attachBackup(a, '{broken JSON');
    assert.equal(await a.run('writeBackupFile({})'), false);
    assert.equal(file.writes, 0);
    a.context.backupTestHandle.getFile = async () => { throw new Error('read failure'); };
    assert.equal(await a.run('writeBackupFile({})'), false);
    assert.equal(file.writes, 0);
});

test('备份操作串行，较早写入不能覆盖较新记录', async () => {
    const a = app();
    a.set('immersiveHistory', [record(1, 'A')]);
    const file = attachBackup(a, { history: [], stats: {} });
    let releaseFirst, firstEntered;
    const gate = new Promise(r => { releaseFirst = r; });
    const entered = new Promise(r => { firstEntered = r; });
    let opened = 0, active = 0, maxActive = 0;
    a.context.backupTestHandle.createWritable = async () => {
        const n = ++opened; active++; maxActive = Math.max(maxActive, active); let staged;
        return { write: async data => { staged = JSON.parse(data); if (n === 1) firstEntered(); }, close: async () => { if (n === 1) await gate; file.data = staged; active--; } };
    };
    const first = a.run('writeBackupFile({})');
    await entered;
    a.set('immersiveHistory', [record(2, 'B'), record(1, 'A')]);
    const second = a.run('writeBackupFile({})');
    await new Promise(r => setImmediate(r));
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(maxActive, 1);
    assert.deepEqual(file.data.history.map(r => r.task), ['B', 'A']);
});

test('坏记录和数组 stats 不通过导入校验', () => {
    const a = app();
    assert.equal(a.run('typeof validateBackupPayload'), 'function');
    for (const input of [{ history: [null], stats: {} }, { history: [record()], stats: [] }, { history: [{ ...record(), duration: 'junk' }], stats: {} }]) {
        a.context.input = input;
        assert.throws(() => a.run('validateBackupPayload(input)'));
    }
});

test('预览默认合并，取消时不改变本机记录', () => {
    const a = app();
    a.set('immersiveHistory', [record(1, '本机')]);
    a.context.input = { history: [record(2, '备份')], stats: {} };
    a.run('openImportPreview(input)');
    assert.equal(a.elements.get('import-mode').value, 'merge');
    assert.equal(a.elements.get('import-conflict').value, 'local');
    assert.equal(a.get('immersiveHistory').length, 1);
    assert.match(a.elements.get('import-preview-summary').textContent, /新增 1 条/);
    a.run('closeImportPreview()');
    assert.equal(a.get('immersiveHistory')[0].task, '本机');
});

test('合并预览区分新增、重复和冲突，默认保留本机', () => {
    const a = app();
    a.set('immersiveHistory', [record(1, '原任务'), record(2, '重复')]);
    a.context.input = { history: [record(1, '已修改'), record(2, '重复'), record(3, '新增')], stats: { 新增: 2 } };
    const result = a.run('prepareImport(input)');
    assert.equal(result.added, 1);
    assert.equal(result.duplicates, 1);
    assert.equal(result.conflicts, 1);
    assert.equal(result.history.find(r => r.id === 1).task, '原任务');
    assert.equal(a.run('prepareImport(input,"merge","file").history.find(r=>r.id===1).task'), '已修改');
    a.run('openImportPreview(input); applyImportPreview()');
    assert.equal(a.get('immersiveHistory').length, 3);
    assert.equal(a.get('immersiveHistory').find(r => r.id === 1).task, '原任务');
    assert.equal(a.get('taskHistory').新增, 2);
});

test('覆盖模式仅在确认导入后替换记录', () => {
    const a = app();
    a.set('immersiveHistory', [record(1)]);
    a.context.input = { history: [record(2, '替换')], stats: {} };
    a.run('openImportPreview(input)');
    a.elements.get('import-mode').value = 'replace';
    a.run('renderImportPreview()');
    assert.equal(a.get('immersiveHistory')[0].id, 1);
    a.context.confirm = () => false;
    assert.equal(a.run('applyImportPreview()'), false);
    assert.equal(a.get('immersiveHistory')[0].id, 1);
    a.context.confirm = () => true;
    assert.equal(a.run('applyImportPreview()'), true);
    assert.equal(a.get('immersiveHistory')[0].id, 2);
});

test('确认导入时重新读取本机数据，预览期间的新增不会丢失', () => {
    const a = app();
    a.set('immersiveHistory', [record(1)]);
    a.context.input = { history: [record(2)], stats: {} };
    a.run('openImportPreview(input)');
    a.set('immersiveHistory', [record(3), record(1)]);
    a.run('applyImportPreview()');
    assert.equal(a.get('immersiveHistory').length, 3);
});

test('导入写入第二个或第三个键失败，恢复原数据并保留预览', () => {
    for (const failedKey of ['taskHistory', 'timing_recordStates']) {
        const a = app();
        a.set('immersiveHistory', [record(1, '原记录')]);
        a.set('taskHistory', { 原记录: 1 });
        a.set('timing_recordStates', {});
        a.context.input = { history: [record(2)], stats: {} };
        a.run('openImportPreview(input)');
        a.failNext(failedKey);
        assert.equal(a.run('applyImportPreview()'), false);
        assert.deepEqual(a.get('immersiveHistory'), [record(1, '原记录')]);
        assert.deepEqual(a.get('taskHistory'), { 原记录: 1 });
        assert.equal(a.elements.get('import-modal').classList.contains('active'), true);
    }
});

test('连续删除可逐条撤销，并恢复原有时间、时长和备注', async () => {
    const a = app();
    const original = [{ ...record(2, '二'), note: '备注', startedAt: new Date(2026, 9, 5, 21).getTime() }, record(1, '一')];
    a.set('immersiveHistory', original);
    const file = attachBackup(a, { history: original, stats: {} });
    a.run('deleteHistoryItem(0); deleteHistoryItem(0)');
    assert.equal(a.get('immersiveHistory').length, 0);
    assert.equal(a.elements.get('history-undo-bar').style.display, 'flex');
    await a.run('writeBackupFile({})');
    assert.equal(file.data.history.length, 0);
    a.run('undoHistoryDelete(); undoHistoryDelete()');
    assert.deepEqual(a.get('immersiveHistory'), original);
    await a.run('writeBackupFile({})');
    assert.equal(file.data.history.length, 2);
    assert.equal(file.data.recordStates['2'].deleted, false);
    assert.equal(a.elements.get('history-undo-bar').style.display, 'none');
});

test('关闭自动备份后删除，之后手动写入仍应用删除标记', async () => {
    const a = app();
    a.set('immersiveHistory', [record()]);
    const file = attachBackup(a, { history: [record()], stats: {} });
    a.run('prefs.autoBackup=false; deleteHistoryItem(0)');
    assert.equal(file.writes, 0);
    await a.run('writeBackupFile({requestPermission:true})');
    assert.equal(file.data.history.length, 0);
});

test('旧备份不能通过导入复活已删除记录，预览说明删除影响', () => {
    const a = app();
    a.set('immersiveHistory', [record()]);
    a.run('deleteHistoryItem(0)');
    a.context.input = { history: [record()], stats: {} };
    a.run('openImportPreview(input)');
    assert.match(a.elements.get('import-preview-summary').textContent, /跳过已删除记录 1 条/);
    a.run('applyImportPreview()');
    assert.equal(a.get('immersiveHistory').length, 0);
    a.run('undoHistoryDelete()');
    assert.equal(a.get('immersiveHistory').length, 1);
});

test('删除失败不丢记录、不改变删除状态、不出现撤销按钮', () => {
    const a = app();
    a.set('immersiveHistory', [record()]);
    a.failNext('timing_recordStates');
    assert.equal(a.run('deleteHistoryItem(0)'), false);
    assert.deepEqual(a.get('immersiveHistory'), [record()]);
    assert.equal(a.storage.has('timing_recordStates'), false);
    assert.equal(a.run('historyUndoStack.length'), 0);
});

test('中文上午/下午、英文旧时间与无法识别日期', () => {
    const a = app();
    assert.equal(a.run('parseLegacyStartTime("2026/10/5 下午9:00:00")'), new Date(2026, 9, 5, 21).getTime());
    assert.equal(a.run('parseLegacyStartTime("2026年10月5日 上午12:00:00")'), new Date(2026, 9, 5, 0).getTime());
    assert.equal(a.run('parseLegacyStartTime("10/5/2026, 9:00:00 PM")'), new Date(2026, 9, 5, 21).getTime());
    assert.equal(a.run('parseLegacyStartTime("2026/2/30 10:00:00")'), null);
    assert.equal(a.run('parseLegacyStartTime("未知时间")'), null);
    a.context.list = [{ ...record(), startTime: '未知时间' }];
    assert.equal(Object.keys(a.run('buildDailyStats(list)')).length, 0);
    assert.match(a.run('renderHistorySummary(list)'), /1 条旧记录的开始日期无法识别/);
    assert.match(a.run('renderHistorySummary(list)'), /累计 25 分/);
});

test('今日合计使用开始时间，开始时间戳优先于显示文字', () => {
    const a = app();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    a.context.list = [{ ...record(1), startedAt: today.getTime() }];
    assert.match(a.run('renderHistorySummary(list)'), /今日 25 分/);
});

test('重复 ID、坏时间戳、负数计数和坏删除标记被拒绝', () => {
    const a = app();
    for (const input of [
        { history: [record(), record()], stats: {} },
        { history: [{ ...record(), startedAt: -1 }], stats: {} },
        { history: [], stats: { 任务: -2 } },
        { history: [], stats: {}, recordStates: { 1: { deleted: 'yes', changedAt: Date.now() } } }
    ]) {
        a.context.input = input;
        assert.throws(() => a.run('validateBackupPayload(input)'), /重复|无效|计数/);
    }
});

test('空备份可初始化，有效但格式错误的 JSON 不可覆盖', async () => {
    const a = app();
    a.set('immersiveHistory', [record()]);
    const file = attachBackup(a, '');
    assert.equal(await a.run('writeBackupFile({})'), true);
    assert.equal(file.data.history.length, 1);
    file.data = '{}'; const before = file.writes;
    assert.equal(await a.run('writeBackupFile({})'), false);
    assert.equal(file.writes, before);
});

test('删除状态经页面重开仍阻止旧备份复活记录', async () => {
    const first = app();
    first.set('immersiveHistory', [record()]);
    first.run('deleteHistoryItem(0)');
    const reopened = app();
    for (const [key, value] of first.storage) reopened.storage.set(key, value);
    const file = attachBackup(reopened, { history: [record()], stats: {} });
    await reopened.run('writeBackupFile({})');
    assert.equal(file.data.history.length, 0);
    assert.equal(reopened.run('historyUndoStack.length'), 0);
});

test('Web Lock 申请失败返回失败，之后队列仍可写入', async () => {
    const a = app();
    a.set('immersiveHistory', [record()]);
    const file = attachBackup(a, { history: [], stats: {} });
    a.context.navigator.locks = { request: async () => { throw new Error('lock failure'); } };
    assert.equal(await a.run('writeBackupFile({})'), false);
    assert.equal(file.writes, 0);
    delete a.context.navigator.locks;
    assert.equal(await a.run('writeBackupFile({})'), true);
});

test('撤销写入失败保留撤销机会，重试可恢复记录', () => {
    const a = app();
    a.set('immersiveHistory', [record()]);
    a.run('deleteHistoryItem(0)');
    a.failNext('timing_recordStates');
    assert.equal(a.run('undoHistoryDelete()'), false);
    assert.equal(a.get('immersiveHistory').length, 0);
    assert.equal(a.run('historyUndoStack.length'), 1);
    assert.equal(a.run('undoHistoryDelete()'), true);
    assert.equal(a.get('immersiveHistory').length, 1);
});

test('旧列表含空项时，渲染按钮仍引用原记录下标', () => {
    const a = app();
    a.set('immersiveHistory', [null, record()]);
    a.run('renderHistoryList(readHistory())');
    assert.match(a.elements.get('history-list-content').innerHTML, /deleteHistoryItem\(1\)/);
    assert.doesNotMatch(a.elements.get('history-list-content').innerHTML, /deleteHistoryItem\(0\)/);
});

test('设置中的赏析链接和 README 的 24 条来源完整', () => {
    assert.match(html, /href="https:\/\/mp\.weixin\.qq\.com\/s\/4gqoo0NMCwGUwEPzBJJqTQ"[^>]+rel="noopener noreferrer"/);
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.equal((readme.match(/^\| \d+ \|/gm) || []).length, 24);
});

test('开始日期而不是保存日期决定热力图与今日合计', () => {
    const a = app();
    const started = new Date(2026, 9, 5, 21).getTime();
    const saved = new Date(2026, 9, 6, 1).getTime();
    a.context.list = [{ ...record(saved), startedAt: started }];
    const result = JSON.parse(JSON.stringify(a.run('buildDailyStats(list)')));
    assert.equal(result['2026-10-05'].seconds, 1500);
    assert.equal(result['2026-10-06'], undefined);
    a.context.list = [record(saved)];
    assert.equal(a.run('buildDailyStats(list)["2026-10-05"].seconds'), 1500);
});

test('整 20 分钟完成时显示满环', () => {
    const a = app();
    a.run('totalDurationMinutes=20; updateTimerUI(1200000)');
    assert.equal(a.elements.get('progress-ring').style.strokeDashoffset, 0);
});

test('主动中止预加载不启动 Image 备用请求', async () => {
    const a = app();
    a.context.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    a.context.fallbackCount = 0;
    a.run('loadOneByImage = async () => { fallbackCount++; return true; }');
    await a.run('loadOneForCache(0)');
    assert.equal(a.context.fallbackCount, 0);
});

test('Service Worker 保留其他应用缓存', async () => {
    const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
    let activate, wait;
    const deleted = [];
    const context = { self: { addEventListener(type, cb) { if (type === 'activate') activate = cb; }, clients: { claim: async () => {} }, skipWaiting() {} }, caches: { keys: async () => ['other-app-cache', 'timing-images-v1', 'restoretimingtimer-images-v1'], delete: async key => { deleted.push(key); } } };
    vm.runInNewContext(sw, context);
    activate({ waitUntil(p) { wait = p; } });
    await wait;
    assert.equal(deleted.includes('other-app-cache'), false);
    assert.equal(deleted.includes('restoretimingtimer-images-v1'), true);
});

module.exports = { app, record, attachBackup };

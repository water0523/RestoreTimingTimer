const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function app(initialStorage = {}) {
    const storage = new Map(Object.entries(initialStorage).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
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

test('设置中的赏析链接和 README 的 36 条来源完整', () => {
    assert.match(html, /href="https:\/\/mp\.weixin\.qq\.com\/s\/4gqoo0NMCwGUwEPzBJJqTQ"[^>]+rel="noopener noreferrer"/);
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.equal((readme.match(/^\| \d+ \|/gm) || []).length, 36);
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

test('36 阶段按指定顺序排列，新增文案与本地图片完整', () => {
    const a = app();
    const stages = JSON.parse(a.run('JSON.stringify(resources)'));
    assert.deepEqual(stages.map(s => s.title), ['奇点', '大爆炸', '星云', '太阳系', '地球形成', '冥古宙', '太古代', '元古代', '震旦纪', '寒武纪', '奥陶纪', '志留纪', '泥盆纪', '石炭纪', '二叠纪', '三叠纪', '侏罗纪', '白垩纪', '古近纪', '石器时代', '古代', '部落', '农业革命', '村庄', '文字发明', '人群', '近代', '工业革命', '现代', '信息时代', '城市', '未来城市', '核爆炸', '地球毁灭', '太阳毁灭', '宇宙毁灭']);
    const additions = {
        奇点: '一切尚未发生，寂静里藏着所有可能。',
        星云: '尘埃缓缓聚拢，光也在悄悄靠近。',
        冥古宙: '熔岩冷却，第一场雨落下，耐心会改变星球。',
        元古代: '氧气充满海洋，改变总在无声中发生。',
        志留纪: '生命试着上岸，笨拙也是开始。',
        二叠纪: '森林沉入地层，积累会以另一种方式发光。',
        古近纪: '恐龙远去，新的生命开始生长。',
        石器时代: '火光照亮洞穴，学习从第一次尝试开始。',
        农业革命: '种子落进泥土，等待有了形状。',
        文字发明: '符号刻下思想，笔记替你记住时光。',
        工业革命: '机器轰鸣，知识改变世界；你也正在改变自己。',
        信息时代: '信息如潮，学会筛选，也学会安静。'
    };
    for (const [title, quote] of Object.entries(additions)) assert.equal(stages.find(s => s.title === title).quote, quote);
    assert.equal(new Set(stages.map(s => s.img)).size, 36);
    for (const stage of stages) assert(fs.statSync(path.join(root, stage.img)).size > 0, stage.title);
});

test('时长滚轮可选 12 小时，12 小时以上收口且 11 小时 59 分仍可用', () => {
    const a = app();
    a.run('initPicker()');
    assert.match(a.elements.get('hour-content').innerHTML, /data-v="12"/);
    assert.doesNotMatch(a.elements.get('hour-content').innerHTML, /data-v="13"/);
    a.run('applyDurationDisplay(719)');
    assert.equal(a.run('totalDurationMinutes'), 719);
    a.elements.get('col-hour').scrollTop = 12 * 44;
    a.elements.get('col-minute').scrollTop = 59 * 44;
    a.run('confirmPicker()');
    assert.equal(a.run('totalDurationMinutes'), 720);
    assert.equal(a.storage.get('timing_lastDurationMinutes'), '720');
});

test('超过 8 小时的暂存可续上，仍保留 12 小时目标和原开始时间', () => {
    const a = app();
    const started = new Date(2026, 9, 5, 21).getTime();
    a.set('timing_suspendedSession', { task: '长时专注', totalMinutes: 720, elapsedMs: 9 * 3600000, startTime: started, imageOffset: 0, savedAt: Date.now() });
    a.run('resumeSuspended()');
    assert.equal(a.run('totalDurationMinutes'), 720);
    assert.equal(a.run('elapsedMs'), 9 * 3600000);
    assert.equal(a.run('sessionStartTimeObj.getTime()'), started);
    assert.equal(a.run('resources[currentResIndex].title'), '工业革命');
    assert.equal(a.run('collectSessionState(true).totalMinutes'), 720);
});

test('开发者时间轴覆盖 12 小时，调试不覆盖上次的正常时长', () => {
    const a = app();
    a.storage.set('timing_lastDurationMinutes', '25');
    a.run('activateDevMode()');
    assert.equal(a.run('totalDurationMinutes'), 720);
    assert.equal(Number(a.elements.get('dev-slider').max), 43200);
    assert.equal(a.storage.get('timing_lastDurationMinutes'), '25');
    assert.match(html, /id="dev-slider"[^>]+max="43200"/);
});

test('20 分钟边界正确切图，12 小时末尾停在宇宙毁灭并显示满环', () => {
    const a = app();
    a.run('totalDurationMinutes = 720');
    for (let stage = 0; stage < 36; stage++) {
        a.context.time = stage * 1200000;
        assert.equal(a.run('getCycleIndex(time)'), stage);
        a.context.time += 1199999;
        assert.equal(a.run('getCycleIndex(time)'), stage);
    }
    a.run('syncResourceToCycle(getCycleIndex(43200000)); updateTimerUI(43200000)');
    assert.equal(a.run('resources[currentResIndex].title'), '宇宙毁灭');
    assert.equal(a.elements.get('timer-display').innerText, '12:00:00');
    assert.equal(a.elements.get('progress-ring').style.strokeDashoffset, 0);
    a.run('totalDurationMinutes = 20');
    assert.equal(a.run('getCycleIndex(1200000)'), 0);
});

test('最后一个阶段不再提前下载会话结束后的图片', () => {
    const a = app();
    a.run('totalDurationMinutes = 720; elapsedMs = 11 * 3600000 + 40 * 60000; startTime = 1000; isRunning = true; prefetchTimer = null; schedulePrefetchAhead()');
    assert.equal(a.run('prefetchTimer'), null);
});

test('后台结束兜底也会对齐最后阶段，停止计时并显示 12 小时总结', () => {
    const a = app();
    let end;
    a.context.setTimeout = (callback, ms) => { if (ms === 43200000) end = callback; return 1; };
    a.run('totalDurationMinutes = 720; isRunning = true; elapsedMs = 0; scheduleEndTimer()');
    assert.equal(typeof end, 'function');
    end();
    assert.equal(a.run('isRunning'), false);
    assert.equal(a.run('elapsedMs'), 43200000);
    assert.equal(a.run('resources[currentResIndex].title'), '宇宙毁灭');
    assert.equal(a.elements.get('summary-duration').innerText, '12:00:00');
    assert.equal(a.elements.get('summary-modal').classList.contains('active'), true);
});

test('默认 36 阶段，原版保留全部 24 阶段的顺序与原图', () => {
    const a = app();
    assert.equal(a.run('prefs.stageMode'), 'extended');
    assert.equal(a.run('resources.length'), 36);
    a.run('onStageModeChange("classic")');
    const stages = JSON.parse(a.run('JSON.stringify(resources)'));
    assert.deepEqual(stages.map(s => s.title), ['大爆炸', '太阳系', '地球形成', '太古代', '震旦纪', '寒武纪', '奥陶纪', '泥盆纪', '石炭纪', '三叠纪', '侏罗纪', '白垩纪', '古代', '部落', '村庄', '人群', '近代', '现代', '城市', '未来城市', '核爆炸', '地球毁灭', '太阳毁灭', '宇宙毁灭']);
    assert.deepEqual(stages.map(s => s.img), Array.from({ length: 24 }, (_, i) => `./images/${i + 1}.webp`));
    assert.equal(a.run('getMaxDurationMinutes()'), 480);
    a.run('onStageModeChange("extended")');
    assert.equal(a.run('resources.length'), 36);
    assert.equal(a.run('getMaxDurationMinutes()'), 720);
});

test('模式选择刷新后保留，旧偏好与无效模式默认 36 阶段', () => {
    const first = app();
    first.run('onStageModeChange("classic")');
    const second = app(Object.fromEntries(first.storage));
    assert.equal(second.run('resources.length'), 24);
    assert.equal(second.elements.get('pref-stageMode').value, 'classic');
    for (const stageMode of [undefined, 'unknown', true, '__proto__']) {
        const a = app({ timing_prefs: { stageMode, backgroundCover: false } });
        assert.equal(a.run('prefs.stageMode'), 'extended');
        assert.equal(a.run('resources.length'), 36);
        assert.equal(a.run('prefs.backgroundCover'), false);
        a.run('onStageModeChange("invalid")');
        assert.equal(a.run('resources.length'), 36);
    }
});

test('原版时长和小时滚轮限于 8 小时，切回后可选 12 小时', () => {
    const a = app();
    a.run('applyDurationDisplay(720); onStageModeChange("classic")');
    assert.equal(a.run('totalDurationMinutes'), 480);
    assert.match(a.elements.get('hour-content').innerHTML, /data-v="8"/);
    assert.doesNotMatch(a.elements.get('hour-content').innerHTML, /data-v="9"/);
    a.run('applyDurationDisplay(719)');
    assert.equal(a.run('totalDurationMinutes'), 480);
    assert.match(a.elements.get('preload-all-help').textContent, /24 张/);
    a.run('onStageModeChange("extended")');
    assert.match(a.elements.get('hour-content').innerHTML, /data-v="12"/);
    a.run('applyDurationDisplay(719)');
    assert.equal(a.run('totalDurationMinutes'), 719);
});

test('原版开发者时间轴覆盖 8 小时，完成时仍在宇宙毁灭', () => {
    const a = app();
    a.run('onStageModeChange("classic"); activateDevMode()');
    assert.equal(a.run('totalDurationMinutes'), 480);
    assert.equal(Number(a.elements.get('dev-slider').max), 28800);
    a.run('syncResourceToCycle(getCycleIndex(28800000)); updateTimerUI(28800000)');
    assert.equal(a.run('resources[currentResIndex].title'), '宇宙毁灭');
    assert.equal(a.elements.get('timer-display').innerText, '08:00:00');
});

test('运行或暂停中切换只影响下一次专注，不截断本次目标与进度', () => {
    for (const running of [true, false]) {
        const a = app();
        a.context.running = running;
        a.run('totalDurationMinutes = 720; elapsedMs = 9 * 3600000; startTime = 1000; sessionActive = true; isRunning = running; currentResIndex = 27; onStageModeChange("classic")');
        assert.equal(a.run('resources.length'), 36);
        assert.equal(a.run('totalDurationMinutes'), 720);
        assert.equal(a.run('elapsedMs'), 9 * 3600000);
        assert.equal(a.run('collectSessionState(true).stageMode'), 'extended');
        assert.equal(a.get('timing_prefs').stageMode, 'classic');
        assert.match(a.elements.get('stage-mode-help').textContent, /下一次/);
        a.run('stopTimer()');
        assert.equal(a.run('resources.length'), 24);
        a.run('startFocus()');
        assert.equal(a.run('totalDurationMinutes'), 480);
        assert.equal(a.run('collectSessionState(true).stageMode'), 'classic');
    }
});

test('12 小时会话在原版偏好下仍恢复为 36 阶段，结束后采用原版', () => {
    const startTime = new Date(2026, 9, 5, 21).getTime();
    const a = app({ timing_prefs: { stageMode: 'classic' }, timing_suspendedSession: { task: '长时会话', totalMinutes: 720, elapsedMs: 9 * 3600000, startTime, stageMode: 'extended', imageOffset: 0, savedAt: Date.now() } });
    a.run('resumeSuspended()');
    assert.equal(a.run('resources.length'), 36);
    assert.equal(a.run('totalDurationMinutes'), 720);
    assert.equal(a.run('elapsedMs'), 9 * 3600000);
    assert.equal(a.run('sessionStartTimeObj.getTime()'), startTime);
    assert.equal(a.run('prefs.stageMode'), 'classic');
    assert.equal(a.elements.get('pref-stageMode').value, 'classic');
    a.run('stopTimer()');
    assert.equal(a.run('resources.length'), 24);
});

test('原版快照在默认偏好下沿用 24 阶段和手动切图偏移', () => {
    const a = app({ timing_runningSession: { task: '原版会话', totalMinutes: 480, elapsedMs: 7 * 3600000, startTime: Date.now(), stageMode: 'classic', imageOffset: 1, savedAt: Date.now() } });
    a.run('resumeSuspended()');
    assert.equal(a.run('resources.length'), 24);
    assert.equal(a.run('resources[currentResIndex].title'), '太阳毁灭');
    assert.equal(a.run('collectSessionState(true).stageMode'), 'classic');
    assert.equal(a.run('prefs.stageMode'), 'extended');
});

test('旧无模式标识的短会话保持原有 36 阶段恢复行为', () => {
    const a = app({ timing_prefs: { stageMode: 'classic' }, timing_suspendedSession: { task: '旧会话', totalMinutes: 25, elapsedMs: 1200000, startTime: Date.now(), imageOffset: 0, savedAt: Date.now() } });
    a.run('resumeSuspended()');
    assert.equal(a.run('resources.length'), 36);
    assert.equal(a.run('resources[currentResIndex].title'), '大爆炸');
    assert.equal(a.run('totalDurationMinutes'), 25);
});

test('切换模式按图片路径复用缓存，下标相同的不同图片不会串图', () => {
    const a = app();
    const singularity = a.run('ensureImage(0)');
    const bigbang = a.run('ensureImage(1)');
    a.run('onStageModeChange("classic")');
    assert.equal(a.run('ensureImage(0)'), bigbang);
    assert.notEqual(a.run('ensureImage(0)'), singularity);
    assert.equal(a.run('ensureImage(0).src'), './images/1.webp');
});

test('切换后旧图片解码回调失效，新的图片与阶段名保持一致', async () => {
    const a = app();
    const gates = [];
    a.context.Image = class { constructor() { this.complete = true; this.naturalWidth = 100; } addEventListener() {} decode() { return new Promise(resolve => gates.push(resolve)); } };
    a.run('prefs.preloadAll = false; updateResource(0, true, true); onStageModeChange("classic"); updateResource(0, true, true)');
    assert.equal(gates.length, 2);
    gates[0]();
    await Promise.resolve();
    assert.notEqual(a.elements.get('timer-task-name').innerText, '奇点');
    gates[1]();
    await Promise.resolve();
    assert.equal(a.elements.get('timer-task-name').innerText, '大爆炸');
    assert.match(a.run('bgLayer.style.backgroundImage'), /images\/1\.webp/);
});

test('图片失败重试捕获原路径，模式切换后不会使用旧下标查新数组', () => {
    const a = app();
    let retry;
    a.context.setTimeout = (callback, ms) => { if (ms === 1500) retry = callback; return 100; };
    const old = a.run('ensureImage(35)');
    old.onerror();
    a.run('prefs.preloadAll = false; onStageModeChange("classic")');
    assert.equal(typeof retry, 'function');
    assert.doesNotThrow(() => retry());
    assert.equal(old.src, './images/24.webp');
});

module.exports = { app, record, attachBackup };

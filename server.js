/**
 * 质量趋势图 —— 后端服务
 *
 * 只用 Node.js 内置模块，不需要 npm install：
 *     node server.js            启动服务
 *     node server.js --probe    只拉一天数据，打印真实字段名（首次接入必跑）
 *
 * 对外提供：
 *   GET  /             看板页面（quality.html）
 *   GET  /setup        OA 账号登录页（一次性配置用）
 *   GET  /api/quality  质量数据（JSON）
 *   GET  /api/config   当前配置状态（只回账号名，绝不回密码）
 *   POST /api/login    验证并保存 OA 账号
 *   POST /api/logout   清除已保存的 OA 账号
 *
 * 数据来源（口径由需求方指定）：
 *   分子 ← 接口 4「检验异常录入列表」ProductionInspectionList  的不良数
 *   分母 ← 接口 5「检验日报列表」  InspectionDailyReportList   的检验数量
 *
 *   良品率 = (分母检验数量 − 分子不良数) / 分母检验数量
 *
 * 注意：接口 5 自己也带「不良数量」字段。本服务会用它单独算一份
 * 「同源口径」的良品率作为对照，两者差得太多就在响应里标记出来 ——
 * 见 crossCheck。分子分母不同源是这套口径的固有风险，不能让它静默地错。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3200;                      // 3000 生产看板 / 3100 周报 / 3200 质量趋势
const PROBE = process.argv.includes('--probe');
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ═══════════════════════════════════════════════════════════════
// 配置
//
// OA 账号密码明文存在 config.json 里，该文件已在 .gitignore。
// 不做加密：密钥只能存在同一台机器上，加了等于没加，反而给人一种
// 安全的错觉。真正的防线是这台服务器本身的登录权限。
//
// 服务在「没配账号」时照常启动 —— 直接退出的话，服务器重启后大屏
// 就永远起不来了，和「无人值守」的要求冲突。没账号时看板会显示一条
// 明确提示，让人去 /setup 配。
// ═══════════════════════════════════════════════════════════════
const DEFAULTS = {
  baseUrl:   'http://192.168.0.249/RibaoOA/api/OAWebApi',
  userCode:  '',
  password:  '',
  days:      14,        // 趋势图显示最近多少天
  target:    98.5,      // 良品率目标线
  minSample: 200,       // 当日检验数低于此值 → 标为样本不足
  topGroups: 6,         // 小倍数显示前几个产品
  refreshMs: 300000,    // 向 OA 取数的间隔，默认 5 分钟
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('config.json 读取失败，用默认值：', err.message);
    return { ...DEFAULTS };
  }
}

let cfg = loadConfig();

// 写回时保留文件里已有的其它设置（days / target / 注释字段等），只覆盖传进来的键
function saveConfig(patch) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* 首次创建 */ }
  const next = { ...raw, ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  cfg = { ...DEFAULTS, ...next };
  cache = null; cacheAt = 0;        // 换了账号，旧缓存作废
}

const configured = () => Boolean(cfg.userCode && cfg.password);

// ═══════════════════════════════════════════════════════════════
// 字段名解析
//
// 接口文档只给了字段的中文名（「主要字段：…检验数量、不良数量…」），
// 没给真实的 JSON key。所以这里对每个字段准备一组候选名，按顺序试。
// 跑一次 `node server.js --probe` 就能看到真实 key，对不上时把正确的
// 名字加进对应数组即可 —— 只改这一处。
// ═══════════════════════════════════════════════════════════════
const FIELDS = {
  date:        ['检验日期', 'InspectionDate', 'inspectionDate', 'CheckDate', 'checkDate'],
  qty:         ['检验数量', '检验数', 'InspectionQty', 'inspectionQty', 'CheckQty', 'checkQty'],
  defectDaily: ['不良数量', 'DefectQty', 'defectQty', 'NgQty', 'ngQty'],
  defectAbn:   ['不良数', '不良数量', 'DefectQty', 'defectQty', 'NgQty', 'ngQty'],
  product:     ['产品代码', 'ProductCode', 'productCode', 'ItemCode', 'itemCode'],
  productName: ['产品名称', 'ProductName', 'productName', 'ItemName', 'itemName'],
};

function pick(row, names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== null && row[n] !== '') return row[n];
  }
  return undefined;
}

function num(v) {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// 检验日期可能是 '2026-07-29'、'2026/7/29'、'2026-07-29T00:00:00' —— 统一成 yyyy-MM-dd
function toDay(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

// ═══════════════════════════════════════════════════════════════
// 调 OA 接口
// ═══════════════════════════════════════════════════════════════
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function callOA(endpoint, startDate, endDate, creds = cfg) {
  const qs = new URLSearchParams({
    startDate, endDate,
    userCode: creds.userCode,
    password: creds.password,
  });
  const url = `${cfg.baseUrl}/${endpoint}?${qs}`;
  // 密码在 query string 里（接口就是这么设计的），所以日志和报错里绝不能出现完整 URL
  const safe = `${cfg.baseUrl}/${endpoint}?startDate=${startDate}&endDate=${endDate}&userCode=***&password=***`;

  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error(`连不上 OA（${safe}）：${err.message}`);
  }
  if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status} — ${safe}`);

  const body = await res.json();
  // 模板说明成功时是 {code:0,message,data}，但也可能直接返回数组
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    if (body.code !== undefined && Number(body.code) !== 0) {
      throw new Error(`${endpoint} 返回 code=${body.code}：${body.message || '无错误信息'}`);
    }
    if (Array.isArray(body.data)) return body.data;
  }
  throw new Error(`${endpoint} 返回结构无法识别：${JSON.stringify(body).slice(0, 200)}`);
}

// ═══════════════════════════════════════════════════════════════
// 聚合
// ═══════════════════════════════════════════════════════════════
function buildRange(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));
  const list = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) list.push(ymd(new Date(d)));
  return { startDate: ymd(start), endDate: ymd(end), allDays: list };
}

function aggregate(daily, abnormal, allDays) {
  const byDay = new Map(allDays.map(d => [d, { qty: 0, defect: 0, crossDefect: 0 }]));
  const byProduct = new Map();

  const touchProduct = (code, name) => {
    if (!byProduct.has(code)) {
      byProduct.set(code, {
        code, name: name || code, qty: 0, defect: 0,
        byDay: new Map(allDays.map(d => [d, { qty: 0, defect: 0 }])),
      });
    }
    const p = byProduct.get(code);
    if (name && p.name === p.code) p.name = name;
    return p;
  };

  // 分母：接口 5 检验日报
  for (const row of daily) {
    const day = toDay(pick(row, FIELDS.date));
    if (!day || !byDay.has(day)) continue;
    const qty = num(pick(row, FIELDS.qty));
    byDay.get(day).qty += qty;
    byDay.get(day).crossDefect += num(pick(row, FIELDS.defectDaily));

    const code = String(pick(row, FIELDS.product) ?? '未标注');
    const p = touchProduct(code, pick(row, FIELDS.productName));
    p.qty += qty;
    p.byDay.get(day).qty += qty;
  }

  // 分子：接口 4 检验异常录入
  for (const row of abnormal) {
    const day = toDay(pick(row, FIELDS.date));
    if (!day || !byDay.has(day)) continue;
    const def = num(pick(row, FIELDS.defectAbn));
    byDay.get(day).defect += def;

    const code = String(pick(row, FIELDS.product) ?? '未标注');
    const p = touchProduct(code, pick(row, FIELDS.productName));
    p.defect += def;
    p.byDay.get(day).defect += def;
  }

  const rateOf = (qty, defect) => (qty > 0 ? +((qty - defect) / qty * 100).toFixed(1) : null);

  const series = allDays.map(day => {
    const d = byDay.get(day);
    return {
      t: day.slice(5),                   // 轴标签只显示 MM-DD
      date: day,
      output: d.qty,
      defect: d.defect,
      rate: rateOf(d.qty, d.defect),
      crossRate: rateOf(d.qty, d.crossDefect),   // 接口 5 同源口径，仅用于对照
    };
  });

  // 小倍数：按检验量取前 N 个产品
  const groups = [...byProduct.values()]
    .filter(p => p.qty > 0)
    .sort((a, b) => b.qty - a.qty)
    .slice(0, cfg.topGroups)
    .map(p => ({
      name: p.name === p.code ? p.code : `${p.code} · ${p.name}`,
      spark: allDays.map(day => {
        const c = p.byDay.get(day);
        return rateOf(c.qty, c.defect);
      }),
    }));

  return { series, groups };
}

// 分子分母不同源的固有风险：拿接口 5 自带的不良数量算一份对照，差太多就标记
function crossCheck(series) {
  const valid = series.filter(s => s.rate !== null && s.crossRate !== null);
  if (!valid.length) return null;
  const worst = valid.reduce((a, b) =>
    Math.abs(b.rate - b.crossRate) > Math.abs(a.rate - a.crossRate) ? b : a);
  const gap = +Math.abs(worst.rate - worst.crossRate).toFixed(1);
  return {
    maxGap: gap,
    onDate: worst.date,
    ok: gap < 0.5,
    note: gap < 0.5
      ? '两种口径基本一致'
      : `${worst.date} 两种口径差 ${gap} 个百分点：异常录入(${worst.rate}%) vs 日报自带不良数(${worst.crossRate}%)。` +
        '说明有不良没走异常录入流程，或异常录入包含了日报未覆盖的检验。',
  };
}

// ═══════════════════════════════════════════════════════════════
// 取数 + 缓存
//
// 接口文档明确写了「大数据量查询应缩小日期范围或增加筛选条件，
// 避免影响 OA 服务」。所以大屏每 60 秒轮询我们，我们每 5 分钟才碰一次 OA。
// ═══════════════════════════════════════════════════════════════
let cache = null;
let cacheAt = 0;
let inflight = null;

async function fetchQuality() {
  const { startDate, endDate, allDays } = buildRange(cfg.days);
  const [daily, abnormal] = await Promise.all([
    callOA('InspectionDailyReportList', startDate, endDate),   // 分母
    callOA('ProductionInspectionList', startDate, endDate),    // 分子
  ]);

  if (!daily.length) throw new Error(`检验日报列表在 ${startDate} ~ ${endDate} 没有数据`);

  const { series, groups } = aggregate(daily, abnormal, allDays);

  const withData = series.filter(s => s.output > 0);
  const latest = withData[withData.length - 1] || null;
  const prev = withData[withData.length - 2] || null;
  const totalQty = withData.reduce((s, d) => s + d.output, 0);
  const totalDef = withData.reduce((s, d) => s + d.defect, 0);

  return {
    updatedAt: new Date().toISOString(),
    range: `${startDate} ~ ${endDate}`,
    target: cfg.target,
    minSample: cfg.minSample,
    summary: {
      rate: latest ? latest.rate : null,
      defect: latest ? latest.defect : 0,
      output: latest ? latest.output : 0,
      periodRate: totalQty > 0 ? +((totalQty - totalDef) / totalQty * 100).toFixed(1) : null,
      rateDelta: latest && prev ? +(latest.rate - prev.rate).toFixed(1) : null,
      defectDelta: latest && prev ? latest.defect - prev.defect : null,
      deltaBase: '前一有数据日',
      latestDate: latest ? latest.date : null,
    },
    series,
    groups,
    crossCheck: crossCheck(series),
    counts: { 日报记录: daily.length, 异常记录: abnormal.length },
  };
}

async function readQuality() {
  if (cache && Date.now() - cacheAt < cfg.refreshMs) return cache;
  if (inflight) return inflight;               // 并发请求合并成一次，别把 OA 打穿
  inflight = fetchQuality()
    .then(data => { cache = data; cacheAt = Date.now(); return data; })
    .finally(() => { inflight = null; });
  return inflight;
}

// ═══════════════════════════════════════════════════════════════
// 验证 OA 账号
//
// 没有专门的登录接口（鉴权方式就是每次请求带 userCode + password），
// 所以拿真实接口试拉一天数据来验：不抛错就算通过。
//
// 一个诚实的说明：如果账号错了，OA 返回的是空数组而不是错误码，
// 那这里是分辨不出来的 —— 会当成「通过，只是那天没数据」。
// 所以验证结果里会带上拿到多少条记录，让人自己看一眼。
// ═══════════════════════════════════════════════════════════════
async function verifyCredentials(userCode, password) {
  const today = ymd(new Date());
  const from = ymd(new Date(Date.now() - 6 * 864e5));
  const rows = await callOA('InspectionDailyReportList', from, today, { userCode, password });
  return { rows: rows.length, from, to: today };
}

// ═══════════════════════════════════════════════════════════════
// --probe：把真实字段名打出来
// ═══════════════════════════════════════════════════════════════
async function probe() {
  if (!configured()) {
    console.error('还没配 OA 账号。先启动服务 `node server.js`，浏览器打开 http://localhost:' + PORT + '/setup 登录一次。');
    process.exit(1);
  }
  const today = ymd(new Date());
  const from = ymd(new Date(Date.now() - 6 * 864e5));
  console.log(`探测区间 ${from} ~ ${today}（账号 ${cfg.userCode}）\n`);

  for (const [label, ep] of [['接口5 检验日报列表', 'InspectionDailyReportList'],
                             ['接口4 检验异常录入列表', 'ProductionInspectionList']]) {
    try {
      const rows = await callOA(ep, from, today);
      console.log(`── ${label}（${ep}）: ${rows.length} 条`);
      if (rows.length) {
        console.log('   真实字段名：', Object.keys(rows[0]).join(', '));
        console.log('   第一条：', JSON.stringify(rows[0], null, 2).replace(/\n/g, '\n   '));
      }
    } catch (err) {
      console.log(`── ${label}（${ep}）失败：${err.message}`);
    }
    console.log();
  }
  console.log('把上面的真实字段名对照 server.js 里的 FIELDS 表，对不上就补进去。');
}

// ═══════════════════════════════════════════════════════════════
// HTTP 服务
// ═══════════════════════════════════════════════════════════════
function sendJSON(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function sendFile(res, file, type) {
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`500 找不到 ${file}`);
      return;
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > limit) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

async function handleLogin(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (err) { return sendJSON(res, 400, { error: err.message }); }

  const userCode = String(body.userCode || '').trim();
  const password = String(body.password || '');
  if (!userCode || !password) {
    return sendJSON(res, 400, { error: '账号和密码都要填' });
  }

  // 已经配过账号了，改账号必须先验证当前密码 ——
  // 否则任何能访问这个端口的人都能把服务账号换掉
  if (configured() && body.currentPassword !== cfg.password) {
    return sendJSON(res, 403, { error: '已配置账号。要更换请先填写当前密码。' });
  }

  try {
    const check = await verifyCredentials(userCode, password);
    saveConfig({ userCode, password });
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] OA 账号已保存：${userCode}`);
    sendJSON(res, 200, {
      ok: true,
      userCode,
      rows: check.rows,
      note: check.rows === 0
        ? `连通了，但 ${check.from} ~ ${check.to} 一条记录都没有。可能是这几天确实没检验，也可能是账号没有该数据的权限——请自己确认一下。`
        : `连通正常，最近 7 天拿到 ${check.rows} 条检验日报记录。`,
    });
  } catch (err) {
    console.error('OA 账号验证失败:', err.message);
    sendJSON(res, 401, { error: err.message });
  }
}

async function handleLogout(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (err) { return sendJSON(res, 400, { error: err.message }); }

  if (configured() && body.currentPassword !== cfg.password) {
    return sendJSON(res, 403, { error: '要清除账号，请先填写当前密码。' });
  }
  saveConfig({ userCode: '', password: '' });
  console.log(`[${new Date().toLocaleTimeString('zh-CN')}] OA 账号已清除`);
  sendJSON(res, 200, { ok: true });
}

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${req.method} ${url}`);

    if (req.method === 'POST' && url === '/api/login')  return handleLogin(req, res);
    if (req.method === 'POST' && url === '/api/logout') return handleLogout(req, res);

    // 只回账号名和配置状态，密码绝不出服务端
    if (url === '/api/config') {
      return sendJSON(res, 200, {
        configured: configured(),
        userCode: cfg.userCode || '',
        baseUrl: cfg.baseUrl,
        days: cfg.days,
        target: cfg.target,
      });
    }

    if (url === '/api/quality') {
      if (!configured()) {
        return sendJSON(res, 503, {
          error: '还没配置 OA 账号',
          needSetup: true,
          setupUrl: '/setup',
        });
      }
      try {
        const data = await readQuality();
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(data));
      } catch (err) {
        console.error('取数失败:', err.message);
        sendJSON(res, 502, { error: err.message });
      }
      return;
    }

    if (url === '/setup' || url === '/setup.html') {
      return sendFile(res, 'setup.html', 'text/html; charset=utf-8');
    }
    if (url === '/' || url === '/quality.html') {
      return sendFile(res, 'quality.html', 'text/html; charset=utf-8');
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  });

  server.listen(PORT, () => {
    console.log('─'.repeat(56));
    console.log('  质量趋势图已启动');
    console.log(`  看板页面：http://localhost:${PORT}`);
    console.log(`  数据接口：http://localhost:${PORT}/api/quality`);
    if (configured()) {
      console.log(`  OA 账号：${cfg.userCode}（已配置）`);
      console.log(`  取数间隔：${cfg.refreshMs / 1000} 秒（大屏轮询走缓存，不直接压 OA）`);
    } else {
      console.log('');
      console.log('  ⚠ 还没配 OA 账号，看板暂时取不到数。');
      console.log(`  请打开 http://localhost:${PORT}/setup 登录一次（只需一次）。`);
    }
    console.log('  按 Ctrl+C 停止');
    console.log('─'.repeat(56));
  });
}

if (PROBE) probe().catch(err => { console.error(err.message); process.exit(1); });
else serve();

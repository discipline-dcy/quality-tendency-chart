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
const os = require('os');

// 默认 3200（3000 生产看板 / 3100 周报 / 3200 质量趋势）。
// 允许覆盖是因为交换机在 VLAN 之间可能只放行 80/443，车间大屏够不到高位端口：
//   node server.js --port 80        或        set PORT=80 && node server.js
const PORT = Number(
  (process.argv[process.argv.indexOf('--port') + 1] || '').match(/^\d+$/)?.[0]
  || process.env.PORT
) || 3200;

// 绑 0.0.0.0 而不是 127.0.0.1：车间大屏、班组长的电脑、主任的手机都在
// 内网另一头，只绑本机回环的话除了服务器自己谁都打不开。
// 这本来就是 listen(PORT) 不写 host 时的默认行为，这里写出来是为了讲明白
// 「对内网开放」是有意为之，别哪天被当成疏漏改回 localhost。
const HOST = '0.0.0.0';
const PROBE = process.argv.includes('--probe');
const SET_ACCOUNT = process.argv.includes('--set-account');
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
  // 实测日检验量在 98 ~ 751 之间（单条 1~166），200 这个阈值会把一半的
  // 日子误标成「样本不足」。降到 50，接入后按实际检验量再调
  minSample: 50,
  topGroups: 6,         // 小倍数显示前几个产品
  refreshMs: 300000,    // 向 OA 取数的间隔，默认 5 分钟
};

// 环境变量优先级最高，其次 config.json，最后 DEFAULTS。
// 有环境变量这条路，是因为转接到别的机器时未必方便编辑文件 ——
// 临时起一次服务只要 `set OA_USER_CODE=... && node server.js` 就行，
// 而且账号不会落到磁盘上。
function envOverrides() {
  const out = {};
  if (process.env.OA_USER_CODE) out.userCode = process.env.OA_USER_CODE.trim();
  if (process.env.OA_PASSWORD)  out.password = process.env.OA_PASSWORD;
  if (process.env.OA_BASE_URL)  out.baseUrl  = process.env.OA_BASE_URL.trim();
  return out;
}

function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      // 文件不存在是正常情况（首次部署、或全用环境变量），不该报警
    } else if (err instanceof SyntaxError) {
      // JSON 写坏了必须说清楚。以前这里只打一句「读取失败」，
      // 然后服务照常启动、看板显示"没配账号"，很容易被当成账号问题查半天。
      console.error('✗ config.json 不是合法 JSON：' + err.message);
      console.error('  常见原因：少了逗号、多了尾逗号、用了中文引号。');
      console.error('  这次先用默认值启动，账号会被当成未配置。');
    } else {
      console.warn('config.json 读取失败，用默认值：', err.message);
    }
  }
  return { ...DEFAULTS, ...raw, ...envOverrides() };
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
// 已连真实接口实测确认（2026-07-29），两个接口返回的都是中文字段名
const FIELDS = {
  date:        ['检验日期', 'InspectionDate', 'inspectionDate', 'CheckDate', 'checkDate'],
  qty:         ['检验数量', '检验数', 'InspectionQty', 'inspectionQty', 'CheckQty', 'checkQty'],
  defectDaily: ['不良数量', 'DefectQty', 'defectQty', 'NgQty', 'ngQty'],
  defectAbn:   ['不良数', '不良数量', 'DefectQty', 'defectQty', 'NgQty', 'ngQty'],
  product:     ['产品代码', 'ProductCode', 'productCode', 'ItemCode', 'itemCode'],
  productName: ['产品名称', 'ProductName', 'productName', 'ItemName', 'itemName'],
  // 库存分类是干净的机型名（BCS-160A / BC-30 / VS-75(M165)），
  // 产品名称是一长串规格描述（「BCS-160A-110V(美标 清分美元、欧元…12国 内置打印机…）」），
  // 五米外的大屏上放不下，所以标签优先用库存分类
  stockClass:  ['库存分类', 'StockClass', 'stockClass'],
  // 这两个用来诊断分子分母的记录集合对不对得齐
  type:        ['检验类型', 'InspectionType', 'inspectionType'],
  position:    ['检出位置', 'DetectPosition', 'detectPosition'],
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

  const touchProduct = (code, label) => {
    if (!byProduct.has(code)) {
      byProduct.set(code, {
        code, label: label || '', qty: 0, defect: 0,
        byDay: new Map(allDays.map(d => [d, { qty: 0, defect: 0 }])),
      });
    }
    const p = byProduct.get(code);
    if (label && !p.label) p.label = label;
    return p;
  };

  // 分子分母的记录集合对不对得齐，看「检验类型 + 检出位置」这个组合
  const comboOf = row => `${pick(row, FIELDS.type) ?? '(空)'} / ${pick(row, FIELDS.position) ?? '(空)'}`;
  const denomCombos = new Set();
  const orphan = new Map();          // 分母没覆盖的组合 → 分子在上面记了多少不良

  // 分母：接口 5 检验日报
  for (const row of daily) {
    const day = toDay(pick(row, FIELDS.date));
    if (!day || !byDay.has(day)) continue;
    denomCombos.add(comboOf(row));

    const qty = num(pick(row, FIELDS.qty));
    byDay.get(day).qty += qty;
    byDay.get(day).crossDefect += num(pick(row, FIELDS.defectDaily));

    const code = String(pick(row, FIELDS.product) ?? '未标注');
    const p = touchProduct(code, pick(row, FIELDS.stockClass));
    p.qty += qty;
    p.byDay.get(day).qty += qty;
  }

  // 分子：接口 4 检验异常录入
  let abnDefect = 0;
  for (const row of abnormal) {
    const day = toDay(pick(row, FIELDS.date));
    if (!day || !byDay.has(day)) continue;
    const def = num(pick(row, FIELDS.defectAbn));
    byDay.get(day).defect += def;
    abnDefect += def;

    // 这条不良所在的检验环节，分母那边根本没有对应记录 → 记下来
    const combo = comboOf(row);
    if (def > 0 && !denomCombos.has(combo)) orphan.set(combo, (orphan.get(combo) || 0) + def);

    const code = String(pick(row, FIELDS.product) ?? '未标注');
    const p = touchProduct(code, pick(row, FIELDS.stockClass));
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
      name: p.label || p.code,        // 机型名优先；没有就退回产品代码
      code: p.code,
      // 卡片上的大数字用**整个区间**的良品率，不是最后一天的。
      // 面板标题写的是 14 天，数字就得是 14 天的 —— 取最后一天的话，
      // 某产品那天只检了 8 件坏 1 件就显示 87.5%，会让人去追一个不存在的问题
      qty: p.qty,
      defect: p.defect,
      rate: rateOf(p.qty, p.defect),
      lowSample: p.qty < cfg.minSample,
      spark: allDays.map(day => {
        const c = p.byDay.get(day);
        return rateOf(c.qty, c.defect);
      }),
    }));

  // 库存分类会重名（多个产品代码同属「点钞机半制品」）。三张卡片顶着
  // 一模一样的标题，在大屏上等于没标 —— 重名的补上产品代码后缀区分
  const nameCount = groups.reduce((m, g) => (m[g.name] = (m[g.name] || 0) + 1, m), {});
  for (const g of groups) {
    if (nameCount[g.name] > 1 && g.name !== g.code) g.name = `${g.name} ${g.code.slice(-4)}`;
  }

  const dailyOwnDefect = daily.reduce((s, r) => s + num(pick(r, FIELDS.defectDaily)), 0);
  const orphanList = [...orphan.entries()].sort((a, b) => b[1] - a[1]);

  return {
    series, groups,
    audit: {
      dailyOwnDefect,                                        // 日报自己填的不良合计
      abnormalDefect: abnDefect,                             // 当前分子
      orphanDefect: orphanList.reduce((s, [, v]) => s + v, 0),
      orphanCombos: orphanList.slice(0, 5).map(([k, v]) => `${k} → ${v} 件`),
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// 口径体检
//
// 分子分母不同源，风险是真的。但实测发现「拿日报自带的不良数量做对照」
// 这条路走不通 —— 日报里 100 条只有 20 条填了不良数量，合计 64 件，
// 而异常录入是 156 件。日报那个字段基本没人填，拿它当基准只会一直误报。
// （反过来说，这恰好证明用异常录入当分子是对的。）
//
// 真正该盯的是另一件事：**分子里有多少不良，落在分母根本没覆盖的检验环节上**。
// 实测确实存在 —— 异常录入里有「流水生产互检」「组件生产」，日报里一条都没有。
// 这部分不良有分子没分母，会把良品率算低。这个量是可以精确算出来的，
// 所以体检报这个数，不报那个虚的百分点差。
// ═══════════════════════════════════════════════════════════════
function auditRatio(audit, totalQty) {
  const { orphanDefect, orphanCombos, abnormalDefect, dailyOwnDefect } = audit;
  const pct = totalQty > 0 ? +(orphanDefect / totalQty * 100).toFixed(2) : 0;
  const ok = orphanDefect === 0;
  return {
    ...audit,
    orphanPct: pct,
    ok,
    note: ok
      ? '分子的检验环节都能在分母里找到对应记录'
      : `分子里有 ${orphanDefect} 件不良（占分母 ${pct}%）来自分母未覆盖的检验环节，` +
        `这部分有分子没分母，会把良品率算低：${orphanCombos.join('；')}`,
    hint: dailyOwnDefect < abnormalDefect * 0.6
      ? `另注：日报自带的「不良数量」只有 ${dailyOwnDefect} 件，远少于异常录入的 ${abnormalDefect} 件，` +
        '说明日报那个字段基本没人填 —— 用异常录入当分子是对的。'
      : null,
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

  const { series, groups, audit } = aggregate(daily, abnormal, allDays);

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
    crossCheck: auditRatio(audit, totalQty),
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
// --set-account：在服务端配账号，不用开浏览器
//
//   node server.js --set-account 10639
//
// 存在的理由：/setup 那个页面要有浏览器、要服务先跑起来、还得知道端口。
// 转接到车间那台机器时这几样都未必顺手，而配账号是部署的第一步 ——
// 第一步就依赖浏览器不合理。
//
// 密码走 stdin 而不是命令行参数：参数会留在 shell 历史里，Windows 上
// 还能被别的进程从命令行看到，等于把密码写在了明处。
// ═══════════════════════════════════════════════════════════════
async function setAccount() {
  const i = process.argv.indexOf('--set-account');
  const userCode = String(process.argv[i + 1] || '').trim();

  if (!userCode || userCode.startsWith('--')) {
    console.error('用法：node server.js --set-account <OA账号>');
    console.error('     回车后再输密码（不回显在命令行参数里）。');
    process.exit(1);
  }

  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const password = await new Promise(resolve => {
    rl.question(`OA 账号 ${userCode} 的密码：`, ans => { rl.close(); resolve(ans); });
  });

  if (!password) {
    console.error('✗ 密码为空，没有改动。');
    process.exit(1);
  }

  process.stdout.write('正在向 OA 验证…');
  try {
    const check = await verifyCredentials(userCode, password);
    console.log(`\r✓ 验证通过（试取 ${check.rows} 条记录，区间 ${check.from} ~ ${check.to}）`);
  } catch (err) {
    console.log('\r✗ 验证失败：' + err.message);
    console.error('  账号密码没有写入 config.json。');
    process.exit(1);
  }

  saveConfig({ userCode, password });
  console.log(`✓ 已写入 ${CONFIG_PATH}`);
  console.log('  现在可以 `node server.js` 正常启动了。');
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
function sendJSON(res, code, obj, extraHeaders) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  res.writeHead(code, headers);
  res.end(JSON.stringify(obj));
}

// 只给 /api/quality 用。不往 /api/config、/api/login 上加 ——
// 那两个回的是账号名和登录结果，没有理由让任意来源读得到
const QUALITY_CORS = { 'Access-Control-Allow-Origin': '*' };

function sendFile(res, file, type) {
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`500 找不到 ${file}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      // 页面必须每次回源。改了代码却因为浏览器缓存看到旧页面，
      // 排查起来会以为是后端坏了 —— 已经踩过一次。
      // 对车间大屏更要紧：那块屏几个月不重启，缓存住的旧页面会一直挂着
      'Cache-Control': 'no-cache, must-revalidate',
    });
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
  // 否则任何能访问这个端口的人都能把服务账号换掉。
  //
  // 但「知道当前密码」有两种证明方式：填在 currentPassword 里，
  // 或者提交的 password 本身就是当前密码（重新验证同一个账号的情形）。
  // 只认前一种的话，用同样的账号密码重新验证一次都会被 403 挡住 ——
  // 页面上账号栏本来就自动填好了，用户会以为是登不上。
  const knowsCurrent = body.currentPassword === cfg.password || password === cfg.password;
  if (configured() && !knowsCurrent) {
    return sendJSON(res, 403, {
      error: `已配置账号 ${cfg.userCode}。要换成别的账号，请在「当前密码」里填写现有账号的密码。`
             + '（如果只是想重新验证现有账号，直接用它自己的密码提交即可。）',
    });
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

// 用已经存好的账号跑一次验证，不改任何配置。
// 「我的账号还能用吗」应该有个不需要重新输密码的答案
async function handleVerify(req, res) {
  if (!configured()) {
    return sendJSON(res, 400, { error: '还没配置账号' });
  }
  try {
    const check = await verifyCredentials(cfg.userCode, cfg.password);
    sendJSON(res, 200, {
      ok: true,
      userCode: cfg.userCode,
      rows: check.rows,
      note: check.rows === 0
        ? `连通了，但 ${check.from} ~ ${check.to} 一条记录都没有。可能是这几天确实没检验，也可能是账号没有该数据的权限。`
        : `账号正常，最近 7 天拿到 ${check.rows} 条检验日报记录。`,
    });
  } catch (err) {
    console.error('已存账号验证失败:', err.message);
    sendJSON(res, 502, { error: err.message });
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

// 虚拟网卡的名字关键字：代理软件的 TUN 网卡、虚拟机、WSL、Hyper-V 的
// vEthernet、远程控制软件。这些网卡的 IP 只在本机这一头成立，车间大屏
// 那边根本路由不过来
const VIRTUAL_NIC = /mihomo|clash|v2ray|singbox|sing-box|tap|tun|vmware|virtualbox|vbox|vethernet|hyper-v|wsl|docker|zerotier|tailscale|radmin|npcap|loopback|虚拟/i;

// 真·内网网段（RFC1918）。Mihomo 的 TUN 网卡用的 198.18.0.0/15 是
// 基准测试保留段、不在这三段里，按网段筛就能连名字都不用认地滤掉
function isPrivateV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n))) return false;
  if (p[0] === 10) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  return false;
}

/**
 * 列出这台机器的内网 IPv4，给启动日志用 —— 别人问「网址是多少」的时候
 * 不用再去翻 ipconfig。
 *
 * 滤掉四类地址：
 *   - internal（127.0.0.1）：只有本机能用，这里要的是给别人用的地址
 *   - 169.254.x.x：APIPA，DHCP 没拿到地址时系统自己编的，连不通。
 *     这台机器上光虚拟网卡就有好几个这种，不滤会淹掉真正能用的那个。
 *   - 不在 RFC1918 网段里的：主要是代理软件 TUN 网卡的 198.18.x.x
 *   - 网卡名一看就是虚拟的：VMware 之流会占用 192.168.x.x，网段筛不掉
 *
 * 后两条筛过头会把唯一能用的地址也筛没，所以留了兜底：真筛空了就退回
 * 只做前两条的结果，宁可多打几行让人自己挑，也不能一行都不给
 */
function lanAddresses() {
  const all = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      // family 在 Node 18.0~18.3 那几个版本里是数字 4，之后又改回了字符串
      // 'IPv4'。服务器上的 Node 版本不归我们管，两种都认。
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      all.push({ address: a.address, name });
    }
  }
  const real = all.filter(x => isPrivateV4(x.address) && !VIRTUAL_NIC.test(x.name));
  return real.length ? real : all;
}

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${req.method} ${url}`);

    if (req.method === 'POST' && url === '/api/login')  return handleLogin(req, res);
    if (req.method === 'POST' && url === '/api/verify') return handleVerify(req, res);
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
      // 错误响应也必须带 CORS 头。看板可能是用 file:// 打开、跨机器取数的
      // （见 quality-maxhub.html 的 ?server= 用法），少了这个头，浏览器会
      // 把 503/502 整个拦掉，页面读不到 needSetup —— 于是「去 /setup 配账号」
      // 这条正确的引导永远不显示，只会报成一个含糊的连接异常
      if (!configured()) {
        return sendJSON(res, 503, {
          error: '还没配置 OA 账号',
          needSetup: true,
          setupUrl: '/setup',
        }, QUALITY_CORS);
      }
      try {
        const data = await readQuality();
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...QUALITY_CORS,
        });
        res.end(JSON.stringify(data));
      } catch (err) {
        console.error('取数失败:', err.message);
        sendJSON(res, 502, { error: err.message }, QUALITY_CORS);
      }
      return;
    }

    if (url === '/setup' || url === '/setup.html') {
      return sendFile(res, 'setup.html', 'text/html; charset=utf-8');
    }
    // 车间大屏版：同一份数据、同一套口径，只是排版和 JS 降级到老内核，
    // 并处理了安卓浏览器的后台节流、地址栏偷高度、下拉刷新等问题。
    // 和 / 上的原版并存 —— 大屏走 /board，电脑上仍看 /，两版可以对着比
    if (url === '/board' || url === '/quality-maxhub.html') {
      return sendFile(res, 'quality-maxhub.html', 'text/html; charset=utf-8');
    }
    if (url === '/' || url === '/quality.html') {
      return sendFile(res, 'quality.html', 'text/html; charset=utf-8');
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  });

  server.listen(PORT, HOST, () => {
    const lan = lanAddresses();
    console.log('─'.repeat(56));
    console.log('  质量趋势图已启动');
    console.log(`  本机访问：http://localhost:${PORT}`);
    if (lan.length) {
      console.log('  内网访问（大屏和其他电脑用这个）：');
      for (const { address, name } of lan) {
        console.log(`    http://${address}:${PORT}    ← ${name}`);
      }
    } else {
      console.log('  ⚠ 没找到内网 IP，这台机器可能没连网，其他电脑打不开。');
    }
    // 大屏那头是拿遥控器点地址栏输网址的，让人自己拼「地址 + /board」
    // 每次都要念一遍。这里直接把整条能敲的网址打全，照着抄就行
    console.log('  车间大屏（MAXHUB 安卓适配版）：');
    if (lan.length) {
      for (const { address, name } of lan) {
        console.log(`    http://${address}:${PORT}/quality-maxhub.html    ← ${name}`);
      }
    } else {
      console.log(`    http://localhost:${PORT}/quality-maxhub.html    ← 仅本机`);
    }
    console.log(`  数据接口：http://localhost:${PORT}/api/quality`);
    if (configured()) {
      console.log(`  OA 账号：${cfg.userCode}（已配置）`);
      console.log(`  取数间隔：${cfg.refreshMs / 1000} 秒（大屏轮询走缓存，不直接压 OA）`);
    } else {
      console.log('');
      console.log('  ⚠ 还没配 OA 账号，看板暂时取不到数。三选一：');
      console.log('    1) 命令行：node server.js --set-account <OA账号>   ← 不用浏览器');
      console.log('    2) 编辑 config.json，填 userCode / password（照 config.example.json 抄）');
      console.log(`    3) 浏览器打开 http://localhost:${PORT}/setup 登录一次`);
    }
    console.log('  按 Ctrl+C 停止');
    console.log('─'.repeat(56));
  });
}

if (PROBE) probe().catch(err => { console.error(err.message); process.exit(1); });
else if (SET_ACCOUNT) setAccount().catch(err => { console.error(err.message); process.exit(1); });
else serve();

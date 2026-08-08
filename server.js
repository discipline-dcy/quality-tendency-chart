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
  // 全厂合计良品率的参考线。**它不是 KPI** —— 品质部考核表里质量类只有
  // 下面 targets 那四项，没有「全厂合计」这一档。这个数是「近 3 个月 7 日
  // 滚动良品率的 P75，向上取到 0.5」推算的，只用来给主趋势图一把标尺，
  // 前端不拿它做达标判定（顶部大数字标的是「非考核指标」）。
  target:    96.5,
  // ── 分类型目标线：季度 KPI ──────────────────────────────────
  //
  // 出处：品质部《考核指标》表，质量类 4 项、权重合计 40%。四个数按
  // Q1/Q2/Q3/Q4 排，逐季递增（考核表「考核目标值」列给的是 Q1 那档，
  // 分季度的值在备注列）。「质量周月报告工具」V1.2 的
  // QUARTER_TARGETS_BY_RANGE（该项目 src/main.jsx:44）用的是同一组数 ——
  // 它和本项目都是下游使用者，考核表才是源头。
  //
  // ⚠ 四项在考核表里全叫「**一次**合格率 / **一次**直通率」，即 first-pass：
  //   分子只认第一次检验判出的不良，返修后合格不回冲。指标名必须带「一次」，
  //   否则会被读成最终合格率。
  //
  // ⚠ 口径必须跟着数字一起搬，只搬数字会得到一条假的目标线：
  //   流水生产  对的是**一次直通率**（电检率 × 装配检率 × 流水检率），不是良品率。
  //             拿 90 去比良品率 95.9%，大屏会常年显示「远超目标」。
  //             考核表这行的公式栏写的是「同质量周报数据」—— 见下方 netDefect()
  //             的说明，本项目扣了「不计为不良数」而周报没扣，两边差约 0.6pt
  //   组件生产  对的是组件抽检巡检单的**合格数 ÷ 检验数**，数据来自
  //             GetComponentInspectionList，跟检验日报没关系
  //   成品改型 / 清分机  才是 1 − 不良数 ÷ 检验数
  //
  // ⚠ 考核表的公式栏写的是「**当月**合格数量/总数量」，而看板默认 14 天窗口。
  //   跨月时看板的数和考核的数不是一回事，大屏上已注明。
  //
  // ⚠ **按年分档，明年的数必须手动填。** 考核表是一年一发的，2027 年的
  //   目标只有品质部发了才知道。这里只内置 2026 那一档 ——
  //   跨到 2027 年而 config.json 里没填 2027，`targetFor()` 会返回 null，
  //   卡片上不画目标线、不判达标、看板顶部亮一条告警。
  //
  //   这是有意做成「响的」而不是「静的」：早先 quarterOf() 只看月份不看
  //   年份，2027-01-01 那天看板会不声不响地拿 2026 的 Q1 目标当今年的 KPI
  //   接着画，一条过期的线挂在车间墙上，没有任何迹象说明它过期了。
  //   宁可没有线，也不要一条假的线。
  //
  // 怎么填明年的：config.json 里写
  //   "targets": { "2027": { "流水生产": [.., .., .., ..], ... } }
  //   只写新增的年份就行，2026 这档会自动保留；同一年里只写要改的类型即可。
  //
  // 兼容：每个类型也接受一个标量（如 96.5），表示四个季度用同一个数。
  //
  // 类型名必须是 OA「检验类型」字段的原值，改了就查不到表。屏上显示的名字
  // 走下面的 TYPE_LABELS。
  targets: {
    // 2026：取自品质部《考核指标》表。Q1/Q2 已成过去，但 days 调大时
    // 窗口会回溯到，所以整年四档都留着
    2026: {
      '流水生产': [87,   88,   90,   92  ],   // 一次直通率，不是良品率
      '成品改型': [94,   95,   96,   98  ],
      '清分机':   [86,   89,   92,   95  ],
      '组件生产': [99.5, 99.6, 99.7, 99.7],   // 合格数 ÷ 检验数
    },
    // 2027 及以后：等品质部发新考核表，手动填进 config.json。
    // 这里**故意不留默认值** —— 留了就等于替品质部编一个 KPI
  },
  // 实测日检验量在 98 ~ 751 之间（单条 1~166），200 这个阈值会把一半的
  // 日子误标成「样本不足」。降到 50，接入后按实际检验量再调
  minSample: 50,
  // 趋势图纵轴的硬地板：不管数据多好，纵轴一律画到这里，
  // 「离 90 还有多远」在图上就是同一把尺子。低于此值的日期标红。
  // 与 target 是两回事 —— target 是想达到的线（会随工序调），
  // 这个是不该跌破的线，跌破了必须一眼看见
  rateFloor: 90,
  topGroups: 6,         // 表格视图里产品维度显示前几个
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
    // 去掉 UTF-8 BOM 再 parse。JSON.parse 遇到 BOM 直接抛 SyntaxError，
    // 而 Windows 上很容易写出带 BOM 的文件（PowerShell 的
    // `Out-File -Encoding utf8` 在 5.1 里就默认加 BOM）。README 又明确
    // 让人「直接编辑 config.json」—— 踩中的结果是服务照常启动、
    // 看板显示「没配账号」，而账号明明填得好好的。实测踩过一次。
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
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
  return merged(raw);
}

// targets 现在是「年 → 类型 → 四个季度」两层嵌套，必须逐层合并：
//   只合一层 → config.json 里写了 2027，2026 那一档整个没了；
//   只合两层的外层 → 2027 里只写「流水生产」，同年其余三个类型没了。
// 两处都会让卡片静默地失去目标线，所以两层都合。
function mergeTargets(base, raw) {
  const out = {};
  for (const y of Object.keys(base)) out[y] = { ...base[y] };
  if (!raw || typeof raw !== 'object') return out;

  // 兼容老写法：config.example.json 早先给的是不分年的「类型 → 四季度」。
  // 键不是四位年份就当它是老格式，归到 2026 那一档，并提醒改过来 ——
  // 悄悄接受一个含义已经变了的配置，比直接报错更难查。
  const looksLikeYear = k => /^\d{4}$/.test(k);
  if (Object.keys(raw).length && !Object.keys(raw).some(looksLikeYear)) {
    console.warn('⚠ config.json 的 targets 是老格式（不分年份）。已按 2026 那一档读入。');
    console.warn('  新格式是 "targets": { "2026": { "流水生产": [..] } }，目标线现在按年分档，');
    console.warn('  明年的数要手动填。详见 config.example.json。');
    out[2026] = { ...(out[2026] || {}), ...raw };
    return out;
  }

  for (const y of Object.keys(raw)) {
    if (!looksLikeYear(y)) {
      console.warn(`⚠ config.json 的 targets 里有个键「${y}」不是四位年份，已忽略。`);
      continue;
    }
    out[y] = { ...(out[y] || {}), ...raw[y] };
  }
  return out;
}

function merged(raw) {
  const out = { ...DEFAULTS, ...raw, ...envOverrides() };
  out.targets = mergeTargets(DEFAULTS.targets, raw && raw.targets);
  return out;
}

let cfg = loadConfig();

// 写回时保留文件里已有的其它设置（days / target / 注释字段等），只覆盖传进来的键
function saveConfig(patch) {
  let raw = {};
  // 这里也要去 BOM：读失败会被当成「首次创建」，把文件里已有的
  // days / target / targets 全部悄悄丢掉
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '')); } catch { /* 首次创建 */ }
  const next = { ...raw, ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  cfg = merged(next);
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

  // ── 接口 4 的「不计为不良」──────────────────────────────────
  // 质量周月报告工具的 README 第 63 行写的是「问题分类包含『不计入不良』
  // 的异常不计入不良数」，它的实现（main.jsx:287）也确实在查问题分类。
  // 但 2026-08-07 实测近 90 天 939 条异常，问题分类只有 6 个取值
  // （物料/设计/装配/工艺/误判漏检/空），**一条「不计入不良」都没有** ——
  // 那条规则在真实数据上是死代码。
  //
  // 真正在起作用的是接口 4 里一个文档没提的数值字段「不计为不良数」：
  // 近 90 天 40 条非零、合计 151 件，全落在流水生产上（+0.60pt）。
  // 所以两条都实现：数值字段为主，问题分类为辅，哪天录入规范改了都不会漏。
  notCounted:  ['不计为不良数', 'NotCountedQty', 'notCountedQty'],
  category:    ['问题分类', 'ProblemCategory', 'problemCategory'],

  // ── 接口 66 组件抽检巡检单列表 ───────────────────────────────
  // 字段名于 2026-08-07 实测确认，与接口文档一致
  compMethod:  ['检验方式'],
  compDate:    ['抽检巡检时间'],
  compQty:     ['检验数'],
  compQual:    ['合格数'],
  compDefect:  ['不良数'],
  compModel:   ['组件型号'],
  compName:    ['组件名称'],
};

// 「不计为不良」的净不良数。两条规则叠加：
//   ① 问题分类含「不计入不良」→ 整条不计（README 第 63 行的字面规则）
//   ② 扣掉「不计为不良数」字段（真实数据里唯一在起作用的那条）
// 夹到 0 以上：实测有「不良 1 / 不计为不良 1」整条抵消的记录，
// 万一哪天不计为不良数填得比不良数还大，负数会把良品率算到 100% 以上。
//
// ⚠ 未决：这条口径和考核不一致。品质部考核表里「流水一次直通率」的公式栏
//   写的是「同质量周报数据」，即以周报的数为准；而报告工具 V1.2 的
//   isExcludedDefect 只查问题分类（真实数据里恒为 false），**没有扣**规则 ②
//   那 151 件 —— 它们近 90 天全落在流水生产上。结果是本项目算出来的流水
//   比周报高约 0.60pt，而考核认周报那个数。
//   两条路，都得品质部拍板：① 认可本项目的修正，同步改 V1.2；
//   ② 大屏跟周报走（即去掉规则 ②，明知多算 151 件也照算）。
//   在拍板之前保留现状（扣），因为多算不良数比少算更保守。
function netDefect(row) {
  if (String(pick(row, FIELDS.category) ?? '').includes('不计入不良')) return 0;
  return Math.max(num(pick(row, FIELDS.defectAbn)) - num(pick(row, FIELDS.notCounted)), 0);
}

// 组件的不良数：接口自带的「不良数」字段不可信 —— 实测近 90 天 1807 条里
// 有 2 条对不上（如 ID=19214 检验 1 / 合格 0 / 不良 0），字段合计 12 件而
// 检验数−合格数 合计 17 件。报告工具 main.jsx:283 也是这么兜的。
function compDefectOf(row) {
  return Math.max(
    num(pick(row, FIELDS.compDefect)),
    num(pick(row, FIELDS.compQty)) - num(pick(row, FIELDS.compQual)),
    0,
  );
}

// ── 流水三环节 ───────────────────────────────────────────────
// 匹配规则照抄质量周月报告工具 main.jsx:423-427，连「流水检」要排掉
// 电检/装检/装配 的那个否定条件一起。判定串是「检验类型 + 检出位置」，
// 因为异常侧的环节信息经常只写在检出位置里（README 第 68 行）。
const FLOW_STAGES = [
  { id: 'electrical', label: '电检',   matches: v => v.includes('电检') },
  { id: 'assembly',   label: '装配检', matches: v => v.includes('装检') || v.includes('装配') },
  { id: 'line',       label: '流水检', matches: v => v.includes('流水检') ||
      (v.includes('流水') && !v.includes('电检') && !v.includes('装检') && !v.includes('装配')) },
];
const stageKey = row => `${pick(row, FIELDS.type) ?? ''} ${pick(row, FIELDS.position) ?? ''}`;

// ── 录入写法归一 ─────────────────────────────────────────────
// 同一个检验环节在 OA 里有好几种写法。人一眼看出是一回事，程序看不出来 ——
// 不归一的话分子分母就对不上，那些不良会被体检报成「有分子没分母」，
// 而它们其实有分母，只是两边名字没写成一样。
//
// 「点币」「点币检」「清分机点币」是同一个环节（2026-08-08 需求方确认）。
// 录入规范短期内统一不了，报表这边先自己吃掉这个差异 —— 让看板去等一个
// 永远不会来的「大家都改成一种写法」，不如现在就把数出对。
//
// 只作用于**检出位置**，不碰检验类型：类型是目标线和卡片分组的查表键，
// 归一它会让「清分机」查不到 KPI。
const POSITION_ALIASES = [
  { canon: '点币', test: s => s.includes('点币') },
];
function canonPosition(v) {
  const s = String(v ?? '').replace(/\s+/g, '');
  if (!s) return '';
  const hit = POSITION_ALIASES.find(a => a.test(s));
  return hit ? hit.canon : s;
}

// 互检没有分母，不参与任何合格率（README 第 62 行），直通率同理
const isMutual = row => {
  const t = String(pick(row, FIELDS.type) ?? '');
  return `${t} ${pick(row, FIELDS.position) ?? ''}`.includes('互检') || t.includes('其他生产');
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
    // 接口 66 是分页的：data 不是数组而是 {total,page,pageSize,list}
    if (Array.isArray(body.data?.list)) return body.data.list;
  }
  throw new Error(`${endpoint} 返回结构无法识别：${JSON.stringify(body).slice(0, 200)}`);
}

// ═══════════════════════════════════════════════════════════════
// 接口 66「组件抽检巡检单列表」
//
// 跟接口 4/5 三处不一样，所以不能复用 callOA：
//   ① POST + JSON body，不是 GET + query string
//   ② data 是 {total,page,pageSize,list}，不是数组
//   ③ 要翻页，pageSize 上限 500
// 实测近 14 天 499 条、近 90 天 2871 条 —— 14 天窗口一页就够，
// 但量是会长的，按 total 翻到底。
//
// 组件为什么要单独走一个接口：它压根不填检验日报。趋势图 README 里
// 「组件生产为什么没有检验日报」那条待确认项，答案就是这个 —— 组件的
// 分母在这张单子上，不在接口 5 里。
// ═══════════════════════════════════════════════════════════════
async function callComponentOA(startDate, endDate, creds = cfg) {
  const url = `${cfg.baseUrl}/GetComponentInspectionList`;
  const safe = `${url}（${startDate} ~ ${endDate}）`;
  const out = [];
  let page = 1;

  while (true) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
        // 密码在 body 里，所以这个对象绝不能进日志或报错
        body: JSON.stringify({
          userCode: creds.userCode, password: creds.password,
          startDate, endDate, page, pageSize: 500,
        }),
      });
    } catch (err) {
      throw new Error(`连不上 OA（${safe}）：${err.message}`);
    }
    if (!res.ok) throw new Error(`GetComponentInspectionList HTTP ${res.status} — ${safe}`);

    const body = await res.json();
    if (Number(body?.code) !== 0) {
      throw new Error(`GetComponentInspectionList 返回 code=${body?.code}：${body?.message || '无错误信息'}`);
    }
    const list = body?.data?.list;
    if (!Array.isArray(list)) {
      throw new Error(`GetComponentInspectionList 返回结构无法识别：${JSON.stringify(body).slice(0, 200)}`);
    }
    out.push(...list);

    const total = Number(body?.data?.total ?? out.length);
    if (!list.length || out.length >= total) break;
    // 兜底：total 万一是错的，别把 OA 打爆 —— 接口文档明确要求避免影响 OA 服务
    if (++page > 40) {
      console.warn(`⚠ 组件接口翻到第 40 页仍未取完（total=${total}），先用已取到的 ${out.length} 条`);
      break;
    }
  }
  return out;
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

// ── 季度 KPI 取值 ─────────────────────────────────────────────
// 质量周月报告工具是按周期（周/月）落季度（main.jsx:240 targetRateForPeriod），
// 趋势图是按日 —— 同一套逻辑，粒度换成天。
// 按「年 + 季度」两级查：考核表一年一发，年份不对就不是这一年的 KPI。
function quarterOf(day) {
  const m = Number(String(day).slice(5, 7));
  return Number.isFinite(m) ? Math.min(3, Math.max(0, Math.floor((m - 1) / 3))) : 0;
}
function yearOf(day) {
  return String(day).slice(0, 4);
}

// 查不到返回 null，**不退回 cfg.target**。
// 早先这里兜底到 96.5，两个后果都很坏：① 跨年之后每张卡都悄悄换成一条
// 推算的全厂参考线，看着仍是「目标 96.5%」，没人知道 KPI 已经过期；
// ② 哪天多出一个新检验类型，它也会凭空得到一条目标线。
// 没有 KPI 就是没有 KPI，让它显示「目标未设」比编一个数诚实。
function targetFor(key, day) {
  const row = cfg.targets && cfg.targets[yearOf(day)];
  if (!row) return null;
  const t = row[key];
  if (Array.isArray(t)) {
    const v = t[quarterOf(day)];
    return typeof v === 'number' ? v : null;
  }
  return typeof t === 'number' ? t : null;
}

// 区间里哪些年份没配目标。14 天窗口跨年时会同时含两个年份，
// 所以按区间里真实出现的年份算，不是只看「今年」。
function missingTargetYears(allDays) {
  const years = [...new Set(allDays.map(yearOf))];
  return years.filter(y => !cfg.targets || !cfg.targets[y]).sort();
}

// OA「检验类型」的原值 → 屏上显示的名字。只影响显示：目标线查表、
// 分组聚合一律走原值。加这一层是因为考核表里写的是「硬币清分机」，
// 而 OA 里录的是「清分机」—— 大屏上的名字跟考核表对不上，
// 班组长就没法把屏上的数和自己的考核指标对起来。
const TYPE_LABELS = {
  '清分机': '硬币清分机',
};
const labelOf = key => TYPE_LABELS[key] || key;

// 指标名。考核表四项全是「一次」口径（first-pass），少了这两个字
// 会被读成最终合格率 —— 两个指标标错了，会误导所有看的人。
const METRIC_LABELS = {
  fpy:   '一次直通率',   // 流水：电检率 × 装配检率 × 流水检率
  pass:  '一次合格率',   // 组件：合格数 ÷ 检验数
  yield: '一次合格率',   // 改型 / 清分机：1 − 不良数 ÷ 检验数
};

function aggregate(daily, abnormal, component, allDays) {
  const byDay = new Map(allDays.map(d => [d, { qty: 0, defect: 0, crossDefect: 0 }]));
  const byProduct = new Map();
  const byType = new Map();

  // 「检验类型」是看板的主分组维度：流水生产 / 成品改型 / 清分机 / 组件生产。
  // 选它而不是产品代码，是因为**两个接口都有这个字段**，分子分母能对齐；
  // 而且它回答的正是班组长真正要问的那句「哪条线拖的后腿」——
  // 产品代码回答的是「哪个机型不良多」，那是品质工程师的问题，不是他的。
  const typeOf = row => String(pick(row, FIELDS.type) ?? '').trim() || '未标注';

  const touchType = key => {
    if (!byType.has(key)) {
      byType.set(key, {
        key, qty: 0, defect: 0,
        byDay: new Map(allDays.map(d => [d, { qty: 0, defect: 0 }])),
      });
    }
    return byType.get(key);
  };

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

  // 分子分母的记录集合对不对得齐，看「检验类型 + 检出位置」这个组合。
  // 检出位置走归一（点币 / 点币检 / 清分机点币 算同一个），否则光是写法不同
  // 就会让 22 件本来对得上的不良被报成「分母未覆盖」
  const comboOf = row =>
    `${pick(row, FIELDS.type) ?? '(空)'} / ${canonPosition(pick(row, FIELDS.position)) || '(空)'}`;
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

    const T = touchType(typeOf(row));
    T.qty += qty;
    T.byDay.get(day).qty += qty;

    const code = String(pick(row, FIELDS.product) ?? '未标注');
    const p = touchProduct(code, pick(row, FIELDS.stockClass));
    p.qty += qty;
    p.byDay.get(day).qty += qty;
  }

  // 分子：接口 4 检验异常录入
  let abnDefect = 0;
  let notCountedTotal = 0;      // 被「不计为不良」扣掉的件数，体检里要报出来
  for (const row of abnormal) {
    const day = toDay(pick(row, FIELDS.date));
    if (!day || !byDay.has(day)) continue;
    const def = netDefect(row);
    notCountedTotal += num(pick(row, FIELDS.defectAbn)) - def;
    byDay.get(day).defect += def;
    abnDefect += def;

    // 这条不良所在的检验环节，分母那边根本没有对应记录 → 记下来
    const combo = comboOf(row);
    if (def > 0 && !denomCombos.has(combo)) orphan.set(combo, (orphan.get(combo) || 0) + def);

    const T = touchType(typeOf(row));
    T.defect += def;
    T.byDay.get(day).defect += def;

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

  // ── 小倍数：按检验类型 ───────────────────────────────────────
  //
  // 三件事在这里决定，每件都有实测依据（近 90 天）：
  //
  // 1. **没有分母的类型不给卡片。** 组件生产 6 个月只有 1 条异常记录、
  //    3 件不良，分母一条都没有 —— 给它一张卡，那张卡永远是空的，
  //    大屏上常年挂个「无数据」比不挂更糟。它归进口径提示条。
  //
  // 2. **样本撑不起趋势的类型不画折线。** 清分机日均只有 7 件，远低于
  //    minSample。实测它的 7 日滚动率在 -57% ~ 100% 之间乱跳，画成折线
  //    是在把噪声当信号卖。这类改成 mode:'sparse'，前端只画散点不连线 ——
  //    点是实测到的事实，线是我们编出来的。
  //
  // 3. **当天日报一条都没有、异常却记了不良的日子要单独记账。** 实测
  //    流水 6 天 54 件、改型 5 天 12 件、清分机 5 天 32 件。这些不良
  //    没有分母可配，会被静默地排除在所有比率之外，必须报出来。
  const median = arr => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  };
  const lastDay = allDays[allDays.length - 1];

  // ── 流水直通率 ───────────────────────────────────────────────
  //
  // 流水的 KPI 对的是**直通率**，不是良品率（README 第 66 行，实现见
  // 质量周月报告工具 main.jsx:506-509）。这是这次改动里最容易出错的一处：
  // 直接把季度 KPI 90 配到良品率 95.9% 上，大屏会常年显示「远超目标」，
  // 而真实的直通率是 84.9% —— 差 5.1pt，方向正好反过来。
  //
  // 三环节任一环节当天没有检验量，当天就算不出直通率，留空不连线。
  // **不套用报告工具 V1.2 那条「检验量和不良数均为 0 时按 100.00% 计算」**
  // —— 那条只用在机型直通率的表格里。日粒度下套它，某环节当天没排产
  // 就会被当成 100% 合格，直通率被系统性抬高，这比留空糟得多。
  //
  // 实测（2026-08-07，近 90 天）：62/90 天能算，缺的绝大多数是周日
  // —— 那天不生产，不是漏数据。
  const isFlowType = k => k.includes('流水') || k.includes('电检') || k.includes('装检') || k.includes('装配');
  const flowDay = new Map(allDays.map(d =>
    [d, Object.fromEntries(FLOW_STAGES.map(s => [s.id, { qty: 0, defect: 0 }]))]));
  const flowSum = Object.fromEntries(FLOW_STAGES.map(s => [s.id, { qty: 0, defect: 0 }]));

  for (const row of daily) {
    if (!isFlowType(typeOf(row)) || isMutual(row)) continue;
    const day = toDay(pick(row, FIELDS.date));
    if (!day || !flowDay.has(day)) continue;
    const k = stageKey(row), q = num(pick(row, FIELDS.qty));
    for (const s of FLOW_STAGES) if (s.matches(k)) { flowDay.get(day)[s.id].qty += q; flowSum[s.id].qty += q; }
  }
  for (const row of abnormal) {
    if (!isFlowType(typeOf(row)) || isMutual(row)) continue;
    const day = toDay(pick(row, FIELDS.date));
    if (!day || !flowDay.has(day)) continue;
    const k = stageKey(row), d = netDefect(row);
    for (const s of FLOW_STAGES) if (s.matches(k)) { flowDay.get(day)[s.id].defect += d; flowSum[s.id].defect += d; }
  }

  // 三个环节的率相乘。
  //
  // 早先是「任一环节无分母 → 当天整个不算」，太死了：电检的检验量只有
  // 4720，不到装配检（8669）和流水检（8721）的一半，很多天根本没有电检
  // 日报 —— 那些天流水明明在生产、也记了不良，却因为缺一个环节被整天丢掉，
  // 趋势线上一串断点。这是**日报录入**的问题，不该让报表跟着停摆。
  //
  // 改成：有数据的环节才相乘，一个环节都没有才返回 null。
  // 代价是环节不全的那天分母少了一层，直通率会偏高 —— 所以这种天必须标出来
  // （见下面的 flowThinDay），前端画成空心点，读者知道它和三环节齐全的
  // 那些点不是一把尺子。
  const fpyStagesOf = cell => FLOW_STAGES.filter(s => cell[s.id].qty > 0);
  const fpyOf = cell => {
    const live = fpyStagesOf(cell);
    if (!live.length) return null;
    const r = live.reduce((a, s) => a * (1 - cell[s.id].defect / cell[s.id].qty), 1);
    return +(r * 100).toFixed(1);
  };
  // 两种「这个点不可信」合并成一个标记，前端都画成空心：
  //   ① 某个环节样本太小 —— 实测有「当天流水共 186 件、但电检只做了 15 件」
  //      的日子，直通率被拉到 43.78%。按当日总量判它是达标样本，按环节判
  //      才看得出不可信。近 90 天 24/62 天属于这种。
  //   ② 环节不齐 —— 少乘一层，率天然偏高，不能和齐全的点直接比高低
  const flowThinDay = d => {
    const cell = flowDay.get(d);
    if (fpyStagesOf(cell).length && fpyStagesOf(cell).length < FLOW_STAGES.length) return true;
    return FLOW_STAGES.some(s => {
      const c = cell[s.id];
      return c.qty > 0 && c.qty < cfg.minSample;
    });
  };
  // 环节不齐的天数，报出来 —— 口径宽了就必须说清楚宽在哪，
  // 否则「流水的点变多了」会被当成产量变化
  const flowPartialDays = allDays.filter(d => {
    const n = fpyStagesOf(flowDay.get(d)).length;
    return n > 0 && n < FLOW_STAGES.length;
  }).length;
  const flowStages = FLOW_STAGES.map(s => ({
    id: s.id, label: s.label,
    qty: flowSum[s.id].qty, defect: flowSum[s.id].defect,
    rate: rateOf(flowSum[s.id].qty, flowSum[s.id].defect),
  }));
  const flowFpy = fpyOf(flowSum);

  const types = [];
  const typeOrphans = [];
  for (const T of byType.values()) {
    const active = allDays.filter(d => T.byDay.get(d).qty > 0);
    // 有不良、但整个区间一条分母都没有 → 算不出率，不给卡片
    if (!active.length) {
      if (T.defect > 0) typeOrphans.push({ name: T.key, defect: T.defect });
      continue;
    }
    const enough = active.filter(d => T.byDay.get(d).qty >= cfg.minSample).length;
    const flow = isFlowType(T.key);
    // 直通率能算出来的日子；流水的趋势线走这个，不走良品率
    const fpyDays = flow ? allDays.filter(d => fpyOf(flowDay.get(d)) !== null) : [];

    types.push({
      // 显示名（硬币清分机等），聚合和查表用的仍是 T.key
      name: labelOf(T.key),
      qty: T.qty,
      defect: T.defect,
      // 流水这张卡的主数字是一次直通率，其余类型是一次合格率。metric 让
      // 前端知道该把标题写成哪个 —— README 说得很清楚：两个指标标错了，
      // 会误导所有看的人。
      metric: flow ? 'fpy' : 'yield',
      metricLabel: flow ? METRIC_LABELS.fpy : METRIC_LABELS.yield,
      // 大数字用整个区间的累计率，不是最后一天的 —— 面板标题写的是多少天，
      // 数字就得是多少天的
      rate: flow ? flowFpy : rateOf(T.qty, T.defect),
      // 流水的良品率没有丢，降到副信息 —— 它仍然是「这条线坏了多少件」
      // 最直观的读法，只是不再是对标 KPI 的那个数
      yieldRate: rateOf(T.qty, T.defect),
      stages: flow ? flowStages : undefined,
      target: targetFor(T.key, lastDay),
      // 季度 KPI 会翻页。14 天窗口跨季度时目标线要走阶梯，否则跨过 9/30
      // 那天，达标判定会整体错一档
      targetSpark: allDays.map(d => targetFor(T.key, d)),
      // 多数有数据的日子都够样本，才配画趋势线
      mode: flow
        ? (fpyDays.length / Math.max(active.length, 1) >= 0.6 ? 'daily' : 'sparse')
        : (enough / active.length >= 0.6 ? 'daily' : 'sparse'),
      activeDays: active.length,
      medianQty: median(active.map(d => T.byDay.get(d).qty)),
      spark: flow
        ? allDays.map(d => fpyOf(flowDay.get(d)))
        : allDays.map(d => rateOf(T.byDay.get(d).qty, T.byDay.get(d).defect)),
      sparkQty: allDays.map(d => T.byDay.get(d).qty),
      // 哪些天的点不可信（流水按环节判，其余按当日总量判），前端画空心
      sparkThin: allDays.map(d => flow
        ? flowThinDay(d)
        : (T.byDay.get(d).qty > 0 && T.byDay.get(d).qty < cfg.minSample)),
      // 当天没有任何检验记录、却录了不良的件数
      noDenomDefect: allDays.reduce((s, d) => {
        const c = T.byDay.get(d);
        return s + (c.qty === 0 ? c.defect : 0);
      }, 0),
      lowSample: T.qty < cfg.minSample,
    });
  }

  // ── 组件生产：走接口 66，跟检验日报无关 ──────────────────────
  //
  // 组件不填检验日报（趋势图 README 那条「组件生产为什么没有检验日报」
  // 的待确认项，答案就是这个），它的分母在组件抽检巡检单上。
  // 口径照 质量周月报告工具 README 第 60 行：只统计「检验方式」含「组件」
  // 的记录，合格率 = 合格数 ÷ 检验数，按「抽检巡检时间」的日期归集。
  //
  // 实测（近 14 天 499 条）检验方式有 6 种：组件抽检/组件首检/组件全检/
  // 组件巡检 计入，流水巡检/成品首检 不计入 —— 后两种是这张单子上顺带
  // 记的别的工序，混进来会把组件的分母灌大。
  if (component && component.length) {
    const key = '组件生产';
    const byDayC = new Map(allDays.map(d => [d, { qty: 0, qual: 0, defect: 0 }]));
    let qty = 0, qual = 0, defect = 0, skipped = 0;
    for (const row of component) {
      if (!String(pick(row, FIELDS.compMethod) ?? '').includes('组件')) { skipped += 1; continue; }
      const day = toDay(pick(row, FIELDS.compDate));
      if (!day || !byDayC.has(day)) continue;
      const q = num(pick(row, FIELDS.compQty));
      const g = num(pick(row, FIELDS.compQual));
      const d = compDefectOf(row);
      const c = byDayC.get(day);
      c.qty += q; c.qual += g; c.defect += d;
      qty += q; qual += g; defect += d;
    }
    if (qty > 0) {
      // 组件保留两位小数，其余类型一位。不是不统一 —— 组件的 KPI 是 99.7，
      // 实测值常年在 99.9 以上，一位小数会把 99.97% 显示成 100%，
      // 那天明明有 1 件不良，屏上却是个满分。质量周月报告工具 V1.1
      // 「统一良率保留两位小数」也是同一个理由。
      const passOf = c => c.qty > 0 ? +(c.qual / c.qty * 100).toFixed(2) : null;
      const active = allDays.filter(d => byDayC.get(d).qty > 0);
      types.push({
        name: labelOf(key),
        qty, defect,
        metric: 'pass',
        metricLabel: METRIC_LABELS.pass,
        // 合格数 ÷ 检验数，不是 1 − 不良数 ÷ 检验数：实测两者差 5 件
        // （近 90 天 1807 条里 2 条对不上），以合格数为准
        rate: +(qual / qty * 100).toFixed(2),
        decimals: 2,
        qualified: qual,
        target: targetFor(key, lastDay),
        targetSpark: allDays.map(d => targetFor(key, d)),
        mode: active.length / Math.max(allDays.length - 1, 1) >= 0.6 ? 'daily' : 'sparse',
        activeDays: active.length,
        medianQty: median(active.map(d => byDayC.get(d).qty)),
        spark:    allDays.map(d => passOf(byDayC.get(d))),
        sparkQty: allDays.map(d => byDayC.get(d).qty),
        sparkThin: allDays.map(d => {
          const c = byDayC.get(d);
          return c.qty > 0 && c.qty < cfg.minSample;
        }),
        noDenomDefect: 0,
        lowSample: qty < cfg.minSample,
        source: '组件抽检巡检单',
        skippedRows: skipped,
      });
      // 接口 4 里那几件「组件生产」不良，现在有分母了，不该再报成孤儿
      for (let i = typeOrphans.length - 1; i >= 0; i--) {
        if (typeOrphans[i].name.includes('组件')) typeOrphans.splice(i, 1);
      }
    }
  }

  types.sort((a, b) => b.qty - a.qty);

  // 表格视图仍保留产品维度：按检验类型分组回答「哪条线」，
  // 按产品代码分组回答「哪个机型」—— 后者信息没丢，只是从主视觉降到表格里
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
    series, types, groups,
    flowStages,
    flowFpy,
    audit: {
      dailyOwnDefect,                                        // 日报自己填的不良合计
      abnormalDefect: abnDefect,                             // 当前分子
      notCountedDefect: notCountedTotal,                     // 被「不计为不良」扣掉的
      orphanDefect: orphanList.reduce((s, [, v]) => s + v, 0),
      orphanCombos: orphanList.slice(0, 5).map(([k, v]) => `${k} → ${v} 件`),
      // 整个类型都没有分母（如「组件生产」），连一张卡片都撑不起来
      orphanTypes: typeOrphans.sort((a, b) => b.defect - a.defect),
      // 有分母的类型里，落在「当天日报一条没有」的那些日子上的不良
      noDenomDefect: types.reduce((s, t) => s + t.noDenomDefect, 0),
      // 流水三环节没凑齐的天数。这些天的直通率少乘一层，偏高
      flowPartialDays,
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
// 录入噪声的容忍线：占分母 0.5% 以内不点亮告警条。
//
// 早先是零容忍 —— 只要有 1 件对不上就亮黄条。车间的录入不可能一件不差，
// 结果是告警条**常年亮着**，然后就没人看它了。一个永远亮的灯等于没有灯。
// 数字照常算、照常在表格里能查到，只是不再打断读者。
const AUDIT_TOLERANCE_PCT = 0.5;

function auditRatio(audit, totalQty) {
  const { orphanDefect, orphanCombos, abnormalDefect, dailyOwnDefect,
          orphanTypes, noDenomDefect, notCountedDefect, flowPartialDays } = audit;
  const pct = totalQty > 0 ? +(orphanDefect / totalQty * 100).toFixed(2) : 0;
  const noDenomPct = totalQty > 0 ? +(noDenomDefect / totalQty * 100).toFixed(2) : 0;

  // 整类没有分母仍然从严：那不是录入笔误，是一条线压根没做检验日报，
  // 它会让一整张卡片消失，必须有人知道。
  // 前两类是录入精度问题，走容忍线。
  const ok = pct <= AUDIT_TOLERANCE_PCT
          && noDenomPct <= AUDIT_TOLERANCE_PCT
          && !orphanTypes.length;

  // 三种「有分子没分母」分开说，因为该找的人不一样：
  //   环节对不上 → 检出位置的写法不统一，找录入规范
  //   整类无分母 → 这条线根本没做检验日报，找那条线的班组长
  //   当天无日报 → 日报漏填或补录延迟，找当天的检验员
  const parts = [];
  if (orphanDefect > 0) {
    parts.push(`分子里有 ${orphanDefect} 件不良（占分母 ${pct}%）来自分母未覆盖的检验环节：${orphanCombos.join('；')}`);
  }
  if (orphanTypes && orphanTypes.length) {
    parts.push(`${orphanTypes.map(t => `「${t.name}」${t.defect} 件`).join('、')}整个区间没有任何检验日报，` +
               '算不出良品率，已不单独列卡片');
  }
  if (noDenomDefect > 0) {
    parts.push(`另有 ${noDenomDefect} 件不良落在「当天日报一条都没有」的日子上，这些不良不计入任何比率`);
  }

  return {
    ...audit,
    orphanPct: pct,
    ok,
    // 流水环节不齐的天数单独一条：它和上面几条方向相反 ——
    // 那些天少乘一层，直通率偏**高**，不说清楚会被当成产线变好了
    partialNote: flowPartialDays > 0
      ? `流水有 ${flowPartialDays} 天三个环节没凑齐（多半是电检日报没填），`
        + '这些天按已有环节相乘，直通率偏高，图上画成空心点。'
      : null,
    note: ok
      ? (pct > 0 || noDenomDefect > 0
          ? `分子分母基本对得齐（${orphanDefect + noDenomDefect} 件差异，占分母 `
            + `${(pct + noDenomPct).toFixed(2)}%，在 ${AUDIT_TOLERANCE_PCT}% 的录入噪声容忍线内）`
          : '分子的检验环节都能在分母里找到对应记录')
      : parts.join('。') + '。以上都会把良品率算低。',
    hint: dailyOwnDefect < abnormalDefect * 0.6
      ? `另注：日报自带的「不良数量」只有 ${dailyOwnDefect} 件，远少于异常录入的 ${abnormalDefect} 件，` +
        '说明日报那个字段基本没人填 —— 用异常录入当分子是对的。'
      : null,
    // 这条跟上面几条性质不同：不是数据缺陷，是**有意排除**，会把良品率算高。
    // 排除动作本身不该是隐形的，否则看板上的数跟 OA 里的原始不良数对不上，
    // 而没人知道差在哪
    notCountedNote: notCountedDefect > 0
      ? `已按「不计为不良数」字段扣除 ${notCountedDefect} 件不良，未计入良品率。`
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
  const [daily, abnormal, component] = await Promise.all([
    callOA('InspectionDailyReportList', startDate, endDate),   // 分母
    callOA('ProductionInspectionList', startDate, endDate),    // 分子
    // 组件走它自己的单子。这一路失败不能拖垮整块看板 —— 大屏是无人值守的，
    // 少一张组件卡片总比整屏报错强，所以单独 catch，把失败降级成一条提示。
    callComponentOA(startDate, endDate).catch(err => {
      console.warn(`⚠ 组件抽检巡检单读取失败，本次不出组件卡片：${err.message}`);
      return null;
    }),
  ]);

  if (!daily.length) throw new Error(`检验日报列表在 ${startDate} ~ ${endDate} 没有数据`);

  const { series, types, groups, flowStages, flowFpy, audit } =
    aggregate(daily, abnormal, component, allDays);

  const withData = series.filter(s => s.output > 0);
  const latest = withData[withData.length - 1] || null;
  const prev = withData[withData.length - 2] || null;
  const totalQty = withData.reduce((s, d) => s + d.output, 0);
  const totalDef = withData.reduce((s, d) => s + d.defect, 0);

  return {
    updatedAt: new Date().toISOString(),
    range: `${startDate} ~ ${endDate}`,
    target: cfg.target,
    // 全厂合计那条线在考核表里没有对应档位（质量类只有四项，见 DEFAULTS.target）。
    // 前端据此把它画成「参考」而不是「目标」，顶部大数字也不做达标判定 ——
    // 拿一条推算线去给一个混合口径的数打红绿灯，红绿灯本身就是假的。
    targetIsKpi: false,
    // 区间里没配目标线的年份。非空时前端亮告警条，并把受影响的卡片标成
    // 「目标未设」。看板最怕的不是缺一条线，是缺了没人知道
    targetYearsMissing: missingTargetYears(allDays),
    minSample: cfg.minSample,
    rateFloor: cfg.rateFloor,
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
    types,          // 小倍数主视觉：按检验类型（流水生产 / 成品改型 / 清分机 / 组件生产）
    groups,         // 表格视图备查：按产品代码
    // 流水直通率的三个环节，给表格视图和「哪个环节拖后腿」用。
    // 实测电检是瓶颈：合格率最低，检验量还不到另两个环节的一半
    flowStages,
    flowFpy,
    crossCheck: auditRatio(audit, totalQty),
    counts: {
      日报记录: daily.length,
      异常记录: abnormal.length,
      组件记录: component ? component.length : 0,
    },
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

  // 组件走 POST + 分页，跟上面两个不是一套，单独探
  try {
    const rows = await callComponentOA(from, today);
    console.log(`── 接口66 组件抽检巡检单列表（GetComponentInspectionList）: ${rows.length} 条`);
    if (rows.length) {
      console.log('   真实字段名：', Object.keys(rows[0]).join(', '));
      // 检验方式决定哪些记录计入组件合格率（只要含「组件」的），
      // 这张单子上还混着流水巡检、成品首检 —— 分布不对时这里最先看出来
      const methods = new Map();
      for (const r of rows) {
        const m = String(pick(r, FIELDS.compMethod) ?? '(空)');
        methods.set(m, (methods.get(m) || 0) + 1);
      }
      console.log('   检验方式分布：');
      for (const [m, n] of [...methods].sort((a, b) => b[1] - a[1])) {
        console.log(`     ${m}  ${n} 条  ${m.includes('组件') ? '← 计入' : '← 不计入（检验方式不含「组件」）'}`);
      }
      console.log('   第一条：', JSON.stringify(rows[0], null, 2).replace(/\n/g, '\n   '));
    }
  } catch (err) {
    console.log(`── 接口66 组件抽检巡检单列表失败：${err.message}`);
  }
  console.log();

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
    // 目标线按年分档，明年的数要手动填。跨年那天如果没填，看板上四张卡
    // 会一起失去目标线 —— 与其等大屏出问题被人发现，不如每次启动就提醒。
    // 提前一个季度开始念叨：Q4 就该去催品质部要明年的考核表了。
    const thisYear = String(new Date().getFullYear());
    const nextYear = String(new Date().getFullYear() + 1);
    if (!cfg.targets || !cfg.targets[thisYear]) {
      console.log('');
      console.log(`  ⚠ ${thisYear} 年的目标线没配！卡片上不会画目标线，也不判达标。`);
      console.log(`    在 config.json 里填：  "targets": { "${thisYear}": { "流水生产": [.., .., .., ..], ... } }`);
    } else if (new Date().getMonth() >= 9 && !cfg.targets[nextYear]) {
      console.log('');
      console.log(`  ⚠ 快跨年了，${nextYear} 年的目标线还没配。`);
      console.log(`    到 1 月 1 日那天四张卡会一起失去目标线 —— 趁早找品质部要明年的考核表。`);
    }
    console.log('  按 Ctrl+C 停止');
    console.log('─'.repeat(56));
  });
}

if (PROBE) probe().catch(err => { console.error(err.message); process.exit(1); });
else if (SET_ACCOUNT) setAccount().catch(err => { console.error(err.message); process.exit(1); });
else serve();

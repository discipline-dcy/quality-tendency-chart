// ═══════════════════════════════════════════════════════════════
// 导出离线快照
//
// 把 /api/quality 的数据烤进 quality-maxhub.html，产出一个自包含的
// quality-snapshot.html —— 拷到 U 盘插上大屏，用系统自带的「HTML 查看程序」
// 点开就是完整看板。不需要浏览器、不需要服务器、不需要同一个 Wi-Fi、
// 不用碰防火墙。
//
// 用法（server.js 要先在跑）：
//   node export-snapshot.js
//   node export-snapshot.js --port 3200 --out 质量趋势_20260730.html
//
// 代价：数据是导出那一刻的，不会自己更新。开会前重新跑一次就行。
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = arg('port', '3200');
const SRC = path.join(__dirname, 'quality-maxhub.html');
// resolve 而不是 join：--out 给绝对路径时要落在那个绝对位置
// （join 会拼成 C:\项目\C:\temp\x.html 这种废路径），
// 给相对路径时仍然按项目目录解析
const OUT = path.resolve(__dirname, arg('out', 'quality-snapshot.html'));

// 注入点：主 script 之前。锚在第一个 <script> 上，找不到就明确报错，
// 不做「猜一个位置插进去」这种事 —— 静默产出一个坏文件比直接失败糟得多
const ANCHOR = '<script>';

// JSON 塞进 <script> 里有两个真实的坑：
//   1. 数据里出现 </script> 会提前闭合标签
//   2. U+2028 / U+2029 在旧 JS 引擎里算换行，会造成语法错误
// 把 < 和这两个字符转成转义序列，JSON 语义不变，解析器也不会被骗
function embed(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}`;
}

(async () => {
  const url = `http://127.0.0.1:${PORT}/api/quality`;

  let data;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (body.needSetup) {
        console.error(`✗ 还没配 OA 账号，导出的会是示例数据。`);
        console.error(`  先打开 http://localhost:${PORT}/setup 登录一次，再回来导出。`);
      } else {
        console.error(`✗ 接口报错 HTTP ${res.status}：${body.error || '未知'}`);
      }
      process.exit(1);
    }
    data = body;
  } catch (e) {
    console.error(`✗ 连不上 ${url}`);
    console.error(`  server.js 在跑吗？先另开一个终端 \`node server.js\`。`);
    console.error(`  （${e.message}）`);
    process.exit(1);
  }

  let html;
  try {
    html = fs.readFileSync(SRC, 'utf8');
  } catch (e) {
    console.error(`✗ 读不到 ${SRC}：${e.message}`);
    process.exit(1);
  }

  const at = html.indexOf(ANCHOR);
  if (at === -1) {
    console.error(`✗ 在 quality-maxhub.html 里找不到 ${ANCHOR}，模板结构变了。`);
    console.error(`  export-snapshot.js 的注入锚点需要跟着改。`);
    process.exit(1);
  }

  data.snapshotAt = stamp(new Date());
  // 数据产生的时刻和导出的时刻不是一回事：服务端向 OA 取数有 5 分钟缓存，
  // 两者正常会差几分钟。横幅上要报的是前者 —— 报导出时刻等于虚报新鲜度，
  // 而那条横幅存在的唯一目的就是说清楚数据有多旧
  data.dataAt = data.updatedAt ? stamp(new Date(data.updatedAt)) : null;

  const inject = `<script>\n// 离线快照数据，由 export-snapshot.js 生成于 ${data.snapshotAt}\nvar SNAPSHOT = ${embed(data)};\n</script>\n`;
  fs.writeFileSync(OUT, html.slice(0, at) + inject + html.slice(at), 'utf8');

  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`✓ 已导出 ${path.basename(OUT)}（${kb} KB，自包含）`);
  console.log(`  数据截止 ${data.dataAt || '未知'}（导出于 ${data.snapshotAt}）`);
  if (data.summary) {
    console.log(`  良品率 ${data.summary.rate}% · 不良 ${data.summary.defect} 件 · ${data.range}`);
  }
  console.log(`  拷到 U 盘插上大屏，直接点开即可。`);
})();

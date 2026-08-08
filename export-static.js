// ═══════════════════════════════════════════════════════════════
// 导出零 JS 静态看板
//
// 为什么要有这个：MAXHUB 自带的「HTML 查看程序」关掉了 JavaScript
// （实测：JS 不执行、SVG 画不出来、fetch 不发），而大屏上又没有可用的
// 浏览器。于是走这条路 —— 在这台电脑上用 Edge 无头模式把页面真正渲染
// 一遍，把渲染完的 DOM 存成纯静态 HTML：数字是文本，图表是 SVG 标签，
// 一行 JS 都不需要。
//
// 关键点是不重写渲染逻辑。renderTrend / renderDefects / renderTable 那几百行
// 继续由真正的 Chromium 执行，只有一份实现。另写一份 Node 版迟早会和
// 浏览器版算出不一样的结果，那种偏差最难发现。
//
// 用法（server.js 要先在跑）：
//   node export-static.js
//   node export-static.js --width 3840 --height 2160
//   node export-static.js --out 质量趋势_20260730.html
//
// --width/--height 是「大屏那个查看器的 CSS 视口尺寸」，不是面板物理分辨率。
// 不确定就用默认 1920x1080，然后看产出文件在大屏上的表现：
//   版面偏小、四周留黑边  → 实际视口比 1920x1080 大，把参数调大
//   版面溢出、下面被切掉  → 实际视口更小，把参数调小
// 支持 CSS min() 的内核（Chromium 79+）会自己算，不受这个参数影响。
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const W = parseInt(arg('width', '1920'), 10);
const H = parseInt(arg('height', '1080'), 10);
// resolve 而不是 join：--out 给绝对路径时要落在那个绝对位置，
// 给相对路径时仍按项目目录解析
const OUT = path.resolve(__dirname, arg('out', 'quality-static.html'));

// 设计基准，必须和 quality-maxhub.html 里的 DESIGN_W / DESIGN_H / BASE 一致
const DESIGN_W = 1920, DESIGN_H = 1080;

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

function findEdge() {
  const hit = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!hit) {
    console.error('✗ 找不到 Edge。这一步需要一个 Chromium 内核来做渲染。');
    console.error('  找过：\n    ' + EDGE_CANDIDATES.join('\n    '));
    process.exit(1);
  }
  return hit;
}

// 无头渲染
// --headless=old：新版 headless 不输出 --dump-dom 的内容，实测拿到的是空
// --user-data-dir：不给独立 profile 的话会复用你日常那个，可能拿不到锁
// --virtual-time-budget：等页面把图画完再 dump
function renderDom(edge, fileUrl) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qtc-edge-'));
  try {
    return execFileSync(edge, [
      '--headless=old',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--user-data-dir=' + profile,
      '--window-size=' + W + ',' + H,
      '--virtual-time-budget=8000',
      '--dump-dom',
      fileUrl
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } finally {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
}

// ── 后处理 ──────────────────────────────────────────────────────

// 1. 删掉所有 script。设备上 JS 本来就不跑，留着只是白占约 30 KB；
//    而且万一换台 JS 开着的设备打开，重跑一遍逻辑纯属多余风险
function stripScripts(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

// 2. 根字号。fit() 把算好的绝对像素写在 <html style="font-size:Npx">，
//    那个值只对渲染时的视口正确。改成：
//      老内核  → 继续用烤死的 px（至少在基准尺寸下是对的）
//      新内核  → 用 min(vw, vh) 自己算，等价于 fit() 的第一趟
//    布局全是 rem，所以回缩比例（提示条占的那部分）在任何视口下同比例成立，
//    可以直接折进系数里
function fluidRootFontSize(html) {
  const m = /<html([^>]*?)\sstyle="font-size:\s*([\d.]+)px;?"/i.exec(html);
  if (!m) {
    console.warn('⚠ 没找到 <html> 上的 font-size，跳过自适应处理。');
    console.warn('  产出文件仍可用，但只在 ' + W + 'x' + H + ' 视口下版面正确。');
    return html;
  }
  const px = parseFloat(m[2]);
  const vw = (px / DESIGN_W * 100).toFixed(4);
  const vh = (px / DESIGN_H * 100).toFixed(4);

  const css = '<style>\n'
    + '/* 由 export-static.js 生成，复刻 fit() 的缩放 */\n'
    + 'html { font-size: ' + px + 'px; }\n'
    + '@supports (font-size: min(1vw, 1vh)) {\n'
    + '  html { font-size: min(' + vw + 'vw, ' + vh + 'vh); }\n'
    + '}\n'
    + '</style>\n';

  return html
    .replace(m[0], '<html' + m[1])
    .replace(/<\/head>/i, css + '</head>');
}

// 3. 页脚里两处对静态文件来说是假话，必须改掉：
//    「数据每 60 秒自动刷新」—— 静态文件不会刷新。原作者在注释里反复强调
//      「看板最危险的不是黑屏，是挂着两小时前的数字还没人发现」，
//      而这行字恰好会让人以为屏上的数是活的
//    「配置 OA 账号」—— fixSetupLinks() 在 file:// 下把它指向了服务器地址，
//      但大屏上既没浏览器、JS 也不跑，点了没有任何反应，是个死链
//    必须在删 script 之后跑，否则会误伤脚本源码里的同名字符串
function truthfulFooter(html) {
  let n = 0;
  const out = html.replace('数据每 60 秒自动刷新', () => {
    n++;
    return '静态导出 · 不会自动刷新';
  });
  // 这里原来还要剥掉页脚那个「配置 OA 账号」链接。该入口已从 quality-maxhub.html
  // 删除（账号改在服务端配：node server.js --set-account），页面现在一个 <a>
  // 都没有，这段替换匹配不到任何东西，删了。
  return { html: out, count: n };
}

// 4. SVG 尺寸。drawCharts() 按当时量到的容器大小写死了 width/height，
//    换个视口就和容器对不上。有 viewBox 就能交给浏览器自己缩，把写死的
//    像素换成百分比即可
function fluidSvgs(html) {
  let n = 0;
  const out = html.replace(/<svg\b[^>]*>/gi, (tag) => {
    if (!/viewBox=/i.test(tag)) return tag;
    if (!/\swidth="\d/.test(tag)) return tag;
    n++;
    return tag
      .replace(/\swidth="[^"]*"/i, ' width="100%"')
      .replace(/\sheight="[^"]*"/i, ' height="100%"');
  });
  return { html: out, count: n };
}

// ── 主流程 ──────────────────────────────────────────────────────

const edge = findEdge();
const tmpSnapshot = path.join(os.tmpdir(), 'qtc-snapshot-' + Date.now() + '.html');

// 先产出带数据的快照。复用 export-snapshot.js，不重复一遍取数和注入逻辑
try {
  const log = execFileSync(process.execPath, [
    path.join(__dirname, 'export-snapshot.js'), '--out', tmpSnapshot
  ], { encoding: 'utf8', cwd: __dirname });
  process.stdout.write(log);
} catch (e) {
  // export-snapshot.js 自己已经把原因打清楚了，不再叠一层
  if (e.stdout) process.stdout.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  process.exit(1);
}

if (!fs.existsSync(tmpSnapshot)) {
  console.error('✗ 快照文件没生成：' + tmpSnapshot);
  process.exit(1);
}
const snapshotPath = tmpSnapshot;

console.log('  用 Edge 渲染中（视口 ' + W + 'x' + H + '）…');
let dom;
try {
  // ?loop=0 关掉轮播再渲染。快照是要把 JS 剥光的静态页，轮播到哪一页就
  // 永远定格在哪一页 —— 不写死的话，导出结果取决于 virtual-time-budget
  // 和轮播间隔谁快谁慢，哪天调了其中一个，快照就会莫名其妙变成某个类型的
  // 放大页。定格在三张小图并排那页才是离线兜底该有的样子。
  //
  // ?static=1 让页面跳过所有交互控件（翻页按钮、目标线设置）。这个不能靠
  // 「控件是 JS 插的」来指望自动消失 —— 这里是先渲染再剥 JS，运行时插进
  // DOM 的东西照样会被烤进来，成了一排按不动的死按钮
  dom = renderDom(edge, pathToFileURL(snapshotPath).href + '?loop=0&static=1');
} catch (e) {
  console.error('✗ Edge 渲染失败：' + e.message);
  process.exit(1);
} finally {
  try { fs.rmSync(snapshotPath, { force: true }); } catch (e) {}
}

if (!dom || dom.trim().length < 1000) {
  console.error('✗ Edge 返回的 DOM 是空的或过短（' + (dom ? dom.length : 0) + ' 字节）。');
  console.error('  --headless=old 可能在这个 Edge 版本上失效了。');
  process.exit(1);
}

// 渲染是否真的跑了 —— 光看长度不够，静态骨架本身就有几万字节。
// 认「占位符有没有被换掉」：figRate 还是 -- 就说明 JS 没生效
const figRate = /id="figRate"[^>]*>([^<]*)</.exec(dom);
if (!figRate || figRate[1].trim() === '--' || figRate[1].trim() === '') {
  console.error('✗ 渲染没生效：figRate 仍是占位符「' + (figRate ? figRate[1] : '未找到') + '」。');
  console.error('  产出的会是一张空看板，已中止。');
  process.exit(1);
}

let html = stripScripts(dom);
html = fluidRootFontSize(html);
const ft = truthfulFooter(html);
html = ft.html;
if (ft.count < 2) {
  console.warn('⚠ 页脚只改到 ' + ft.count + '/2 处，文案可能变了，请核对产出文件的页脚。');
}
const sv = fluidSvgs(html);
html = sv.html;

fs.writeFileSync(OUT, html, 'utf8');

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
const paths = (html.match(/<path/g) || []).length;
const texts = (html.match(/<text/g) || []).length;
const rows = (html.match(/<tr/g) || []).length;

console.log('');
console.log('✓ 已导出 ' + path.basename(OUT) + '（' + kb + ' KB，零 JS）');
console.log('  良品率 ' + figRate[1].trim() + '  ·  图表 ' + paths + ' 个 path / ' + texts + ' 个标签  ·  表格 ' + rows + ' 行');
console.log('  已处理 ' + sv.count + ' 个 SVG 为可伸缩');
console.log('  拷到 U 盘插上大屏，用自带的 HTML 查看程序点开即可。');

/**
 * 商场智能导视系统 - 数据与「CAD 底图」生成器（零依赖）
 *
 * 运行：node tools/gen-seed.js            # 生成数据 + 底图；若 db.json 已存在会先备份再覆盖
 *       node tools/gen-seed.js --keep     # 保留现有 db.json（只更新示例与底图）
 *
 * 产出：
 *   public/uploads/plan_F1.svg … plan_F5.svg   CAD 风格楼层底图（蓝图底图，1000×700 视图）
 *   data/db.example.json                       示例数据（可提交）
 *   data/db.json                               运行时数据
 *
 * 关键：底图 SVG 与 shops/facilities/graph 使用**同一套坐标**（viewBox 0 0 1000 700，10px = 1m），
 *       因此前台把底图按 (0,0,1000,700) 精确铺满即可与业务图层像素级对齐。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'public', 'uploads');

/* ==================================================================
   一、字典
   ================================================================== */
const CAT_COLOR = {
  fashion_women: '#e8699a', fashion_men: '#4a7fe0', shoes: '#b06ad6', cosmetics: '#f06292',
  jewelry: '#37c2d6', sports: '#3aa76d', kids: '#f5a623', digital: '#5b6ce0',
  supermarket: '#f4a300', food: '#ef6c4d', dessert: '#e8a33d', drink: '#9c7b6b',
  entertainment: '#7e57c2', home: '#26a69a', beauty: '#ec407a', service: '#78909c', other: '#90a4ae'
};

const CATEGORIES = [
  { key: 'fashion_women', label: '女装', icon: '👗' },
  { key: 'fashion_men', label: '男装', icon: '👔' },
  { key: 'shoes', label: '鞋包', icon: '👠' },
  { key: 'cosmetics', label: '美妆', icon: '💄' },
  { key: 'jewelry', label: '珠宝腕表', icon: '💎' },
  { key: 'sports', label: '运动户外', icon: '👟' },
  { key: 'kids', label: '儿童亲子', icon: '🧸' },
  { key: 'digital', label: '数码家电', icon: '📱' },
  { key: 'supermarket', label: '超市便利', icon: '🛒' },
  { key: 'food', label: '餐饮美食', icon: '🍽️' },
  { key: 'dessert', label: '烘焙甜品', icon: '🍰' },
  { key: 'drink', label: '茶饮咖啡', icon: '☕' },
  { key: 'entertainment', label: '休闲娱乐', icon: '🎬' },
  { key: 'home', label: '家居生活', icon: '🛋️' },
  { key: 'beauty', label: '美容个护', icon: '💅' },
  { key: 'service', label: '生活服务', icon: '🛠️' },
  { key: 'other', label: '其他', icon: '📍' }
];
const catLabel = (k) => (CATEGORIES.find((c) => c.key === k) || { label: '其他' }).label;

// 中文首字母（用于 A-Z 索引）
const PY = {
  永: 'Y', 屈: 'Q', 名: 'M', 便: 'B', 小: 'X', 老: 'L', 美: 'M', 面: 'M', 星: 'X', 中: 'Z', 洗: 'X', 顺: 'S',
  丝: 'S', 雅: 'Y', 周: 'Z', 六: 'L', 喜: 'X', 皇: 'H', 太: 'T', 欧: 'O', 歌: 'G', 江: 'J', 百: 'B', 达: 'D',
  他: 'T', 都: 'D', 蕉: 'J', 海: 'H', 优: 'Y', 安: 'A', 乐: 'L', 巴: 'B', 华: 'H', 苹: 'P', 大: 'D', 西: 'X',
  外: 'W', 必: 'B', 麦: 'M', 云: 'Y', 万: 'W', 威: 'W', 汉: 'H'
};
function initial(name) {
  const s = String(name).trim();
  const m = s.match(/[A-Za-z]/);
  if (m) return s[m.index].toUpperCase();
  return PY[s[0]] || s[0].toUpperCase();
}

/* ==================================================================
   二、楼层与店铺规格（按真实商场业态分布）
   ================================================================== */
const FLOORS_SPEC = [
  {
    level: -1, name: '负一层', short: 'B1', theme: '精品超市 · 美食广场 · 生活服务', entrance: false,
    shops: [
      { name: '永辉超市', cat: 'supermarket' }, { name: '屈臣氏', cat: 'beauty' },
      { name: '名创优品', cat: 'home' }, { name: '便利蜂', cat: 'supermarket' },
      { name: '小米之家', cat: 'digital' }, { name: '老百姓大药房', cat: 'service' },
      { name: '美食广场', cat: 'food' }, { name: '面包新语', cat: 'dessert' },
      { name: '星巴克', cat: 'drink' }, { name: '中国移动营业厅', cat: 'service' },
      { name: '洗衣工坊', cat: 'service' }, { name: '顺丰驿站', cat: 'service' }
    ],
    extra: [{ type: 'parking', name: '地下停车场', x: 500, y: 545 }]
  },
  {
    level: 1, name: '一层', short: '1F', theme: '珠宝美妆 · 轻奢名品', entrance: true,
    shops: [
      { name: '丝芙兰', cat: 'cosmetics' }, { name: 'CHANEL 香奈儿', cat: 'cosmetics' },
      { name: '雅诗兰黛', cat: 'cosmetics' }, { name: '周大福', cat: 'jewelry' },
      { name: '老凤祥', cat: 'jewelry' }, { name: '六福珠宝', cat: 'jewelry' },
      { name: 'COACH 蔻驰', cat: 'fashion_women' }, { name: 'MICHAEL KORS', cat: 'fashion_women' },
      { name: '星巴克臻选', cat: 'drink' }, { name: '喜茶', cat: 'drink' },
      { name: '皇冠蛋糕', cat: 'dessert' }, { name: '屈臣氏', cat: 'beauty' }
    ],
    extra: [{ type: 'service', name: '客服中心', x: 430, y: 215 }, { type: 'atm', name: 'ATM 取款机', x: 620, y: 215 }]
  },
  {
    level: 2, name: '二层', short: '2F', theme: '时尚女装 · 鞋包内衣', entrance: false,
    shops: [
      { name: 'ONLY', cat: 'fashion_women' }, { name: 'VERO MODA', cat: 'fashion_women' },
      { name: '太平鸟女装', cat: 'fashion_women' }, { name: '欧时力', cat: 'fashion_women' },
      { name: '歌莉娅', cat: 'fashion_women' }, { name: '江南布衣', cat: 'fashion_women' },
      { name: '百丽', cat: 'shoes' }, { name: '达芙妮', cat: 'shoes' },
      { name: '星期六', cat: 'shoes' }, { name: '他她', cat: 'shoes' },
      { name: '都市丽人', cat: 'fashion_women' }, { name: '蕉内', cat: 'fashion_women' }
    ],
    extra: []
  },
  {
    level: 3, name: '三层', short: '3F', theme: '男装运动 · 儿童数码', entrance: false,
    shops: [
      { name: 'Jack&Jones', cat: 'fashion_men' }, { name: '海澜之家', cat: 'fashion_men' },
      { name: '太平鸟男装', cat: 'fashion_men' }, { name: '优衣库', cat: 'fashion_men' },
      { name: 'NIKE 耐克', cat: 'sports' }, { name: 'ADIDAS 阿迪达斯', cat: 'sports' },
      { name: '安踏', cat: 'sports' }, { name: '乐高 LEGO', cat: 'kids' },
      { name: '巴拉巴拉', cat: 'kids' }, { name: '华为体验店', cat: 'digital' },
      { name: '苹果授权店', cat: 'digital' }, { name: '大疆体验店', cat: 'digital' }
    ],
    extra: [{ type: 'nursing', name: '母婴室', x: 500, y: 215 }]
  },
  {
    level: 4, name: '四层', short: '4F', theme: '环球美食 · 影院娱乐', entrance: false,
    shops: [
      { name: '海底捞火锅', cat: 'food' }, { name: '西贝莜面村', cat: 'food' },
      { name: '外婆家', cat: 'food' }, { name: '必胜客', cat: 'food' },
      { name: '麦当劳', cat: 'food' }, { name: '云海肴', cat: 'food' },
      { name: '太二酸菜鱼', cat: 'food' }, { name: '万达影城', cat: 'entertainment' },
      { name: '大玩家', cat: 'entertainment' }, { name: '威尔士健身', cat: 'sports' },
      { name: '星巴克', cat: 'drink' }, { name: '喜茶', cat: 'drink' }
    ],
    extra: []
  }
];

/* ==================================================================
   三、版面几何（viewBox 0 0 1000 700，10px = 1m）
   ================================================================== */
const PLATE = { x1: 40, y1: 40, x2: 960, y2: 660 };         // 建筑外轮廓
const ATRIUM = { x1: 420, y1: 290, x2: 580, y2: 410 };      // 中庭挑空
const CORRIDOR = { x1: 185, y1: 185, x2: 815, y2: 515 };    // 环形通道外边界（=店铺内边）
// 环状通道节点（顺时针 8 点）
const RING = [
  { x: 340, y: 240 }, { x: 500, y: 240 }, { x: 660, y: 240 }, { x: 700, y: 350 },
  { x: 660, y: 460 }, { x: 500, y: 460 }, { x: 340, y: 460 }, { x: 300, y: 350 }
];
const IDX_ELEVATOR = 7;   // 环上第 8 点（左中）→ 观光电梯
const IDX_ESCALATOR = 3;  // 环上第 4 点（右中）→ 自动扶梯

// 店铺分带：上4 · 右2 · 下4 · 左2 = 12 家/层
function layoutShops(shops) {
  const bands = [
    { n: 4, face: 'bottom', rect: (i) => ({ x: 50 + i * 225 + 3, y: 50, w: 219, h: 135 }) },
    { n: 2, face: 'left', rect: (i) => ({ x: 815, y: 185 + i * 165 + 3, w: 135, h: 159 }) },
    { n: 4, face: 'top', rect: (i) => ({ x: 50 + i * 225 + 3, y: 515, w: 219, h: 135 }) },
    { n: 2, face: 'right', rect: (i) => ({ x: 50, y: 185 + i * 165 + 3, w: 135, h: 159 }) }
  ];
  const out = [];
  let k = 0;
  bands.forEach((b) => {
    for (let i = 0; i < b.n; i++) {
      const shop = shops[k++];
      if (!shop) break;
      out.push({ shop, rect: b.rect(i), face: b.face });
    }
  });
  return out;
}
function entryNode(rect, face) {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  if (face === 'bottom') return { x: Math.round(cx), y: rect.y + rect.h + 30 };
  if (face === 'top') return { x: Math.round(cx), y: rect.y - 30 };
  if (face === 'left') return { x: rect.x - 30, y: Math.round(cy) };
  return { x: rect.x + rect.w + 30, y: Math.round(cy) };
}

/* ==================================================================
   四、CAD 风格底图（蓝图）生成
   ================================================================== */
const X = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LINE = 'rgba(150,180,225,.62)';
const LINE_SOFT = 'rgba(150,180,225,.3)';
const TXT = 'rgba(210,226,250,.9)';
const TXT_DIM = 'rgba(190,212,245,.6)';

function svgHeader(floorLabel) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 700" width="1000" height="700" font-family="'Microsoft YaHei','PingFang SC','Segoe UI',sans-serif">
  <defs>
    <pattern id="hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="9" stroke="rgba(150,180,225,.22)" stroke-width="2"/>
    </pattern>
    <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
      <path d="M50 0 L0 0 0 50" fill="none" stroke="rgba(150,180,225,.075)" stroke-width="1"/>
    </pattern>
  </defs>
  <g id="base">
    <!-- 楼板 -->
    <rect x="${PLATE.x1}" y="${PLATE.y1}" width="${PLATE.x2 - PLATE.x1}" height="${PLATE.y2 - PLATE.y1}" rx="8" fill="#0e1729" stroke="rgba(168,196,240,.8)" stroke-width="3"/>
    <rect x="${PLATE.x1}" y="${PLATE.y1}" width="${PLATE.x2 - PLATE.x1}" height="${PLATE.y2 - PLATE.y1}" rx="8" fill="url(#grid)"/>
    <rect x="${PLATE.x1 + 7}" y="${PLATE.y1 + 7}" width="${PLATE.x2 - PLATE.x1 - 14}" height="${PLATE.y2 - PLATE.y1 - 14}" rx="5" fill="none" stroke="rgba(168,196,240,.18)" stroke-width="1"/>
    <!-- 楼层大号水印 -->
    <text x="905" y="185" fill="rgba(168,196,240,.09)" font-size="96" font-weight="800" text-anchor="end">${X(floorLabel)}</text>
  </g>`;
}

function svgFooter(spec) {
  // 指北针 / 比例尺 / 图签
  return `
  <g id="north" transform="translate(912,86)">
    <circle r="22" fill="none" stroke="${LINE_SOFT}" stroke-width="1.2"/>
    <path d="M0,-16 L6,8 L0,4 L-6,8 Z" fill="rgba(168,196,240,.75)"/>
    <text x="0" y="-26" fill="${TXT_DIM}" font-size="11" text-anchor="middle">N</text>
  </g>
  <g id="scalebar" transform="translate(64,638)">
    <rect x="0" y="0" width="50" height="7" fill="rgba(168,196,240,.7)"/>
    <rect x="50" y="0" width="50" height="7" fill="rgba(168,196,240,.28)"/>
    <text x="0" y="-6" fill="${TXT_DIM}" font-size="10">0</text>
    <text x="50" y="-6" fill="${TXT_DIM}" font-size="10" text-anchor="middle">5</text>
    <text x="100" y="-6" fill="${TXT_DIM}" font-size="10" text-anchor="middle">10m</text>
  </g>
  <g id="titleblock">
    <text x="932" y="628" fill="${TXT_DIM}" font-size="11" text-anchor="end">星光汇购物中心 · ${X(spec.name)}（${X(spec.short)}）平面图</text>
    <text x="932" y="644" fill="rgba(190,212,245,.4)" font-size="10" text-anchor="end">比例 1:100　单位 m　底图图层 v1</text>
  </g>`;
}

// 核心筒（电梯/扶梯）以建筑虚线框表示；文字标签由前台交互层提供，避免与交互标记重影
function coreRect(pos) {
  return `<rect x="${pos.x - 30}" y="${pos.y - 30}" width="60" height="60" fill="none" stroke="rgba(150,180,225,.42)" stroke-width="1.3" stroke-dasharray="4 3"/>`;
}
// 结构柱：沿环廊外边界均布
function columnMarks() {
  const pts = [];
  const r = CORRIDOR, step = 90;
  for (let x = r.x1; x <= r.x2; x += step) { pts.push({ x, y: r.y1 }); pts.push({ x, y: r.y2 }); }
  for (let y = r.y1; y <= r.y2; y += step) { pts.push({ x: r.x1, y }); pts.push({ x: r.x2, y }); }
  return pts.map((p) => `<rect x="${p.x - 3.5}" y="${p.y - 3.5}" width="7" height="7" fill="rgba(168,196,240,.3)"/>`).join('');
}

function buildFloorSvg(spec, shopsOfFloor, facsOfFloor) {
  const parts = [svgHeader(spec.short + (spec.name ? '' : ''))];

  // 店铺分隔线 + 店名 + 店面开口
  shopsOfFloor.forEach((s) => {
    const cx = s.x + s.w / 2;
    parts.push(`<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="none" stroke="${LINE}" stroke-width="1.5"/>`);
    // 店面（朝向通道一侧，加粗亮线）
    let fx1, fy1, fx2, fy2;
    if (s.face === 'bottom' || s.face === 'top') {
      const dy = s.face === 'bottom' ? s.y + s.h : s.y;
      fx1 = s.x + 14; fx2 = s.x + s.w - 14; fy1 = fy2 = dy;
    } else {
      const dx = s.face === 'left' ? s.x : s.x + s.w;
      fy1 = s.y + 12; fy2 = s.y + s.h - 12; fx1 = fx2 = dx;
    }
    parts.push(`<line x1="${fx1}" y1="${fy1}" x2="${fx2}" y2="${fy2}" stroke="rgba(210,228,255,.85)" stroke-width="2.6"/>`);
    // 店名
    parts.push(`<text x="${cx}" y="${s.y + 20}" fill="${TXT}" font-size="12.5" font-weight="600" text-anchor="middle">${X(s.name)}</text>`);
  });

  // 中庭
  parts.push(`<rect x="${ATRIUM.x1}" y="${ATRIUM.y1}" width="${ATRIUM.x2 - ATRIUM.x1}" height="${ATRIUM.y2 - ATRIUM.y1}" fill="url(#hatch)" stroke="rgba(168,196,240,.5)" stroke-width="1.6"/>`);
  parts.push(`<text x="500" y="346" fill="rgba(196,216,246,.8)" font-size="15" letter-spacing="3" text-anchor="middle">中 庭</text>`);
  parts.push(`<text x="500" y="366" fill="rgba(190,212,245,.45)" font-size="9.5" letter-spacing="2" text-anchor="middle">ATRIUM</text>`);
  // 环廊中心线 + 结构柱 + 核心筒（建筑结构，不含 POI 文字）
  parts.push(`<rect x="300" y="240" width="400" height="220" fill="none" stroke="rgba(150,180,225,.2)" stroke-width="1" stroke-dasharray="9 7"/>`);
  parts.push(columnMarks());
  parts.push(coreRect(RING[IDX_ELEVATOR]));
  parts.push(coreRect(RING[IDX_ESCALATOR]));
  // 顶部尺寸线（92m 柱距二等分）
  parts.push(`<g stroke="rgba(150,180,225,.3)" stroke-width="1">
    <line x1="40" y1="26" x2="960" y2="26"/>
    <line x1="40" y1="19" x2="40" y2="33"/><line x1="500" y1="19" x2="500" y2="33"/><line x1="960" y1="19" x2="960" y2="33"/></g>
    <text x="270" y="20" fill="rgba(190,212,245,.5)" font-size="10" text-anchor="middle">46.0 m</text>
    <text x="730" y="20" fill="rgba(190,212,245,.5)" font-size="10" text-anchor="middle">46.0 m</text>`);

  // 主入口（仅一层）
  if (spec.entrance) {
    parts.push(`<g transform="translate(500,650)">
      <path d="M0,-30 L0,-6 M-11,-17 L0,-30 L11,-17" fill="none" stroke="rgba(255,209,102,.9)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="0" y="16" fill="rgba(255,209,102,.9)" font-size="12" font-weight="700" text-anchor="middle">主入口 / MAIN ENTRANCE</text></g>`);
  }

  parts.push(svgFooter(spec));
  parts.push('</svg>');
  return parts.join('\n');
}

/* ==================================================================
   五、生成数据
   ================================================================== */
let nodeSeq = 0;
const nodes = [], edges = [], shops = [], facilities = [], floors = [];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function addNode(floorId, x, y, extra) {
  nodeSeq++;
  const n = Object.assign({ id: 'N' + nodeSeq, x: Math.round(x), y: Math.round(y), floorId }, extra || {});
  nodes.push(n); return n.id;
}
function addEdge(from, to, type) {
  if (!from || !to || from === to) return;
  if (edges.some((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from))) return;
  const a = nodes.find((n) => n.id === from), b = nodes.find((n) => n.id === to);
  if (!a || !b) return;
  edges.push({ id: 'E' + (edges.length + 1), from, to, type: type || 'walk', weight: Math.round(dist(a, b)) });
}
function nearestRing(ringIds, p) {
  let best = null, bd = Infinity;
  ringIds.forEach((id) => { const n = nodes.find((x) => x.id === id); const d = dist(n, p); if (d < bd) { bd = d; best = id; } });
  return best;
}

const ringIdsPerFloor = [];
let startNode = null;

FLOORS_SPEC.forEach((spec, fi) => {
  const fid = 'F' + (fi + 1);
  const laid = layoutShops(spec.shops);

  // --- 店铺对象（坐标取整，与底图完全一致） ---
  const shopsOfFloor = laid.map((item) => {
    const sid = 'S' + (shops.length + 1);
    const cat = item.shop.cat || 'other';
    const s = {
      id: sid, name: item.shop.name, floorId: fid, cat,
      letter: initial(item.shop.name),
      x: Math.round(item.rect.x), y: Math.round(item.rect.y),
      w: Math.round(item.rect.w), h: Math.round(item.rect.h),
      face: item.face,
      color: CAT_COLOR[cat] || CAT_COLOR.other,
      phone: '400-800-' + String(2000 + shops.length).slice(-4),
      hours: '10:00 - 22:00',
      desc: `${item.shop.name}（${spec.name} · ${catLabel(cat)}），欢迎光临。`,
      tags: [catLabel(cat), spec.name]
    };
    shops.push(s);
    return s;
  });

  // --- 设施 ---
  const facsOfFloor = [];
  const common = [
    { type: 'elevator', name: '观光电梯', x: RING[IDX_ELEVATOR].x, y: RING[IDX_ELEVATOR].y, ringIdx: IDX_ELEVATOR },
    { type: 'escalator', name: '自动扶梯', x: RING[IDX_ESCALATOR].x, y: RING[IDX_ESCALATOR].y, ringIdx: IDX_ESCALATOR },
    { type: 'restroom', name: '洗手间', x: 335, y: 215 },
    { type: 'restroom', name: '洗手间', x: 665, y: 485 }
  ];
  spec.extra.forEach((e) => common.push(e));
  if (fi === 1) common.push({ type: 'info', name: '导视屏（您的位置）', x: 500, y: 545 });

  // --- 楼层 plan（底图模式） ---
  floors.push({
    id: fid, name: spec.name, short: spec.short, level: spec.level, theme: spec.theme,
    plan: {
      mode: 'image',
      image: `/uploads/plan_${fid}.svg`,
      imageRect: { x: 0, y: 0, w: 1000, h: 700 },
      imageOpacity: 1,
      showImage: true,
      width: 1000, height: 700, scalePxPerM: 10, originX: 0, originY: 0,
      walls: [], objects: []
    }
  });

  // --- 环状通道节点 ---
  const ringIds = RING.map((p) => addNode(fid, p.x, p.y));
  ringIdsPerFloor[fi] = ringIds;
  for (let i = 0; i < ringIds.length; i++) addEdge(ringIds[i], ringIds[(i + 1) % ringIds.length], 'walk');

  // --- 设施对象与节点 ---
  common.forEach((c) => {
    const id = 'FA' + (facilities.length + 1);
    facilities.push({ id, type: c.type, name: c.name, floorId: fid, x: Math.round(c.x), y: Math.round(c.y) });
    facsOfFloor.push({ id, type: c.type, name: c.name, floorId: fid, x: Math.round(c.x), y: Math.round(c.y) });
    if (typeof c.ringIdx === 'number') {
      // 电梯/扶梯直接复用环上节点
      const rn = nodes.find((n) => n.id === ringIds[c.ringIdx]);
      rn.facilityId = id;
    } else {
      const nid = addNode(fid, c.x, c.y, { facilityId: id });
      addEdge(nid, nearestRing(ringIds, c), 'walk');
      if (fi === 1 && c.type === 'info') startNode = nid;
    }
  });

  // --- 店铺节点 ---
  laid.forEach((item, i) => {
    const s = shopsOfFloor[i];
    const p = entryNode(item.rect, item.face);
    const nid = addNode(fid, p.x, p.y, { shopId: s.id });
    addEdge(nid, nearestRing(ringIds, p), 'walk');
  });

  // --- 写底图文件 ---
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, `plan_${fid}.svg`), buildFloorSvg(spec, shopsOfFloor, facsOfFloor), 'utf8');
});

// --- 跨楼层连线（电梯 + 扶梯） ---
for (let i = 1; i < ringIdsPerFloor.length; i++) {
  addEdge(ringIdsPerFloor[i - 1][IDX_ELEVATOR], ringIdsPerFloor[i][IDX_ELEVATOR], 'floor');
  addEdge(ringIdsPerFloor[i - 1][IDX_ESCALATOR], ringIdsPerFloor[i][IDX_ESCALATOR], 'floor');
}

/* ==================================================================
   六、活动 / Banner / 设置
   ================================================================== */
const promos = [
  { id: 'PR1', title: '秋日焕新季 · 全场服饰 5 折起', cat: '品牌特惠', startDate: '2026-09-15', endDate: '2026-10-15', floorId: 'F3', color: '#e8699a', desc: '2F 时尚女装专区秋冬新品上市，全场 5 折起，会员再享 9 折。' },
  { id: 'PR2', title: '珠宝腕表节 · 满 3000 减 500', cat: '品牌特惠', startDate: '2026-09-01', endDate: '2026-09-30', floorId: 'F2', color: '#37c2d6', desc: '1F 珠宝腕表专区满 3000 减 500，以旧换新额外补贴。' },
  { id: 'PR3', title: '环球美食 · 第二份半价', cat: '餐饮折扣', startDate: '2026-09-10', endDate: '2026-09-28', floorId: 'F5', color: '#ef6c4d', desc: '4F 环球美食指定餐厅第二份半价，工作日 11:00-14:00。' },
  { id: 'PR4', title: '会员专享 · 积分翻倍', cat: '会员专享', startDate: '2026-09-20', endDate: '2026-09-25', floorId: '', color: '#7e57c2', desc: '会员日当天全场消费积分翻倍，可兑换停车券与礼品。' },
  { id: 'PR5', title: '国庆黄金周 · 中庭整点抽奖', cat: '节日活动', startDate: '2026-10-01', endDate: '2026-10-07', floorId: '', color: '#f5a623', desc: '国庆期间中庭整点抽奖，消费满 500 即可参与。' },
  { id: 'PR6', title: '亲子乐园 · 儿童体验课免费抢', cat: '节日活动', startDate: '2026-09-18', endDate: '2026-10-08', floorId: 'F4', color: '#3aa76d', desc: '3F 儿童区周末免费体验课，乐高 / 巴拉巴拉联名活动。' }
];
const banners = [
  { id: 'BN1', title: '星光汇购物中心', sub: '一站式购物 · 餐饮 · 娱乐中心', bg: 'linear-gradient(135deg,#4a7fe0 0%,#7e57c2 100%)', badge: '欢迎光临', action: 'floor' },
  { id: 'BN2', title: '秋日焕新季', sub: '全场服饰 5 折起 · 会员再享折扣', bg: 'linear-gradient(135deg,#e8699a 0%,#ef6c4d 100%)', badge: '限时特惠', action: 'promo' },
  { id: 'BN3', title: '四层环球美食', sub: '第二份半价 · 工作日午市专享', bg: 'linear-gradient(135deg,#f5a623 0%,#ef6c4d 100%)', badge: '美食优选', action: 'promo' },
  { id: 'BN4', title: '停车缴费 · 手机一键搞定', sub: '扫码缴费 或 至客服中心办理', bg: 'linear-gradient(135deg,#26a69a 0%,#37c2d6 100%)', badge: '便捷服务', action: 'service' }
];

/* ==================================================================
   六·B、待机页（屏保）示例素材与默认配置
   ================================================================== */
// 海报底图（1920×1080，16:9）
function posterSvg(p) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080" font-family="'Microsoft YaHei','PingFang SC','Segoe UI',sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${p.c1}"/><stop offset="1" stop-color="${p.c2}"/>
    </linearGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#bg)"/>
  <circle cx="1640" cy="200" r="340" fill="rgba(255,255,255,.09)"/>
  <circle cx="240" cy="960" r="440" fill="rgba(255,255,255,.07)"/>
  <line x1="132" y1="330" x2="360" y2="330" stroke="rgba(255,255,255,.55)" stroke-width="8"/>
  <rect x="132" y="392" width="${Math.max(180, p.badge.length * 34 + 64)}" height="68" rx="34" fill="rgba(255,255,255,.22)" stroke="rgba(255,255,255,.45)" stroke-width="2"/>
  <text x="${132 + 32}" y="438" fill="#fff" font-size="32" font-weight="600">${X(p.badge)}</text>
  <text x="132" y="608" fill="#ffffff" font-size="106" font-weight="800">${X(p.title)}</text>
  <text x="132" y="700" fill="rgba(255,255,255,.92)" font-size="42">${X(p.sub)}</text>
  <text x="1788" y="1014" fill="rgba(255,255,255,.75)" font-size="26" text-anchor="end">星光汇购物中心 · 待机页示例素材</text>
</svg>`;
}

const SS_POSTERS = [
  { file: 'ss_poster_1.svg', c1: '#4a7fe0', c2: '#7e57c2', badge: '欢迎光临', title: '星光汇购物中心', sub: '一站式购物 · 餐饮 · 娱乐中心' },
  { file: 'ss_poster_2.svg', c1: '#e8699a', c2: '#ef6c4d', badge: '限时特惠', title: '秋日焕新季', sub: '全场服饰 5 折起 · 会员再享折扣' },
  { file: 'ss_poster_3.svg', c1: '#f5a623', c2: '#ef6c4d', badge: '美食优选', title: '四层环球美食', sub: '第二份半价 · 工作日午市专享' }
];
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
SS_POSTERS.forEach((p) => fs.writeFileSync(path.join(UPLOAD_DIR, p.file), posterSvg(p), 'utf8'));

// 待机页默认配置（节目单：图片 ×3 + 互动网页 Demo ×1）
const screensaver = {
  enabled: true,
  idleSeconds: 45,
  interval: 8,
  transition: 'fade',
  order: 'sequence',
  loop: true,
  mute: true,
  videoMode: 'timed',
  showClock: true,
  showMallName: true,
  showHint: true,
  showProgress: true,
  dim: 0.15,
  tapAction: 'activity',   // 点击待机页 → 进入关联活动页（exit = 退出到首页）
  pageTap: 'activity',     // 点击互动页 → 进入关联活动页（interact = 保留 H5 交互，另给角标按钮）
  items: [
    { id: 'SC1', enabled: true, type: 'image', url: '/uploads/ss_poster_1.svg', title: '', sub: '', duration: 8, promoId: '' },
    { id: 'SC2', enabled: true, type: 'image', url: '/uploads/ss_poster_2.svg', title: '', sub: '', duration: 8, promoId: 'PR1' },
    { id: 'SC3', enabled: true, type: 'page', url: '/uploads/ss_demo_h5.html', title: '', sub: '', duration: 25, promoId: 'PR5' },
    { id: 'SC4', enabled: true, type: 'image', url: '/uploads/ss_poster_3.svg', title: '', sub: '', duration: 8, promoId: '' }
  ]
};

// 服务指南默认配置（卡片后台可配；items 每行一条，以「- 」开头渲染为圆点列表项）
// 占位符：{{商场名}} {{地址}} {{营业时间}} {{服务电话}} {{楼层:设施类型}}
const guide = {
  enabled: true,
  title: '服务指南',
  sub: '客服中心 · 公共设施 · 商场信息',
  cards: [
    {
      id: 'GD1', enabled: true, icon: '🅿️', title: '停车缴费', color: '#4a7fe0', colorMode: 'border', items: [
        '地下停车场位于 {{楼层:停车场}}。',
        '- 扫码支付：出口处张贴缴费二维码',
        '- 人工缴费：一层客服中心办理',
        '- 会员可凭积分抵扣停车费'
      ]
    },
    {
      id: 'GD2', enabled: true, icon: '🛎️', title: '客服中心', color: '#f5a623', colorMode: 'border', items: [
        '位于 {{楼层:客服中心}}。',
        '- 咨询 / 广播寻人',
        '- 轮椅、婴儿车、雨伞租借',
        '- 礼品包装与寄存服务',
        '- 服务电话：{{服务电话}}'
      ]
    },
    {
      id: 'GD3', enabled: true, icon: '🚻', title: '洗手间', color: '#3aa76d', colorMode: 'border', items: [
        '分布楼层：{{楼层:洗手间}}',
        '- 每层洗手间均设无障碍卫生间',
        '- 母婴需求请前往 {{楼层:母婴室}} 母婴室'
      ]
    },
    {
      id: 'GD4', enabled: true, icon: '🛗', title: '电梯与扶梯', color: '#37c2d6', colorMode: 'border', items: [
        '中庭设观光电梯与自动扶梯，可直达各楼层。',
        '- 观光电梯：各层中庭东侧',
        '- 自动扶梯：各层中庭西侧',
        '- 儿童、老人请乘电梯并注意安全'
      ]
    },
    {
      id: 'GD5', enabled: true, icon: '🏧', title: '自助服务', color: '#b06ad6', colorMode: 'border', items: [
        'ATM 取款机位于 {{楼层:ATM 取款机}}。',
        '- 支持银联取款',
        '- 共享充电宝：各层服务台旁',
        '- 免费 Wi-Fi：搜索「{{商场名}}」一键连接'
      ]
    },
    {
      id: 'GD6', enabled: true, icon: 'ℹ️', title: '商场信息', color: '#ef6c4d', colorMode: 'border', items: [
        '{{商场名}}',
        '- 地址：{{地址}}',
        '- 营业时间：{{营业时间}}',
        '- 服务热线：{{服务电话}}'
      ]
    }
  ]
};

const db = {
  settings: {
    mallName: '星光汇购物中心',
    slogan: '一站式购物 · 餐饮 · 娱乐中心',
    address: '市中心商圈 · 星光汇广场 1 号',
    servicePhone: '400-800-6666',
    businessHours: '10:00 - 22:00',
    startNode: startNode || 'N1',
    scalePxPerM: 10,
    idleSeconds: 90,
    screensaverSeconds: 45,
    screensaver,
    guide,
    adminPass: 'admin123'
  },
  floors, shops, facilities, promos, banners,
  graph: { nodes, edges }
};

/* ==================================================================
   七、落盘（带备份）
   ================================================================== */
fs.mkdirSync(DATA_DIR, { recursive: true });
const json = JSON.stringify(db, null, 2);
fs.writeFileSync(path.join(DATA_DIR, 'db.example.json'), json, 'utf8');

const live = path.join(DATA_DIR, 'db.json');
const keep = process.argv.includes('--keep');
if (fs.existsSync(live) && !keep) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bak = path.join(DATA_DIR, `db.backup-${stamp}.json`);
  fs.copyFileSync(live, bak);
  console.log('[备份] 原 db.json 已备份为 ' + path.basename(bak));
}
if (!fs.existsSync(live) || !keep) fs.writeFileSync(live, json, 'utf8');

console.log('生成完成：');
console.log('  底图：public/uploads/plan_*.svg × ' + floors.length);
console.log('  楼层：' + floors.map((f) => f.id + '=' + f.name + '(' + f.short + ')').join(', '));
console.log('  店铺：' + shops.length + ' 家（' + (shops.length / floors.length) + '/层）');
console.log('  设施：' + facilities.length + ' 处');
console.log('  节点：' + nodes.length + ' 个 / 连线：' + edges.length + ' 条');
console.log('  起点：' + db.settings.startNode);

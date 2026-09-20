/**
 * 商场 · 场馆智能导视系统 - 后端服务（零依赖，纯 Node.js）
 *
 * 运行：node server.js            （默认端口 4000，可用 PORT 环境变量覆盖）
 * 访问：前台导视终端 http://<本机IP>:4000/
 *      管理后台     http://<本机IP>:4000/admin.html
 *
 * 数据持久化：data/db.json（内存加载，写操作后落盘；缺失时自动从 data/db.example.json 播种）
 * 鉴权：管理接口需携带请求头 x-admin-token，值等于 settings.adminPass
 *
 * 与「办公区域引导屏」的差异：实体由 rooms 换成 shops（店铺）+ facilities（公共设施），
 * 增加 promos（优惠活动）、banners（首页/屏保广告）；路径规划、跨层分段、自愈机制沿用成熟实现。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const SEED_FILE = path.join(DATA_DIR, 'db.example.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = process.env.PORT || 4000;

// ---------- 素材媒体归一化（type = none | image | video | page；url 为站内相对路径或外链） ----------
const MEDIA_TYPES = ['none', 'image', 'video', 'page'];
function normMedia(m) {
  const r = (m && typeof m === 'object') ? m : {};
  let type = MEDIA_TYPES.includes(r.type) ? r.type : (r.url ? 'image' : 'none');
  const url = typeof r.url === 'string' ? r.url.trim() : '';
  if (!url) type = 'none';
  return { type, url, poster: typeof r.poster === 'string' ? r.poster.trim() : '' };
}

// ---------- 待机页（屏保）配置 ----------
// 播放参数 + 节目单(items)；缺失时自动补齐默认值（老库无损迁移）
const SS_TRANSITIONS = ['fade', 'slide', 'zoom', 'none'];
const SS_ORDERS = ['sequence', 'shuffle'];
const SS_VIDEO_MODES = ['timed', 'ended'];
// 待机页点击行为：activity=进入关联活动页；exit=退出待机页回首页
const SS_TAP_ACTIONS = ['activity', 'exit'];
// 互动页(page)点击行为：activity=整页点击进活动（H5 不再响应）；interact=保留 H5 交互，另给角标按钮进活动
const SS_PAGE_TAPS = ['activity', 'interact'];
// 示例素材的默认活动关联（仅在该字段从未存在过时补齐，之后不再改动）
const SS_DEMO_LINKS = { SC2: 'PR1', SC3: 'PR5' };
let MIGRATED = false;

function defaultScreensaver(legacySeconds) {
  return {
    enabled: true,
    idleSeconds: Math.max(10, Number(legacySeconds) || 45),
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
    tapAction: 'activity',
    pageTap: 'activity',
    items: [
      { id: 'SC1', enabled: true, type: 'image', url: '/uploads/ss_poster_1.svg', title: '', sub: '', duration: 8, promoId: '' },
      { id: 'SC2', enabled: true, type: 'image', url: '/uploads/ss_poster_2.svg', title: '', sub: '', duration: 8, promoId: 'PR1' },
      { id: 'SC3', enabled: true, type: 'page', url: '/uploads/ss_demo_h5.html', title: '', sub: '', duration: 25, promoId: 'PR5' },
      { id: 'SC4', enabled: true, type: 'image', url: '/uploads/ss_poster_3.svg', title: '', sub: '', duration: 8, promoId: '' }
    ]
  };
}

function normScreenItem(it) {
  const r = (it && typeof it === 'object') ? it : {};
  const id = (typeof r.id === 'string' && r.id) ? r.id : uid('SC');
  const hasPromoKey = Object.prototype.hasOwnProperty.call(r, 'promoId');
  return {
    id,
    enabled: r.enabled !== false,
    type: ['image', 'video', 'page'].includes(r.type) ? r.type : 'image',
    url: typeof r.url === 'string' ? r.url.trim() : '',
    title: typeof r.title === 'string' ? r.title : '',
    sub: typeof r.sub === 'string' ? r.sub : '',
    duration: Math.max(3, Math.min(300, Number(r.duration) || 8)),
    // promoId：关联的活动 ID；'' = 不关联。字段缺失时（老数据/示例）按 SS_DEMO_LINKS 补齐一次
    promoId: hasPromoKey ? String(r.promoId || '').trim() : (SS_DEMO_LINKS[id] || '')
  };
}

function normScreen(s, legacySeconds) {
  if (!s || typeof s !== 'object') { MIGRATED = true; return defaultScreensaver(legacySeconds); }
  const d = defaultScreensaver(legacySeconds);
  // 老库补齐检测：缺少新增字段时也标记迁移，保证落盘一次（否则每次重启都要重新推导）
  const itemsRaw = Array.isArray(s.items) ? s.items : [];
  const lackFields = !SS_TAP_ACTIONS.includes(s.tapAction) || !SS_PAGE_TAPS.includes(s.pageTap);
  const lackPromo = itemsRaw.some((r) => r && !Object.prototype.hasOwnProperty.call(r, 'promoId'));
  if (lackFields || lackPromo) MIGRATED = true;
  const out = {
    enabled: s.enabled !== false,
    idleSeconds: Math.max(10, Number(s.idleSeconds) || d.idleSeconds),
    interval: Math.max(3, Math.min(300, Number(s.interval) || d.interval)),
    transition: SS_TRANSITIONS.includes(s.transition) ? s.transition : 'fade',
    order: SS_ORDERS.includes(s.order) ? s.order : 'sequence',
    loop: s.loop !== false,
    mute: s.mute !== false,
    videoMode: SS_VIDEO_MODES.includes(s.videoMode) ? s.videoMode : 'timed',
    showClock: s.showClock !== false,
    showMallName: s.showMallName !== false,
    showHint: s.showHint !== false,
    showProgress: s.showProgress !== false,
    dim: Math.max(0, Math.min(0.7, Number(s.dim) || 0)),
    tapAction: SS_TAP_ACTIONS.includes(s.tapAction) ? s.tapAction : 'activity',
    pageTap: SS_PAGE_TAPS.includes(s.pageTap) ? s.pageTap : 'activity',
    items: Array.isArray(s.items) ? s.items.map(normScreenItem).filter((x) => x.url) : []
  };
  if (!out.items.length) out.items = d.items;
  return out;
}

// ---------- 服务指南：卡片内容后台可配，支持占位符实时取数 ----------
// 占位符（前台渲染时替换）：{{商场名}} {{地址}} {{营业时间}} {{服务电话}} {{楼层:设施类型}}
// 条目写法：每行一条；以「- 」开头渲染为圆点列表项，否则渲染为段落
const GUIDE_TITLE_MAX = 20;
function defaultGuide() {
  return {
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
}
function normGuideItems(v) {
  const arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split('\n') : []);
  return arr
    .map((x) => String(x == null ? '' : x).replace(/\r/g, '').trim())
    .filter((x) => x !== '' && !/^[-•*]$/.test(x)) // 丢弃空行与「只有列表符号」的行
    .slice(0, 20);
}
// 卡片颜色：color = CSS 颜色字符串（空 = 跟随主题）；colorMode = 'border'（左侧色条+图标底色）| 'bg'（整卡背景）
function normGuideCard(c) {
  const r = (c && typeof c === 'object') ? c : {};
  const ico = typeof r.icon === 'string' ? [...r.icon.trim()].slice(0, 4).join('') : '';
  const color = (typeof r.color === 'string') ? r.color.trim().slice(0, 32) : '';
  const colorMode = (r.colorMode === 'bg') ? 'bg' : 'border';
  const bgRaw = (typeof r.bgImage === 'string') ? r.bgImage.trim() : '';
  // 仅允许站内 /uploads、http(s) 外链、内联 data:image；禁止引号/括号/空格，确保可安全嵌入 CSS url()
  const bgImage = /^(\/|https?:\/\/|data:image\/)[^'"()<> ]{0,240}$/.test(bgRaw) ? bgRaw : '';
  return {
    id: (typeof r.id === 'string' && r.id) ? r.id : uid('GD'),
    enabled: r.enabled !== false,
    icon: ico || 'ℹ️',
    title: typeof r.title === 'string' ? r.title.trim().slice(0, GUIDE_TITLE_MAX) : '',
    items: normGuideItems(r.items),
    color,       // 自定义卡片颜色（空 = 跟随主题）
    colorMode,   // 'border' | 'bg'
    bgImage      // 自定义卡片背景图（空 = 无）
  };
}
function normGuide(g) {
  if (!g || typeof g !== 'object') { MIGRATED = true; return defaultGuide(); }
  // 老库补齐检测：缺字段也标记迁移，保证落盘一次
  if (typeof g.title !== 'string' || typeof g.sub !== 'string' || !Array.isArray(g.cards)) MIGRATED = true;
  const out = {
    enabled: g.enabled !== false,
    title: (typeof g.title === 'string' && g.title.trim()) ? g.title.trim().slice(0, GUIDE_TITLE_MAX) : '服务指南',
    sub: typeof g.sub === 'string' ? g.sub.trim() : '',
    cards: Array.isArray(g.cards) ? g.cards.map(normGuideCard).filter((c) => c.title) : []
  };
  if (!out.cards.length) out.cards = defaultGuide().cards;
  return out;
}

// ---------- 多触摸屏内容分发：屏幕登记表 ----------
// 位置标识：屏端通过 URL 参数 ?screen=ID 或本地标识文件 public/screen-id.json 自报身份；
// 内容分配：全馆共享基础内容（楼层/店铺/活动/指南），每屏仅覆盖展示参数（默认页签/聚焦楼层/模块开关/主题色/本地点位公告）；
// 远程更新：保存或「立即下发」均令 rev+1，前台每 15s 轮询发现 rev 变化即自动重新应用（免人工刷新）。
const SCREEN_MODULES = ['floor', 'brand', 'promo', 'service', 'guide'];
const SCREEN_TABS = ['home', 'floor', 'brand', 'promo', 'service'];
function normScreenId(s) { return String(s || '').trim().replace(/[^\w.-]/g, '').slice(0, 40); }
function normScreens(arr, floors) {
  if (!Array.isArray(arr)) { MIGRATED = true; arr = []; }
  const out = []; const seen = new Set();
  const allMods = () => SCREEN_MODULES.reduce((m, k) => (m[k] = true, m), {});
  const fl = Array.isArray(floors) ? floors : [];
  arr.forEach((s) => {
    if (!s || typeof s !== 'object') return;
    const id = normScreenId(s.id);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      name: (typeof s.name === 'string' && s.name.trim()) ? s.name.trim().slice(0, 40) : ('屏幕 ' + id),
      location: (typeof s.location === 'string') ? s.location.trim().slice(0, 60) : '',
      enabled: s.enabled !== false,
      defaultTab: SCREEN_TABS.includes(s.defaultTab) ? s.defaultTab : 'home',
      focusFloorId: (typeof s.focusFloorId === 'string' && fl.some((f) => f.id === s.focusFloorId)) ? s.focusFloorId : '',
      modules: SCREEN_MODULES.reduce((m, k) => (m[k] = (s.modules ? s.modules[k] !== false : true), m), {}),
      accent: (typeof s.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.accent.trim())) ? s.accent.trim() : '',
      notice: (typeof s.notice === 'string') ? s.notice.trim().slice(0, 200) : '',
      rev: Math.max(1, Number(s.rev) || 1)
    });
  });
  if (!out.length) {
    // 老库 / 空库：播种 2 个示例屏，演示「不同位置 → 不同内容」
    MIGRATED = true;
    const f1 = (fl[0] || {}).id || '';
    const f2 = (fl[1] || {}).id || f1;
    out.push({ id: 'F1-LOBBY', name: '一层中庭导视屏', location: '一层中庭', enabled: true, defaultTab: 'floor', focusFloorId: f1, modules: allMods(), accent: '', notice: '您当前位于一层中庭，欢迎光临', rev: 1 });
    if (f2) out.push({ id: 'F2-LOBBY', name: '二层扶梯口导视屏', location: '二层扶梯口', enabled: true, defaultTab: 'floor', focusFloorId: f2, modules: allMods(), accent: '', notice: '', rev: 1 });
  }
  return out;
}
// 未登记屏幕回落到的「默认界面」：全模块开放、从首页进入
function defaultScreenProfile() {
  return {
    id: '', name: db.settings.mallName || '默认界面', location: '', enabled: true, assigned: false,
    defaultTab: 'home',
    focusFloorId: (db.floors[0] || {}).id || '',
    modules: SCREEN_MODULES.reduce((m, k) => (m[k] = true, m), {}),
    accent: '', notice: '', rev: 0
  };
}
// 屏端按自身标识解析专属展示参数（全局基础 + 每屏覆盖）
function resolveScreenProfile(id) {
  const nid = normScreenId(id);
  const s = db.screens.find((x) => x.id === nid && x.enabled !== false);
  if (!s) return Object.assign(defaultScreenProfile(), { id: nid });
  return {
    id: s.id, name: s.name, location: s.location, enabled: s.enabled, assigned: true,
    defaultTab: s.defaultTab,
    focusFloorId: s.focusFloorId || (db.floors[0] || {}).id || '',
    modules: Object.assign({}, s.modules),
    accent: s.accent, notice: s.notice, rev: s.rev
  };
}

// ---------- 数据加载 ----------
let db = loadDb();

// 老库首次升级：补齐默认「待机页」配置并落盘一次（不触碰其它字段）
if (MIGRATED) { try { saveDb(); console.log('[迁移] 已写入默认「待机页」/「服务指南」配置'); } catch (e) { /* ignore */ } }

function normalizeDb(parsed) {
  parsed.floors = parsed.floors || [];
  parsed.shops = parsed.shops || [];
  parsed.facilities = parsed.facilities || [];
  parsed.promos = parsed.promos || [];
  parsed.banners = parsed.banners || [];
  parsed.graph = parsed.graph || { nodes: [], edges: [] };
  parsed.graph.nodes = parsed.graph.nodes || [];
  parsed.graph.edges = parsed.graph.edges || [];
  parsed.settings = parsed.settings || {};
  // 店铺 Logo 与活动/Banner 素材（新增字段，旧数据自动兜底）
  parsed.shops.forEach((s) => { if (typeof s.logo !== 'string') s.logo = ''; });
  parsed.promos.forEach((p) => { p.media = normMedia(p.media); });
  parsed.banners.forEach((b) => { b.media = normMedia(b.media); });
  // 待机页（屏保）配置：缺失则补齐默认值（老库无损迁移）
  parsed.settings.screensaver = normScreen(parsed.settings.screensaver, parsed.settings.screensaverSeconds);
  // 服务指南配置：缺失则补齐默认卡片（老库无损迁移）
  parsed.settings.guide = normGuide(parsed.settings.guide);
  // 多屏分发屏幕登记表：缺失则播种示例屏（老库无损迁移）
  parsed.screens = normScreens(parsed.screens, parsed.floors);
  if (!parsed.settings.scalePxPerM) parsed.settings.scalePxPerM = 10;
  if (!parsed.settings.idleSeconds) parsed.settings.idleSeconds = 90;
  if (!parsed.settings.screensaverSeconds) parsed.settings.screensaverSeconds = 45;
  return parsed;
}

function loadDb() {
  // 仅在「文件不存在」时播种示例数据；解析失败绝不覆盖，避免误伤用户数据
  if (!fs.existsSync(DATA_FILE)) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.copyFileSync(SEED_FILE, DATA_FILE);
      console.log('[初始化] 未找到 data/db.json，已从 data/db.example.json 生成示例数据');
    } catch (e) {
      console.error('[FATAL] 初始化 data/db.json 失败:', e.message);
      console.error('        请先运行 node tools/gen-seed.js 生成示例数据');
      process.exit(1);
    }
  }
  try {
    return normalizeDb(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (e) {
    console.error('[FATAL] data/db.json 解析失败:', e.message);
    console.error('        为避免覆盖你的数据，服务已停止；请修复该文件，或从 data/db.backup-*.json 还原。');
    process.exit(1);
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[ERROR] 写库失败:', e.message);
    return false;
  }
}

// ---------- 通用工具 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function sendText(res, code, text, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(text);
}
function readBody(req, max = 6e6) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > max) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function isAdmin(req) {
  const token = req.headers['x-admin-token'] || '';
  return !!token && token === db.settings.adminPass;
}
function uid(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
const num = (v, d) => (isFinite(Number(v)) ? Number(v) : d);

// ---------- 数据字典（key 存库，label/icon/color 供前端展示） ----------
const CATEGORIES = [
  { key: 'fashion_women', label: '女装', icon: '👗', color: '#e8699a' },
  { key: 'fashion_men', label: '男装', icon: '👔', color: '#4a7fe0' },
  { key: 'shoes', label: '鞋包', icon: '👠', color: '#b06ad6' },
  { key: 'cosmetics', label: '美妆', icon: '💄', color: '#f06292' },
  { key: 'jewelry', label: '珠宝腕表', icon: '💎', color: '#37c2d6' },
  { key: 'sports', label: '运动户外', icon: '👟', color: '#3aa76d' },
  { key: 'kids', label: '儿童亲子', icon: '🧸', color: '#f5a623' },
  { key: 'digital', label: '数码家电', icon: '📱', color: '#5b6ce0' },
  { key: 'supermarket', label: '超市便利', icon: '🛒', color: '#f4a300' },
  { key: 'food', label: '餐饮美食', icon: '🍽️', color: '#ef6c4d' },
  { key: 'dessert', label: '烘焙甜品', icon: '🍰', color: '#e8a33d' },
  { key: 'drink', label: '茶饮咖啡', icon: '☕', color: '#9c7b6b' },
  { key: 'entertainment', label: '休闲娱乐', icon: '🎬', color: '#7e57c2' },
  { key: 'home', label: '家居生活', icon: '🛋️', color: '#26a69a' },
  { key: 'beauty', label: '美容个护', icon: '💅', color: '#ec407a' },
  { key: 'service', label: '生活服务', icon: '🛠️', color: '#78909c' },
  { key: 'other', label: '其他', icon: '📍', color: '#90a4ae' }
];
const CAT_FALLBACK = CATEGORIES[CATEGORIES.length - 1];
function catMeta(key) { return CATEGORIES.find((c) => c.key === key) || CAT_FALLBACK; }

const FACILITY_TYPES = [
  { key: 'restroom', label: '洗手间', icon: '🚻', color: '#8ac926' },
  { key: 'elevator', label: '电梯', icon: '🛗', color: '#4cc9f0' },
  { key: 'escalator', label: '自动扶梯', icon: '⤴️', color: '#4cc9f0' },
  { key: 'stairs', label: '楼梯', icon: '🪜', color: '#4cc9f0' },
  { key: 'atm', label: 'ATM 取款机', icon: '🏧', color: '#37c2d6' },
  { key: 'service', label: '客服中心', icon: '🛎️', color: '#f5a623' },
  { key: 'nursing', label: '母婴室', icon: '🍼', color: '#f06292' },
  { key: 'parking', label: '停车场', icon: '🅿️', color: '#5b6ce0' },
  { key: 'info', label: '导视屏', icon: '🖥️', color: '#26a69a' },
  { key: 'charging', label: '充电站', icon: '🔌', color: '#3aa76d' },
  { key: 'security', label: '安保值班', icon: '🛡️', color: '#78909c' },
  { key: 'other', label: '其他设施', icon: '📍', color: '#90a4ae' }
];
const FAC_FALLBACK = FACILITY_TYPES[FACILITY_TYPES.length - 1];
function facMeta(type) { return FACILITY_TYPES.find((f) => f.key === type) || FAC_FALLBACK; }

// ---------- 楼层 ID 连续化 ----------
const FLOOR_ID_RE = /^F\d+$/;
function nextFloorId() {
  const used = new Set();
  db.floors.forEach((f) => { const m = String(f.id || '').match(FLOOR_ID_RE); if (m) used.add(m[0]); });
  let i = 1; while (used.has('F' + i)) i++;
  return 'F' + i;
}
const NODE_ID_RE = /^N\d+$/;
function nextNodeId() {
  const used = new Set(db.graph.nodes.map((n) => String(n.id)));
  let i = 1; while (used.has('N' + i)) i++;
  return 'N' + i;
}
function compactFloorIds() {
  const cnt = {};
  db.floors.forEach((f) => (cnt[f.id] = (cnt[f.id] || 0) + 1));
  const dups = Object.keys(cnt).filter((k) => cnt[k] > 1);
  if (dups.length) {
    const seen = new Set(); const taken = new Set(db.floors.map((f) => f.id)); let t = 0;
    db.floors.forEach((f) => {
      if (!dups.includes(f.id)) return;
      if (!seen.has(f.id)) { seen.add(f.id); return; }
      let tmp; do { t++; tmp = 'Ftmp' + t; } while (taken.has(tmp));
      taken.add(tmp); f.id = tmp;
    });
  }
  const ordered = [...db.floors].sort((a, b) => (Number(a.level) || 0) - (Number(b.level) || 0));
  const needReorder = db.floors.some((f, i) => f !== ordered[i]);
  const map = {}; let needRename = false;
  ordered.forEach((f, i) => { const want = 'F' + (i + 1); if (f.id !== want) { map[f.id] = want; needRename = true; } });
  if (!needReorder && !needRename) return false;
  ordered.forEach((f, i) => (f.id = 'F' + (i + 1)));
  db.floors = ordered;
  ['shops', 'facilities'].forEach((k) => db[k].forEach((x) => { if (map[x.floorId]) x.floorId = map[x.floorId]; }));
  db.graph.nodes.forEach((n) => { if (map[n.floorId]) n.floorId = map[n.floorId]; });
  saveDb();
  return true;
}

// ---------- 楼层平面配置 ----------
function ensureFloorPlan(f) {
  if (!f.plan || typeof f.plan !== 'object') f.plan = {};
  const p = f.plan;
  if (!['none', 'draw', 'image'].includes(p.mode)) p.mode = 'draw';
  if (typeof p.width !== 'number') p.width = 1000;
  if (typeof p.height !== 'number') p.height = 700;
  if (typeof p.scalePxPerM !== 'number' || p.scalePxPerM <= 0) p.scalePxPerM = Number(db.settings.scalePxPerM) || 10;
  if (typeof p.originX !== 'number') p.originX = 0;
  if (typeof p.originY !== 'number') p.originY = 0;
  if (typeof p.image !== 'string') p.image = null;
  // 底图对齐参数：imageRect 决定底图在 1000×700 坐标系中的铺放位置与尺寸
  if (!p.imageRect || typeof p.imageRect !== 'object') p.imageRect = { x: 0, y: 0, w: p.width, h: p.height };
  ['x', 'y', 'w', 'h'].forEach((k) => { if (typeof p.imageRect[k] !== 'number') p.imageRect[k] = k === 'w' ? p.width : (k === 'h' ? p.height : 0); });
  if (typeof p.imageOpacity !== 'number') p.imageOpacity = 1;
  if (typeof p.showImage !== 'boolean') p.showImage = true;
  if (!Array.isArray(p.walls)) p.walls = [];
  if (!Array.isArray(p.objects)) p.objects = [];
  return f;
}
function pxToMeters(px, plan) {
  const s = (plan && plan.scalePxPerM) || Number(db.settings.scalePxPerM) || 10;
  const ox = (plan && plan.originX) || 0;
  return (px - ox) / s;
}
function floorsSorted() {
  const ordered = [...db.floors].sort((a, b) => (Number(a.level) || 0) - (Number(b.level) || 0));
  ordered.forEach(ensureFloorPlan);
  return ordered;
}
function shopById(id) { return db.shops.find((s) => s.id === id); }
function facById(id) { return db.facilities.find((f) => f.id === id); }
function nodeById(id) { return db.graph.nodes.find((n) => n.id === id); }
function floorById(id) { return db.floors.find((f) => f.id === id); }
function floorShort(fid) { const f = floorById(fid); return f ? (f.short || f.name) : fid; }

// ---------- 节点命名：店铺 > 设施 > 通道 ----------
function nodeName(n, opts) {
  const list = (opts && opts.list) || db.graph.nodes;
  if (n.shopId) { const s = shopById(n.shopId); if (s) return s.name; }
  if (n.facilityId) { const f = facById(n.facilityId); if (f) return f.name; }
  const base = floorShort(n.floorId);
  const sibs = list.filter((x) => !x.shopId && !x.facilityId && x.floorId === n.floorId);
  const k = sibs.findIndex((x) => x.id === n.id) + 1;
  return base + '·通道' + (k > 0 ? k : 1);
}
function nodeOut(n) {
  return {
    ...n,
    name: nodeName(n),
    shopName: n.shopId ? ((shopById(n.shopId) || {}).name || '') : '',
    facilityName: n.facilityId ? ((facById(n.facilityId) || {}).name || '') : ''
  };
}

// 对外输出：附带展示字典字段，前端不必各自维护
function shopOut(s) {
  const m = catMeta(s.cat);
  return { ...s, catLabel: m.label, icon: m.icon, color: s.color || m.color };
}
function facOut(f) {
  const m = facMeta(f.type);
  return { ...f, typeLabel: m.label, icon: m.icon, color: m.color };
}
function promoOut(p) {
  const today = new Date().toISOString().slice(0, 10);
  const active = (!p.startDate || p.startDate <= today) && (!p.endDate || p.endDate >= today);
  return { ...p, active, floorShort: p.floorId ? floorShort(p.floorId) : '' };
}

// ---------- 清理孤儿数据 ----------
function pruneOrphanEdges() {
  const ids = new Set(db.graph.nodes.map((n) => n.id));
  const before = db.graph.edges.length;
  db.graph.edges = db.graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return before - db.graph.edges.length;
}
// 节点指向的店铺/设施若已被删除，清除失效引用（节点保留，避免破坏路网）
function pruneNodeRefs() {
  let changed = 0;
  db.graph.nodes.forEach((n) => {
    if (n.shopId && !shopById(n.shopId)) { delete n.shopId; changed++; }
    if (n.facilityId && !facById(n.facilityId)) { delete n.facilityId; changed++; }
  });
  return changed;
}

// ---------- 起点解析（含自愈降级） ----------
const START_RE = /客服|服务台|导视|入口|大厅|中庭|大厅|service|info|entrance/i;
function pickFallbackStartNode() {
  const nodes = db.graph.nodes;
  if (!nodes.length) return null;
  // ① 客服中心 / 导视屏类设施所在节点
  const atService = nodes.find((n) => {
    if (!n.facilityId) return false;
    const f = facById(n.facilityId);
    return f && START_RE.test(String(f.name || '') + facMeta(f.type).label);
  });
  if (atService) return atService;
  // ② 最低楼层的第一个节点
  const ordered = [...db.floors].sort((a, b) => (Number(a.level) || 0) - (Number(b.level) || 0));
  for (const f of ordered) { const n = nodes.find((x) => x.floorId === f.id); if (n) return n; }
  return nodes[0];
}
function resolveStartNode() {
  const cur = db.settings.startNode ? nodeById(db.settings.startNode) : null;
  if (cur) return { node: cur, healed: false };
  const fb = pickFallbackStartNode();
  if (fb) { db.settings.startNode = fb.id; saveDb(); }
  else if (db.settings.startNode) { db.settings.startNode = null; saveDb(); }
  return { node: fb, healed: true };
}
// 把「节点 / 店铺 / 设施 id」统一解析为节点 id
function resolveNodeRef(ref) {
  if (!ref) return null;
  if (nodeById(ref)) return ref;
  const sn = db.graph.nodes.find((n) => n.shopId === ref);
  if (sn) return sn.id;
  const fn = db.graph.nodes.find((n) => n.facilityId === ref);
  if (fn) return fn.id;
  return null;
}

// ---------- 路网 ----------
function buildAdj() {
  const adj = {};
  db.graph.nodes.forEach((n) => (adj[n.id] = []));
  db.graph.edges.forEach((e) => {
    const a = nodeById(e.from), b = nodeById(e.to);
    if (!a || !b) return;
    const w = typeof e.weight === 'number' ? e.weight : dist(a, b);
    adj[e.from].push({ to: e.to, w, type: e.type || 'walk' });
    adj[e.to].push({ to: e.from, w, type: e.type || 'walk' });
  });
  return adj;
}
function graphConnectivity() {
  const adj = buildAdj();
  const seen = new Set(); let components = 0;
  db.graph.nodes.forEach((n) => {
    if (seen.has(n.id)) return;
    components++; const stack = [n.id]; seen.add(n.id);
    while (stack.length) {
      const cur = stack.pop();
      (adj[cur] || []).forEach((e) => { if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); } });
    }
  });
  const isolated = db.graph.nodes.filter((n) => (adj[n.id] || []).length === 0).map((n) => n.id);
  return { nodes: db.graph.nodes.length, edges: db.graph.edges.length, components, isolated };
}
function autoConnectGraph(opts) {
  const o = opts || {};
  const maxDist = Math.max(40, Number(o.maxDist) || 320);
  const k = Math.max(1, Math.min(4, Number(o.k) || 2));
  const withCrossFloor = o.crossFloor !== false;
  const added = [];
  const keyOf = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const exists = new Set(db.graph.edges.map((e) => keyOf(String(e.from), String(e.to))));
  const add = (aId, bId, type) => {
    if (!aId || !bId || aId === bId) return false;
    const kk = keyOf(aId, bId);
    if (exists.has(kk)) return false;
    const a = nodeById(aId), b = nodeById(bId);
    if (!a || !b) return false;
    exists.add(kk);
    db.graph.edges.push({ id: uid('E'), from: aId, to: bId, type: type || 'walk', weight: Math.round(dist(a, b)) });
    added.push({ from: aId, to: bId, type: type || 'walk' });
    return true;
  };
  const byFloor = {};
  db.graph.nodes.forEach((n) => { (byFloor[n.floorId] = byFloor[n.floorId] || []).push(n); });
  Object.values(byFloor).forEach((list) => {
    list.forEach((n) => {
      list.filter((m) => m.id !== n.id).sort((p, q) => dist(n, p) - dist(n, q)).slice(0, k)
        .forEach((m) => { if (dist(n, m) <= maxDist) add(n.id, m.id, 'walk'); });
    });
    if (list.length > 1) {
      const inTree = new Set([list[0].id]);
      while (inTree.size < list.length) {
        let best = null;
        list.forEach((a) => { if (!inTree.has(a.id)) return; list.forEach((b) => { if (inTree.has(b.id)) return; const dd = dist(a, b); if (!best || dd < best.d) best = { a: a.id, b: b.id, d: dd }; }); });
        if (!best) break;
        add(best.a, best.b, 'walk'); inTree.add(best.b);
      }
    }
  });
  if (withCrossFloor) {
    const ordered = [...db.floors].sort((a, b) => (Number(a.level) || 0) - (Number(b.level) || 0));
    for (let i = 1; i < ordered.length; i++) {
      const A = byFloor[ordered[i - 1].id] || [], B = byFloor[ordered[i].id] || [];
      if (!A.length || !B.length) continue;
      let best = null;
      A.forEach((a) => B.forEach((b) => { const dd = dist(a, b); if (!best || dd < best.d) best = { a: a.id, b: b.id, d: dd }; }));
      if (best) add(best.a, best.b, 'floor');
    }
  }
  saveDb();
  return { added: added.length, connectivity: graphConnectivity() };
}

// ---------- 路径规划（Dijkstra + 跨楼层分段 + 文字指引） ----------
function dijkstra(adj, startId, endId) {
  const distMap = {}, prev = {}, visited = {};
  Object.keys(adj).forEach((k) => (distMap[k] = Infinity));
  distMap[startId] = 0;
  const pq = [{ id: startId, d: 0 }];
  while (pq.length) {
    pq.sort((a, b) => a.d - b.d);
    const cur = pq.shift();
    if (visited[cur.id]) continue;
    visited[cur.id] = true;
    if (cur.id === endId) break;
    (adj[cur.id] || []).forEach((edge) => {
      const nd = cur.d + edge.w;
      if (nd < distMap[edge.to]) { distMap[edge.to] = nd; prev[edge.to] = { id: cur.id, type: edge.type }; pq.push({ id: edge.to, d: nd }); }
    });
  }
  if (distMap[endId] === Infinity) return null;
  const path = [];
  let cur = endId;
  while (cur) {
    path.unshift(cur);
    if (cur === startId) break;
    const p = prev[cur];
    if (!p) break;
    path._edgeType = path._edgeType || {};
    path._edgeType[cur] = p.type;
    cur = p.id;
  }
  return { path, cost: distMap[endId] };
}
function dirText(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return '向前';
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const dirs = [[0, '东'], [45, '东南'], [90, '南'], [135, '西南'], [180, '西'], [-135, '西北'], [-90, '北'], [-45, '东北']];
  let best = '东', bestDiff = 999;
  for (const [a, name] of dirs) {
    const diff = Math.abs(((angle - a + 540) % 360) - 180);
    if (diff < bestDiff) { bestDiff = diff; best = name; }
  }
  return '向' + best;
}
// 判断两个节点之间的边是否为跨层（电梯/扶梯/楼梯）
function isVerticalHop(a, b, edgeType) {
  if (a.floorId !== b.floorId) return true;
  return edgeType === 'floor' || edgeType === 'escalator' || edgeType === 'elevator';
}
function planRoute(fromId, toId) {
  const start = nodeById(fromId), end = nodeById(toId);
  if (!start || !end) return { ok: false, error: '起点或终点不存在' };
  const adj = buildAdj();
  const r = dijkstra(adj, fromId, toId);
  if (!r) return { ok: false, error: '两点之间无可达路线' };

  const nodeList = r.path.map((id) => {
    const n = nodeById(id);
    return { id: n.id, name: nodeName(n), x: n.x, y: n.y, floorId: n.floorId, shopId: n.shopId || null, facilityId: n.facilityId || null };
  });

  let totalPx = 0;
  for (let i = 1; i < nodeList.length; i++) totalPx += dist(nodeList[i - 1], nodeList[i]);
  const plan = (floorById(start.floorId) || {}).plan;
  const totalMeters = Math.max(1, Math.round(pxToMeters(totalPx, plan)));

  // 按楼层切分为 legs
  const legs = [];
  let curLeg = null, prevFloor = null;
  for (const node of nodeList) {
    if (!curLeg || node.floorId !== prevFloor) { curLeg = { floorId: node.floorId, floorName: floorShort(node.floorId), nodes: [] }; legs.push(curLeg); prevFloor = node.floorId; }
    curLeg.nodes.push(node);
  }

  // 文字步骤
  const steps = [];
  let idx = 0;
  steps.push({ idx: ++idx, type: 'start', text: `从【${nodeName(start) || '当前位置'}】出发` });
  let i = 0;
  while (i < nodeList.length - 1) {
    const a = nodeList[i], b = nodeList[i + 1];
    const et = (r.path._edgeType && r.path._edgeType[b.id]) || 'walk';
    if (isVerticalHop(a, b, et)) {
      // 连续跨层合并为一步（如 1F→2F→3F→4F 直接提示“上行至 4F”），避免步骤冗长
      let endI = i + 1;
      const bf = b.facilityId ? facById(b.facilityId) : null;
      let mode = bf ? (bf.name || facMeta(bf.type).label) : '电梯/扶梯';
      while (endI < nodeList.length - 1) {
        const x = nodeList[endI], y = nodeList[endI + 1];
        const e2 = (r.path._edgeType && r.path._edgeType[y.id]) || 'walk';
        if (!isVerticalHop(x, y, e2)) break;
        endI++;
      }
      const last = nodeList[endI];
      const la = (floorById(a.floorId) || {}).level || 0, lb = (floorById(last.floorId) || {}).level || 0;
      const verb = lb > la ? '上' : '下';
      steps.push({ idx: ++idx, type: 'floor', text: `乘${mode || '电梯/扶梯'}${verb}行至【${floorShort(last.floorId)}】` });
      i = endI; continue;
    }
    // 同层合并同类方向
    let j = i, acc = 0, lastDir = null;
    while (j < nodeList.length - 1) {
      const x = nodeList[j], y = nodeList[j + 1];
      const e2 = (r.path._edgeType && r.path._edgeType[y.id]) || 'walk';
      if (isVerticalHop(x, y, e2)) break;
      const d = dirText(x, y);
      if (lastDir && d !== lastDir) break;
      if (!lastDir) lastDir = d;
      acc += Math.round(pxToMeters(dist(x, y), plan));
      j++;
    }
    if (acc > 0) steps.push({ idx: ++idx, type: 'walk', text: `${lastDir}直行约 ${acc} 米` });
    i = j;
  }
  steps.push({ idx: ++idx, type: 'arrive', text: `您已到达【${nodeName(end)}】，祝您购物愉快！` });

  return {
    ok: true,
    from: { id: start.id, name: nodeName(start), floorId: start.floorId, floorName: floorShort(start.floorId) },
    to: { id: end.id, name: nodeName(end), floorId: end.floorId, floorName: floorShort(end.floorId), shopId: end.shopId || null, facilityId: end.facilityId || null },
    totalMeters, nodePath: nodeList, legs, steps
  };
}

// ---------- 静态文件 ----------
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendText(res, 404, '404 Not Found');
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    // 支持 Range 请求：视频（活动页/Banner 素材）需要它才能拖动进度条与快速起播
    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= stat.size) end = stat.size - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }); return res.end(); }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': 'no-cache, must-revalidate'
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache, must-revalidate' });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;
  const method = req.method.toUpperCase();
  if (pathname.startsWith('/api/')) return handleApi(req, res, method, pathname, parsed);
  return serveStatic(req, res, pathname);
});

async function handleApi(req, res, method, pathname, parsed) {
  const q = parsed.searchParams;

  // ===== 公开只读接口 =====
  if (method === 'GET' && pathname === '/api/floors') return sendJson(res, 200, { ok: true, data: floorsSorted() });
  if (method === 'GET' && pathname === '/api/categories') return sendJson(res, 200, { ok: true, data: CATEGORIES });
  if (method === 'GET' && pathname === '/api/facility-types') return sendJson(res, 200, { ok: true, data: FACILITY_TYPES });
  if (method === 'GET' && pathname === '/api/shops') {
    const fid = q.get('floorId');
    const list = fid ? db.shops.filter((s) => s.floorId === fid) : db.shops;
    return sendJson(res, 200, { ok: true, data: list.map(shopOut) });
  }
  if (method === 'GET' && pathname === '/api/facilities') {
    const fid = q.get('floorId');
    const list = fid ? db.facilities.filter((f) => f.floorId === fid) : db.facilities;
    return sendJson(res, 200, { ok: true, data: list.map(facOut) });
  }
  if (method === 'GET' && pathname === '/api/promos') return sendJson(res, 200, { ok: true, data: db.promos.map(promoOut) });
  if (method === 'GET' && pathname === '/api/banners') return sendJson(res, 200, { ok: true, data: db.banners });

  // 全量数据（前台一次取）
  if (method === 'GET' && pathname === '/api/map') {
    const rs = resolveStartNode();
    return sendJson(res, 200, {
      ok: true,
      floors: floorsSorted(),
      shops: db.shops.map(shopOut),
      facilities: db.facilities.map(facOut),
      promos: db.promos.map(promoOut),
      banners: db.banners,
      graph: { nodes: db.graph.nodes.map(nodeOut), edges: db.graph.edges },
      categories: CATEGORIES,
      facilityTypes: FACILITY_TYPES,
      settings: {
        mallName: db.settings.mallName || '商场智能导视系统',
        slogan: db.settings.slogan || '',
        address: db.settings.address || '',
        servicePhone: db.settings.servicePhone || '',
        businessHours: db.settings.businessHours || '',
        startNode: rs.node ? rs.node.id : null,
        startName: rs.node ? nodeName(rs.node) : '',
        startHealed: rs.healed,
        scalePxPerM: Number(db.settings.scalePxPerM) || 10,
        idleSeconds: Number(db.settings.idleSeconds) || 90,
        screensaverSeconds: Number(db.settings.screensaverSeconds) || 45,
        screensaver: db.settings.screensaver,
        guide: db.settings.guide
      }
    });
  }

  // 路线规划
  if ((method === 'GET' || method === 'POST') && pathname === '/api/route') {
    let from, to;
    if (method === 'POST') { const b = await readBody(req); from = b.from; to = b.to; }
    else { from = q.get('from'); to = q.get('to'); }
    if (!to) return sendJson(res, 400, { ok: false, error: '缺少 to（目的地）参数' });

    const toRef = resolveNodeRef(to);
    if (!toRef) {
      const shop = shopById(to), fac = facById(to);
      const nm = shop ? shop.name : (fac ? fac.name : to);
      return sendJson(res, 400, { ok: false, error: `「${nm}」尚未接入导视路网：请在后台「节点与连线」中为其放置并连接导航节点` });
    }
    let startRef = resolveNodeRef(from);
    let startFallback = false;
    if (!startRef) { startRef = (resolveStartNode().node || {}).id || null; startFallback = true; }
    if (!startRef) return sendJson(res, 400, { ok: false, error: '未设置有效起点：请在后台「系统设置」中指定起点节点' });

    const result = planRoute(startRef, toRef);
    if (!result.ok && /无可达路线/.test(result.error || '')) {
      const conn = graphConnectivity();
      result.error = `未找到连通路线（当前 ${conn.nodes} 个节点、${conn.edges} 条连线，${conn.isolated.length} 个孤立节点），请在后台「节点与连线」中补充连线或使用「一键生成路网连线」。`;
      result.connectivity = conn;
    }
    if (result.ok && startFallback) { result.startFallback = true; result.startNode = startRef; }
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  // 屏幕端自助取配置（公开，无需鉴权）：按自身标识返回专属展示参数（轮询 rev 实现远程切换）
  const pubScreen = pathname.match(/^\/api\/screen\/([^/]+)$/);
  if (pubScreen && method === 'GET') {
    return sendJson(res, 200, { ok: true, data: resolveScreenProfile(decodeURIComponent(pubScreen[1])) });
  }

  // 管理员登录
  if (method === 'POST' && pathname === '/api/login') {
    const body = await readBody(req);
    if (body.pass === db.settings.adminPass) return sendJson(res, 200, { ok: true, token: db.settings.adminPass });
    return sendJson(res, 401, { ok: false, error: '密码错误' });
  }

  // ===== 以下为管理员接口 =====
  if (!isAdmin(req)) return sendJson(res, 401, { ok: false, error: '未授权，请先登录' });

  if (method === 'GET' && pathname === '/api/graph/connectivity') return sendJson(res, 200, { ok: true, data: graphConnectivity() });
  if (method === 'POST' && pathname === '/api/graph/autoconnect') {
    const b = await readBody(req);
    return sendJson(res, 200, { ok: true, data: autoConnectGraph({ maxDist: b.maxDist, k: b.k, crossFloor: b.crossFloor }) });
  }

  // 系统设置
  if (pathname === '/api/settings') {
    if (method === 'GET') {
      const rs = resolveStartNode();
      return sendJson(res, 200, { ok: true, data: {
        startNode: db.settings.startNode || null, startName: rs.node ? nodeName(rs.node) : '',
        startValid: !!rs.node, mallName: db.settings.mallName || '', slogan: db.settings.slogan || '',
        address: db.settings.address || '', servicePhone: db.settings.servicePhone || '',
        businessHours: db.settings.businessHours || '', scalePxPerM: Number(db.settings.scalePxPerM) || 10,
        idleSeconds: Number(db.settings.idleSeconds) || 90, screensaverSeconds: Number(db.settings.screensaverSeconds) || 45,
        adminPass: db.settings.adminPass || ''
      } });
    }
    if (method === 'PUT') {
      const b = await readBody(req);
      if (b.startNode !== undefined) { if (b.startNode && !nodeById(b.startNode)) return sendJson(res, 400, { ok: false, error: '所选起点节点不存在' }); db.settings.startNode = b.startNode || null; }
      ['mallName', 'slogan', 'address', 'servicePhone', 'businessHours'].forEach((k) => { if (b[k] != null) db.settings[k] = String(b[k]); });
      if (b.scalePxPerM != null) db.settings.scalePxPerM = Number(b.scalePxPerM) || 10;
      if (b.idleSeconds != null) db.settings.idleSeconds = Math.max(10, Number(b.idleSeconds) || 90);
      if (b.screensaverSeconds != null) {
        db.settings.screensaverSeconds = Math.max(5, Number(b.screensaverSeconds) || 45);
        if (db.settings.screensaver) db.settings.screensaver.idleSeconds = Math.max(10, Number(b.screensaverSeconds) || 45);
      }
      if (b.adminPass != null && String(b.adminPass).trim()) db.settings.adminPass = String(b.adminPass).trim();
      saveDb();
      const s = nodeById(db.settings.startNode);
      return sendJson(res, 200, { ok: true, data: { startNode: db.settings.startNode || null, startName: s ? nodeName(s) : '', startValid: !!s } });
    }
  }

  // ---- 待机页（屏保）：播放参数 ----
  if (pathname === '/api/screensaver') {
    if (method === 'GET') return sendJson(res, 200, { ok: true, data: db.settings.screensaver });
    if (method === 'PUT') {
      const b = await readBody(req);
      const s = db.settings.screensaver;
      ['enabled', 'loop', 'mute', 'showClock', 'showMallName', 'showHint', 'showProgress'].forEach((k) => { if (b[k] != null) s[k] = !!b[k]; });
      if (b.transition != null && SS_TRANSITIONS.includes(b.transition)) s.transition = b.transition;
      if (b.order != null && SS_ORDERS.includes(b.order)) s.order = b.order;
      if (b.videoMode != null && SS_VIDEO_MODES.includes(b.videoMode)) s.videoMode = b.videoMode;
      if (b.tapAction != null && SS_TAP_ACTIONS.includes(b.tapAction)) s.tapAction = b.tapAction;
      if (b.pageTap != null && SS_PAGE_TAPS.includes(b.pageTap)) s.pageTap = b.pageTap;
      if (b.interval != null) s.interval = Math.max(3, Math.min(300, Number(b.interval) || s.interval));
      if (b.dim != null) s.dim = Math.max(0, Math.min(0.7, Number(b.dim) || 0));
      if (b.idleSeconds != null) {
        s.idleSeconds = Math.max(10, Number(b.idleSeconds) || s.idleSeconds);
        db.settings.screensaverSeconds = s.idleSeconds;
      }
      saveDb();
      return sendJson(res, 200, { ok: true, data: s });
    }
  }
  // ---- 待机页：新增素材 ----
  if (method === 'POST' && pathname === '/api/screensaver/items') {
    const b = await readBody(req);
    const it = normScreenItem(b);
    if (!it.url) return sendJson(res, 400, { ok: false, error: '请先上传素材或填写链接' });
    if (b.duration == null) it.duration = Math.max(3, Number(db.settings.screensaver.interval) || 8);
    db.settings.screensaver.items.push(it);
    saveDb();
    return sendJson(res, 200, { ok: true, data: it });
  }
  // ---- 待机页：节目单排序 ----
  if (method === 'POST' && pathname === '/api/screensaver/reorder') {
    const b = await readBody(req);
    const ids = Array.isArray(b.ids) ? b.ids : [];
    const cur = db.settings.screensaver.items;
    const byId = new Map(cur.map((x) => [x.id, x]));
    const next = ids.map((id) => byId.get(id)).filter(Boolean);
    cur.forEach((x) => { if (!ids.includes(x.id)) next.push(x); });
    db.settings.screensaver.items = next;
    saveDb();
    return sendJson(res, 200, { ok: true, data: next });
  }
  // ---- 待机页：单条素材 改 / 删 ----
  const sm = pathname.match(/^\/api\/screensaver\/items\/([^/]+)$/);
  if (sm) {
    const id = sm[1];
    const it = db.settings.screensaver.items.find((x) => x.id === id);
    if (method === 'PUT') {
      if (!it) return sendJson(res, 404, { ok: false, error: '素材不存在' });
      const b = await readBody(req);
      if (b.type != null && ['image', 'video', 'page'].includes(b.type)) it.type = b.type;
      if (b.url != null) it.url = String(b.url).trim();
      if (b.title != null) it.title = String(b.title);
      if (b.sub != null) it.sub = String(b.sub);
      if (b.duration != null) it.duration = Math.max(3, Math.min(300, Number(b.duration) || it.duration));
      if (b.enabled != null) it.enabled = !!b.enabled;
      if (b.promoId !== undefined) it.promoId = String(b.promoId || '').trim(); // 关联活动；'' = 不关联
      if (!it.url) return sendJson(res, 400, { ok: false, error: '素材地址不能为空' });
      saveDb();
      return sendJson(res, 200, { ok: true, data: it });
    }
    if (method === 'DELETE') {
      if (!it) return sendJson(res, 404, { ok: false, error: '素材不存在' });
      db.settings.screensaver.items = db.settings.screensaver.items.filter((x) => x.id !== id);
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- 服务指南：总配置（标题/副标题/总开关） ----
  if (pathname === '/api/guide') {
    if (method === 'GET') return sendJson(res, 200, { ok: true, data: db.settings.guide });
    if (method === 'PUT') {
      const b = await readBody(req);
      const g = db.settings.guide;
      if (b.enabled != null) g.enabled = !!b.enabled;
      if (typeof b.title === 'string' && b.title.trim()) g.title = b.title.trim().slice(0, GUIDE_TITLE_MAX);
      if (typeof b.sub === 'string') g.sub = b.sub.trim();
      saveDb();
      return sendJson(res, 200, { ok: true, data: g });
    }
  }
  // ---- 服务指南：新增卡片 ----
  if (method === 'POST' && pathname === '/api/guide/cards') {
    const b = await readBody(req);
    const c = normGuideCard(b);
    if (!c.title) return sendJson(res, 400, { ok: false, error: '请填写卡片标题' });
    db.settings.guide.cards.push(c);
    saveDb();
    return sendJson(res, 200, { ok: true, data: c });
  }
  // ---- 服务指南：恢复默认卡片（注意：需排在 /cards/:id 之前） ----
  if (method === 'POST' && pathname === '/api/guide/reset') {
    db.settings.guide = defaultGuide();
    saveDb();
    return sendJson(res, 200, { ok: true, data: db.settings.guide });
  }
  // ---- 服务指南：卡片排序 ----
  if (method === 'POST' && pathname === '/api/guide/cards/reorder') {
    const b = await readBody(req);
    const ids = Array.isArray(b.ids) ? b.ids : [];
    const cur = db.settings.guide.cards;
    const byId = new Map(cur.map((x) => [x.id, x]));
    const next = ids.map((id) => byId.get(id)).filter(Boolean);
    cur.forEach((x) => { if (!ids.includes(x.id)) next.push(x); });
    db.settings.guide.cards = next;
    saveDb();
    return sendJson(res, 200, { ok: true, data: next });
  }
  // ---- 服务指南：单张卡片 改 / 删 ----
  const gdm = pathname.match(/^\/api\/guide\/cards\/([^/]+)$/);
  if (gdm) {
    const id = gdm[1];
    const c = db.settings.guide.cards.find((x) => x.id === id);
    if (method === 'PUT') {
      if (!c) return sendJson(res, 404, { ok: false, error: '卡片不存在' });
      const b = await readBody(req);
      if (b.icon != null) {
        const ico = [...String(b.icon).trim()].slice(0, 4).join('');
        c.icon = ico || 'ℹ️';
      }
      if (b.title != null) {
        const t = String(b.title).trim().slice(0, GUIDE_TITLE_MAX);
        if (!t) return sendJson(res, 400, { ok: false, error: '卡片标题不能为空' });
        c.title = t;
      }
      if (b.items !== undefined) c.items = normGuideItems(b.items);
      if (b.enabled != null) c.enabled = !!b.enabled;
      if (b.color !== undefined) c.color = (typeof b.color === 'string') ? b.color.trim().slice(0, 32) : '';
      if (b.colorMode != null) c.colorMode = (b.colorMode === 'bg') ? 'bg' : 'border';
      if (b.bgImage !== undefined) {
        const raw = (typeof b.bgImage === 'string') ? b.bgImage.trim() : '';
        c.bgImage = /^(\/|https?:\/\/|data:image\/)[^'"()<> ]{0,240}$/.test(raw) ? raw : '';
      }
      saveDb();
      return sendJson(res, 200, { ok: true, data: c });
    }
    if (method === 'DELETE') {
      if (!c) return sendJson(res, 404, { ok: false, error: '卡片不存在' });
      db.settings.guide.cards = db.settings.guide.cards.filter((x) => x.id !== id);
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }

  let m;
  // ---- 多屏管理：屏幕登记表（admin）----
  if (pathname === '/api/screens') {
    if (method === 'GET') return sendJson(res, 200, { ok: true, data: db.screens });
    if (method === 'POST') {
      const b = await readBody(req);
      const id = normScreenId(b.id);
      if (!id) return sendJson(res, 400, { ok: false, error: '屏幕标识（ID）不能为空，仅允许字母/数字/中划线/点' });
      if (db.screens.some((x) => x.id === id)) return sendJson(res, 400, { ok: false, error: '屏幕标识已存在：' + id });
      const s = normScreens([Object.assign({}, b, { id })], db.floors)[0];
      db.screens.push(s);
      saveDb();
      return sendJson(res, 200, { ok: true, data: s });
    }
  }
  m = pathname.match(/^\/api\/screens\/([^/]+)(\/push)?$/);
  if (m) {
    const id = m[1];
    // 立即切换 / 重新下发：仅 rev+1，屏端轮询到即自动重新应用
    if (m[2] && method === 'POST') {
      const s = db.screens.find((x) => x.id === id);
      if (!s) return sendJson(res, 404, { ok: false, error: '屏幕不存在' });
      s.rev = (Number(s.rev) || 0) + 1;
      saveDb();
      return sendJson(res, 200, { ok: true, data: s });
    }
    if (method === 'GET') {
      const s = db.screens.find((x) => x.id === id);
      if (!s) return sendJson(res, 404, { ok: false, error: '屏幕不存在' });
      return sendJson(res, 200, { ok: true, data: s });
    }
    if (method === 'PUT') {
      const s = db.screens.find((x) => x.id === id);
      if (!s) return sendJson(res, 404, { ok: false, error: '屏幕不存在' });
      const b = await readBody(req);
      const next = normScreens([Object.assign({}, s, b, { id: s.id, rev: (Number(s.rev) || 0) + 1 })], db.floors)[0];
      db.screens[db.screens.indexOf(s)] = next;
      saveDb();
      return sendJson(res, 200, { ok: true, data: next });
    }
    if (method === 'DELETE') {
      const i = db.screens.findIndex((x) => x.id === id);
      if (i < 0) return sendJson(res, 404, { ok: false, error: '屏幕不存在' });
      db.screens.splice(i, 1);
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- 楼层 CRUD ----
  if (pathname === '/api/floors') {
    if (method === 'GET') return sendJson(res, 200, { ok: true, data: floorsSorted() });
    if (method === 'POST') {
      const b = await readBody(req);
      const maxLevel = db.floors.reduce((mx, f) => Math.max(mx, Number(f.level) || 0), 0);
      let id = nextFloorId();
      const want = String(b.id || '').trim();
      if (FLOOR_ID_RE.test(want) && !db.floors.some((f) => f.id === want)) id = want;
      const f = { id, name: b.name || '新楼层', short: b.short || `F${maxLevel + 1}`, level: Number(b.level) || maxLevel + 1, theme: b.theme || '', plan: { mode: 'draw', width: 1000, height: 700, scalePxPerM: Number(db.settings.scalePxPerM) || 10, originX: 0, originY: 0, walls: [], objects: [] } };
      db.floors.push(f);
      compactFloorIds();
      saveDb();
      return sendJson(res, 200, { ok: true, data: db.floors.find((x) => x.id === f.id) || f });
    }
  }
  m = pathname.match(/^\/api\/floors\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (method === 'PUT') {
      const b = await readBody(req);
      const f = db.floors.find((x) => x.id === id);
      if (!f) return sendJson(res, 404, { ok: false, error: '楼层不存在' });
      ['name', 'short', 'theme'].forEach((k) => { if (b[k] != null) f[k] = b[k]; });
      if (b.level != null) f.level = Number(b.level);
      saveDb();
      return sendJson(res, 200, { ok: true, data: f });
    }
    if (method === 'DELETE') {
      if (!db.floors.some((x) => x.id === id)) return sendJson(res, 404, { ok: false, error: '楼层不存在' });
      db.shops = db.shops.filter((s) => s.floorId !== id);
      db.facilities = db.facilities.filter((f) => f.floorId !== id);
      db.graph.nodes = db.graph.nodes.filter((n) => n.floorId !== id);
      pruneOrphanEdges();
      db.floors = db.floors.filter((x) => x.id !== id);
      pruneNodeRefs();
      compactFloorIds();
      resolveStartNode();
      saveDb();
      return sendJson(res, 200, { ok: true, data: floorsSorted() });
    }
  }
  // 楼层平面（墙体等）
  m = pathname.match(/^\/api\/floors\/([^/]+)\/plan$/);
  if (m) {
    const f = db.floors.find((x) => x.id === m[1]);
    if (!f) return sendJson(res, 404, { ok: false, error: '楼层不存在' });
    if (method === 'PUT') {
      const b = await readBody(req);
      const p = f.plan || (f.plan = {});
      if (b.mode != null) p.mode = ['none', 'draw', 'image'].includes(b.mode) ? b.mode : 'draw';
      if (b.scalePxPerM != null) p.scalePxPerM = Number(b.scalePxPerM) || 10;
      if (b.originX != null) p.originX = Number(b.originX);
      if (b.originY != null) p.originY = Number(b.originY);
      if (b.image !== undefined) p.image = b.image || null;
      if (b.imageRect && typeof b.imageRect === 'object') {
        p.imageRect = {
          x: Number(b.imageRect.x) || 0, y: Number(b.imageRect.y) || 0,
          w: Math.max(20, Number(b.imageRect.w) || p.width), h: Math.max(20, Number(b.imageRect.h) || p.height)
        };
      }
      if (b.imageOpacity != null) p.imageOpacity = Math.max(0, Math.min(1, Number(b.imageOpacity)));
      if (b.showImage != null) p.showImage = !!b.showImage;
      if (Array.isArray(b.walls)) p.walls = b.walls.filter((w) => w && isFinite(Number(w.x1)) && isFinite(Number(w.y1)) && isFinite(Number(w.x2)) && isFinite(Number(w.y2))).map((w) => ({ x1: +w.x1, y1: +w.y1, x2: +w.x2, y2: +w.y2, w: Number(w.w) || 5 }));
      saveDb();
      return sendJson(res, 200, { ok: true, data: f.plan });
    }
  }
  // 通用素材上传（店铺 Logo / 活动页面 / Banner 素材）：图片 或 视频
  if (method === 'POST' && pathname === '/api/upload/asset') {
    const b = await readBody(req, 70e6);
    const mm = String(b.dataUrl || '').match(/^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/);
    if (!mm) return sendJson(res, 400, { ok: false, error: '无效的文件数据' });
    const mime = mm[1].toLowerCase();
    const isImg = mime.startsWith('image/');
    const isVid = mime.startsWith('video/');
    if (!isImg && !isVid) return sendJson(res, 400, { ok: false, error: '仅支持图片或视频文件（互动网页请直接填写链接）' });
    let ext = (mime.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace('+xml', '');
    const IMG = ['png', 'jpg', 'gif', 'webp', 'svg', 'bmp'];
    const VID = ['mp4', 'webm', 'ogg', 'mov'];
    if (isImg && !IMG.includes(ext)) ext = 'png';
    if (isVid && !VID.includes(ext)) ext = 'mp4';
    const buf = Buffer.from(mm[2], 'base64');
    const limit = isVid ? 40e6 : 4e6;
    if (buf.length > limit) return sendJson(res, 400, { ok: false, error: (isVid ? '视频' : '图片') + '过大（上限 ' + (limit / 1e6) + 'MB）' });
    const prefix = String(b.prefix || 'asset').replace(/[^\w-]/g, '').slice(0, 24) || 'asset';
    const upDir = path.join(PUBLIC_DIR, 'uploads');
    try { fs.mkdirSync(upDir, { recursive: true }); } catch (e) { /* ignore */ }
    const fname = `${prefix}_${Date.now().toString(36)}.${ext}`;
    try { fs.writeFileSync(path.join(upDir, fname), buf); }
    catch (e) { return sendJson(res, 500, { ok: false, error: '写入文件失败' }); }
    return sendJson(res, 200, { ok: true, url: '/uploads/' + fname, kind: isVid ? 'video' : 'image', size: buf.length, ext });
  }

  // 上传平面图底图
  if (method === 'POST' && pathname === '/api/upload/plan') {
    const b = await readBody(req, 15e6);
    const mm = String(b.dataUrl || '').match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
    if (!mm) return sendJson(res, 400, { ok: false, error: '无效的图片数据' });
    let ext = (mm[1].split('/')[1] || 'png').replace('jpeg', 'jpg').replace('+xml', '');
    if (!['png', 'jpg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) ext = 'png';
    const buf = Buffer.from(mm[2], 'base64');
    if (buf.length > 8e6) return sendJson(res, 400, { ok: false, error: '图片过大（≤8MB）' });
    const f = db.floors.find((x) => x.id === b.floorId);
    if (!f) return sendJson(res, 404, { ok: false, error: '楼层不存在' });
    const upDir = path.join(PUBLIC_DIR, 'uploads');
    try { fs.mkdirSync(upDir, { recursive: true }); } catch (e) { /* ignore */ }
    const fname = `plan_${f.id}.${ext}`;
    fs.writeFileSync(path.join(upDir, fname), buf);
    f.plan = f.plan || {};
    f.plan.image = '/uploads/' + fname;
    f.plan.mode = 'image';
    f.plan.imageRect = f.plan.imageRect || { x: 0, y: 0, w: f.plan.width || 1000, h: f.plan.height || 700 };
    if (typeof f.plan.imageOpacity !== 'number') f.plan.imageOpacity = 1;
    if (typeof f.plan.showImage !== 'boolean') f.plan.showImage = true;
    saveDb();
    return sendJson(res, 200, { ok: true, url: '/uploads/' + fname, plan: f.plan });
  }

  // ---- 店铺 CRUD ----
  if (pathname === '/api/shops') {
    if (method === 'GET') return sendJson(res, 200, { ok: true, data: db.shops.map(shopOut) });
    if (method === 'POST') {
      const b = await readBody(req);
      if (!b.name) return sendJson(res, 400, { ok: false, error: '请填写店铺名称' });
      if (b.floorId && !floorById(b.floorId)) return sendJson(res, 400, { ok: false, error: '楼层不存在' });
      const meta = catMeta(b.cat || 'other');
      const s = {
        id: b.id || uid('S'), name: String(b.name), floorId: b.floorId || (db.floors[0] || {}).id, cat: b.cat || 'other',
        letter: (b.letter || String(b.name)[0] || 'A').toUpperCase().slice(0, 1),
        x: num(b.x, 100), y: num(b.y, 100), w: Math.max(20, num(b.w, 140)), h: Math.max(20, num(b.h, 90)),
        color: b.color || meta.color, phone: b.phone || '', hours: b.hours || '10:00 - 22:00',
        logo: b.logo || '',
        desc: b.desc || '', tags: Array.isArray(b.tags) ? b.tags : []
      };
      db.shops.push(s);
      saveDb();
      return sendJson(res, 200, { ok: true, data: shopOut(s) });
    }
  }
  m = pathname.match(/^\/api\/shops\/([^/]+)$/);
  if (m) {
    const id = m[1];
    const s = db.shops.find((x) => x.id === id);
    if (method === 'PUT') {
      if (!s) return sendJson(res, 404, { ok: false, error: '店铺不存在' });
      const b = await readBody(req);
      ['name', 'floorId', 'cat', 'color', 'phone', 'hours', 'desc', 'logo'].forEach((k) => { if (b[k] != null) s[k] = b[k]; });
      if (b.letter != null) s.letter = String(b.letter).toUpperCase().slice(0, 1);
      ['x', 'y', 'w', 'h'].forEach((k) => { if (b[k] != null) s[k] = Number(b[k]); });
      if (Array.isArray(b.tags)) s.tags = b.tags;
      saveDb();
      return sendJson(res, 200, { ok: true, data: shopOut(s) });
    }
    if (method === 'DELETE') {
      if (!s) return sendJson(res, 404, { ok: false, error: '店铺不存在' });
      db.shops = db.shops.filter((x) => x.id !== id);
      db.graph.nodes.forEach((n) => { if (n.shopId === id) delete n.shopId; }); // 节点保留，避免破坏路网
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- 设施 CRUD ----
  if (pathname === '/api/facilities') {
    if (method === 'GET') return sendJson(res, 200, { ok: true, data: db.facilities.map(facOut) });
    if (method === 'POST') {
      const b = await readBody(req);
      if (b.floorId && !floorById(b.floorId)) return sendJson(res, 400, { ok: false, error: '楼层不存在' });
      const meta = facMeta(b.type || 'other');
      const f = { id: b.id || uid('FA'), type: b.type || 'other', name: b.name || meta.label, floorId: b.floorId || (db.floors[0] || {}).id, x: num(b.x, 100), y: num(b.y, 100) };
      db.facilities.push(f);
      saveDb();
      return sendJson(res, 200, { ok: true, data: facOut(f) });
    }
  }
  m = pathname.match(/^\/api\/facilities\/([^/]+)$/);
  if (m) {
    const id = m[1];
    const f = db.facilities.find((x) => x.id === id);
    if (method === 'PUT') {
      if (!f) return sendJson(res, 404, { ok: false, error: '设施不存在' });
      const b = await readBody(req);
      ['type', 'name', 'floorId'].forEach((k) => { if (b[k] != null) f[k] = b[k]; });
      ['x', 'y'].forEach((k) => { if (b[k] != null) f[k] = Number(b[k]); });
      saveDb();
      return sendJson(res, 200, { ok: true, data: facOut(f) });
    }
    if (method === 'DELETE') {
      if (!f) return sendJson(res, 404, { ok: false, error: '设施不存在' });
      db.facilities = db.facilities.filter((x) => x.id !== id);
      db.graph.nodes.forEach((n) => { if (n.facilityId === id) delete n.facilityId; });
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- 活动 CRUD ----
  if (pathname === '/api/promos') {
    if (method === 'GET') return sendJson(res, 200, { ok: true, data: db.promos.map(promoOut) });
    if (method === 'POST') {
      const b = await readBody(req);
      if (!b.title) return sendJson(res, 400, { ok: false, error: '请填写活动标题' });
      const p = { id: b.id || uid('PR'), title: String(b.title), cat: b.cat || '品牌特惠', startDate: b.startDate || '', endDate: b.endDate || '', floorId: b.floorId || '', color: b.color || '#ef6c4d', desc: b.desc || '', media: normMedia(b.media) };
      db.promos.unshift(p);
      saveDb();
      return sendJson(res, 200, { ok: true, data: promoOut(p) });
    }
  }
  m = pathname.match(/^\/api\/promos\/([^/]+)$/);
  if (m) {
    const id = m[1];
    const p = db.promos.find((x) => x.id === id);
    if (method === 'PUT') {
      if (!p) return sendJson(res, 404, { ok: false, error: '活动不存在' });
      const b = await readBody(req);
      ['title', 'cat', 'startDate', 'endDate', 'floorId', 'color', 'desc'].forEach((k) => { if (b[k] != null) p[k] = b[k]; });
      if (b.floorId !== undefined) p.floorId = b.floorId || '';
      if (b.media !== undefined) p.media = normMedia(b.media);
      saveDb();
      return sendJson(res, 200, { ok: true, data: promoOut(p) });
    }
    if (method === 'DELETE') {
      if (!p) return sendJson(res, 404, { ok: false, error: '活动不存在' });
      db.promos = db.promos.filter((x) => x.id !== id);
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- Banner CRUD ----
  if (pathname === '/api/banners') {
    if (method === 'GET') return sendJson(res, 200, { ok: true, data: db.banners });
    if (method === 'POST') {
      const b = await readBody(req);
      const bn = { id: b.id || uid('BN'), title: b.title || '新 Banner', sub: b.sub || '', bg: b.bg || 'linear-gradient(135deg,#4a7fe0,#7b5cff)', badge: b.badge || '', action: b.action || 'floor', media: normMedia(b.media) };
      db.banners.push(bn);
      saveDb();
      return sendJson(res, 200, { ok: true, data: bn });
    }
  }
  m = pathname.match(/^\/api\/banners\/([^/]+)$/);
  if (m) {
    const id = m[1];
    const bn = db.banners.find((x) => x.id === id);
    if (method === 'PUT') {
      if (!bn) return sendJson(res, 404, { ok: false, error: 'Banner 不存在' });
      const b = await readBody(req);
      ['title', 'sub', 'bg', 'badge', 'action'].forEach((k) => { if (b[k] != null) bn[k] = b[k]; });
      if (b.media !== undefined) bn.media = normMedia(b.media);
      saveDb();
      return sendJson(res, 200, { ok: true, data: bn });
    }
    if (method === 'DELETE') {
      if (!bn) return sendJson(res, 404, { ok: false, error: 'Banner 不存在' });
      db.banners = db.banners.filter((x) => x.id !== id);
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- 节点 CRUD ----
  if (pathname === '/api/nodes') {
    if (method === 'GET') return sendJson(res, 200, { ok: true, data: db.graph.nodes.map(nodeOut) });
    if (method === 'POST') {
      const b = await readBody(req);
      const n = { id: b.id || nextNodeId(), x: num(b.x, 0), y: num(b.y, 0), floorId: b.floorId || (db.floors[0] || {}).id };
      if (b.shopId) n.shopId = b.shopId;
      if (b.facilityId) n.facilityId = b.facilityId;
      db.graph.nodes.push(n);
      saveDb();
      return sendJson(res, 200, { ok: true, data: nodeOut(n) });
    }
  }
  m = pathname.match(/^\/api\/nodes\/([^/]+)$/);
  if (m) {
    const id = m[1];
    const n = nodeById(id);
    if (method === 'PUT') {
      if (!n) return sendJson(res, 404, { ok: false, error: '节点不存在' });
      const b = await readBody(req);
      ['x', 'y'].forEach((k) => { if (b[k] != null) n[k] = Number(b[k]); });
      if (b.floorId != null) n.floorId = b.floorId;
      if (b.shopId !== undefined) { if (b.shopId) n.shopId = b.shopId; else delete n.shopId; }
      if (b.facilityId !== undefined) { if (b.facilityId) n.facilityId = b.facilityId; else delete n.facilityId; }
      saveDb();
      return sendJson(res, 200, { ok: true, data: nodeOut(n) });
    }
    if (method === 'DELETE') {
      if (!n) return sendJson(res, 404, { ok: false, error: '节点不存在' });
      db.graph.nodes = db.graph.nodes.filter((x) => x.id !== id);
      db.graph.edges = db.graph.edges.filter((e) => e.from !== id && e.to !== id);
      resolveStartNode();
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- 边 CRUD ----
  if (pathname === '/api/edges') {
    if (method === 'GET') return sendJson(res, 200, { ok: true, data: db.graph.edges });
    if (method === 'POST') {
      const b = await readBody(req);
      if (!nodeById(b.from) || !nodeById(b.to)) return sendJson(res, 400, { ok: false, error: '端点节点不存在' });
      const e = { id: b.id || uid('E'), from: b.from, to: b.to, type: b.type || 'walk', weight: typeof b.weight === 'number' ? b.weight : undefined };
      db.graph.edges.push(e);
      saveDb();
      return sendJson(res, 200, { ok: true, data: e });
    }
  }
  m = pathname.match(/^\/api\/edges\/([^/]+)$/);
  if (m) {
    if (method === 'DELETE') {
      db.graph.edges = db.graph.edges.filter((x) => x.id !== m[1]);
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { ok: false, error: '接口不存在' });
}

// ---------- 启动自愈 ----------
compactFloorIds();
db.floors.forEach(ensureFloorPlan);
const __orphan = pruneOrphanEdges();
if (__orphan > 0) { console.warn(`[数据修复] 清理 ${__orphan} 条孤儿边`); saveDb(); }
const __refs = pruneNodeRefs();
if (__refs > 0) { console.warn(`[数据修复] 清理 ${__refs} 处失效节点引用`); saveDb(); }
resolveStartNode();

server.listen(PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log(' 商场 · 场馆智能导视系统 服务已启动');
  console.log(' 前台导视终端: http://localhost:' + PORT + '/');
  console.log(' 管理后台:     http://localhost:' + PORT + '/admin.html');
  console.log(' 局域网访问:   将 localhost 替换为本机内网 IP');
  console.log(' 管理密码:     ' + (db.settings.adminPass || '(未设置)'));
  console.log(' 楼层:         ' + db.floors.map((f) => `${f.id}=${f.name}(${f.short})`).join(', '));
  console.log(' 数据:         ' + db.shops.length + ' 店铺 / ' + db.facilities.length + ' 设施 / ' + db.graph.nodes.length + ' 节点');
  console.log('============================================');
});

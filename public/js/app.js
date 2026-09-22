/* ============================================================
   商场 · 场馆智能导视系统 - 前台逻辑（原生 JS，无依赖）
   模块：首页轮播 / 屏保广告 / 楼层地图 / 品牌导购 / 优惠活动 /
        服务指南 / 点位详情 / 路线导航
   ============================================================ */
const SVGNS = 'http://www.w3.org/2000/svg';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const svgEl = (n, attrs) => { const e = document.createElementNS(SVGNS, n); for (const k in (attrs || {})) e.setAttribute(k, attrs[k]); return e; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- 全局状态 ---------------- */
let M = null;
let floors = [], shops = [], facilities = [], promos = [], banners = [], graph = { nodes: [], edges: [] }, settings = {}, cats = [], facTypes = [];
let startNode = null;
let activeFloorId = null, activeFacType = 'all', activeCat = 'all', activeLetter = 'all', brandKw = '';
let currentRoute = null, legIndex = 0, focus = null; // focus: {kind:'shop'|'facility', id}
let idleTimer = null, homeTimers = [], homeIdx = 0, activeScreen = 'home';
let viewFloor = null, viewGuide = null;
let showBase = true;   // 是否显示底图图层（可在「楼层导购」工具栏切换）

/* ---------------- 工具 ---------------- */
const catMeta = (k) => cats.find((c) => c.key === k) || { key: k, label: '其他', icon: '📍', color: '#90a4ae' };
const facMeta = (t) => facTypes.find((f) => f.key === t) || { key: t, label: '设施', icon: '📍', color: '#90a4ae' };
const floorById = (id) => floors.find((f) => f.id === id);
const shopById = (id) => shops.find((s) => s.id === id);
const facById = (id) => facilities.find((f) => f.id === id);
const nodeById = (id) => graph.nodes.find((n) => n.id === id);
const floorShort = (id) => { const f = floorById(id); return f ? (f.short || f.name) : id; };

async function getJSON(url) { return (await fetch(url)).json(); }
async function postJSON(url, body) { return (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); }

/* ---------------- 屏幕切换 ---------------- */
function showScreen(name) {
  activeScreen = name;
  $$('.screen').forEach((s) => s.classList.remove('active'));
  const el = $('#screen-' + name);
  if (el) el.classList.add('active');
  $$('#topnav .tn').forEach((b) => b.classList.toggle('active', b.dataset.go === name));
  resetIdle();
}
$$('#topnav .tn').forEach((b) => b.addEventListener('click', () => {
  const go = b.dataset.go;
  if (go === 'floor') goFloor(activeFloorId || (floors[0] || {}).id);
  else if (go === 'brand') { renderBrand(); showScreen('brand'); }
  else if (go === 'promo') { renderPromo(); showScreen('promo'); }
  else if (go === 'service') { renderService(); showScreen('service'); }
  else showScreen('home');
}));

/* ---------------- 多屏内容分发：屏幕识别 / 专属界面 / 远程切换 ----------------
 * 位置标识优先级：URL ?screen=ID → localStorage 记忆 → 本地标识文件 /screen-id.json → 空（默认界面）
 * 内容分配：共享全馆基础数据，每屏覆盖「默认页签 / 聚焦楼层 / 模块开关 / 主题色 / 本地点位公告」
 * 远程更新：后台保存或「立即下发」令 rev+1，前台每 15s 轮询，rev 变化自动重新应用（免人工刷新）
 */
const SCREEN_ID_KEY = 'mb_screen_id';
const MALL_ID_KEY = 'mb_mall_id';
let screenProfile = null;
let screenId = '';
let screenMall = '';          // 本屏所属商场（URL ?mall= / localStorage 记忆）
window.__mallId = '';         // 当前已加载数据的商场（init 时由 /api/map 返回）
function resolveMallHintSync() {
  const qs = new URLSearchParams(location.search);
  let mid = (qs.get('mall') || '').trim();
  if (mid) { try { localStorage.setItem(MALL_ID_KEY, mid); } catch (e) { /* ignore */ } }
  if (!mid) { try { mid = localStorage.getItem(MALL_ID_KEY) || ''; } catch (e) { /* ignore */ } }
  screenMall = mid;
  return mid;
}

function applyScreenProfile(p) {
  screenProfile = p;
  window.__screenModules = p.modules || {};
  // 主题色覆盖（每屏可指定强调色）
  if (p.accent) {
    document.documentElement.style.setProperty('--accent', p.accent);
    document.documentElement.style.setProperty('--accent-2', shade(p.accent, -26));
  }
  // 模块显隐：顶部导航 + 首页快捷卡 + 详情页「路线导航」按钮
  $$('#topnav .tn').forEach((b) => {
    const go = b.dataset.go;
    if (go === 'home') return;
    b.style.display = (p.modules[go] === false) ? 'none' : '';
  });
  $$('#homeQuick .quick-card').forEach((c) => {
    c.style.display = (p.modules[c.dataset.mod] === false) ? 'none' : '';
  });
  const navBtn = $('#detailNavBtn');
  if (navBtn) navBtn.style.display = (p.modules.guide === false) ? 'none' : '';
  // 本地点位公告条
  const bar = $('#screenNotice');
  if (bar) {
    if (p.notice) { bar.textContent = p.notice; bar.hidden = false; }
    else bar.hidden = true;
  }
  // 屏幕身份标识（便于巡检确认本机加载的配置）
  const badge = $('#screenBadge');
  if (badge) {
    if (p.assigned) { badge.textContent = `🖥️ ${p.name}${p.location ? ' · ' + p.location : ''}`; badge.hidden = false; }
    else badge.hidden = true;
  }
  // 聚焦楼层：地图默认打开该层
  if (p.focusFloorId && floorById(p.focusFloorId)) {
    activeFloorId = p.focusFloorId;
    buildFloorRail();
    buildFacFilter();
    renderFloorMap();
  }
}

function goScreenTab(t) {
  if (!t || t === 'home') { showScreen('home'); return; }
  if (t === 'floor') { goFloor(activeFloorId || (floors[0] || {}).id); return; }
  if (t === 'brand') { activeCat = 'all'; activeLetter = 'all'; brandKw = ''; renderBrand(); showScreen('brand'); return; }
  if (t === 'promo') { renderPromo(); showScreen('promo'); return; }
  if (t === 'service') { renderService(); showScreen('service'); return; }
  showScreen('home');
}

async function bootScreen() {
  // 1) 解析自身位置标识（screen）与所属商场（mall）
  const qs = new URLSearchParams(location.search);
  let sid = (qs.get('screen') || '').trim();
  if (sid) { try { localStorage.setItem(SCREEN_ID_KEY, sid); } catch (e) { /* ignore */ } }
  if (!sid) { try { sid = localStorage.getItem(SCREEN_ID_KEY) || ''; } catch (e) { /* ignore */ } }
  if (!sid) {
    try {
      const r = await fetch('/screen-id.json', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        sid = (j && j.id) ? String(j.id).trim() : '';
        // 本地标识文件可声明所属商场；与当前加载商场不一致时重定向一次（带防循环标记）
        if (j && j.mall && window.__mallId && j.mall !== window.__mallId && !sessionStorage.getItem('mb_mall_reload')) {
          try { localStorage.setItem(MALL_ID_KEY, String(j.mall)); sessionStorage.setItem('mb_mall_reload', '1'); } catch (e) { /* ignore */ }
          const u = new URL(location.href); u.searchParams.set('mall', String(j.mall));
          location.replace(u.toString());
          return;
        }
      }
    } catch (e) { /* ignore */ }
  }
  screenId = sid;
  const mallParam = screenMall || window.__mallId || '';
  // 2) 拉取专属配置并应用
  try {
    const r = await fetch('/api/screen/' + encodeURIComponent(sid || '-') + (mallParam ? '?mall=' + encodeURIComponent(mallParam) : ''), { cache: 'no-store' });
    const j = await r.json();
    if (j && j.ok) applyScreenProfile(j.data);
  } catch (e) { /* 离线兜底：保持默认界面 */ }
  // 3) 进入该屏的默认页签（显式 ?go= / ?ss= 预览时让位）
  const want = screenProfile && screenProfile.defaultTab;
  if (want && !/[?&](go|ss)=/.test(location.search)) goScreenTab(want);
  // 4) 轮询远程更新：rev 变化 → 自动重新应用（远程切换 15s 内生效）
  setInterval(async () => {
    if (!screenProfile) return;
    try {
      const r = await fetch('/api/screen/' + encodeURIComponent(screenId || '-') + (mallParam ? '?mall=' + encodeURIComponent(mallParam) : ''), { cache: 'no-store' });
      const j = await r.json();
      if (!j || !j.ok) return;
      if (j.data.rev !== screenProfile.rev) {
        const prevTab = screenProfile.defaultTab;
        applyScreenProfile(j.data);
        if (j.data.defaultTab !== prevTab && !/[?&](go|ss)=/.test(location.search)) goScreenTab(j.data.defaultTab);
      }
    } catch (e) { /* 网络异常：下轮再试 */ }
  }, 15000);
}

/* ---------------- 时钟 ---------------- */
function tickClock() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const t = `${p(d.getHours())}:${p(d.getMinutes())}`;
  $('#clock').textContent = t;
  const sc = $('#ssClock'); if (sc) sc.textContent = t;
}

/* ---------------- 地图视图（viewBox 缩放/平移） ---------------- */
function createMapView(svg) {
  const base = { x: 0, y: 0, w: 1000, h: 700 };
  const st = Object.assign({}, base);
  const apply = () => svg.setAttribute('viewBox', `${st.x} ${st.y} ${st.w} ${st.h}`);
  const clamp = () => {
    st.w = Math.min(1000, Math.max(180, st.w)); st.h = st.w * 0.7;
    st.x = Math.min(1000 - st.w, Math.max(0, st.x));
    st.y = Math.min(700 - st.h, Math.max(0, st.y));
  };
  function zoom(f, cx, cy) {
    const px = cx == null ? st.x + st.w / 2 : cx, py = cy == null ? st.y + st.h / 2 : cy;
    const rx = (px - st.x) / st.w, ry = (py - st.y) / st.h;
    st.w = st.w * f; clamp();
    st.x = px - rx * st.w; st.y = py - ry * st.h; clamp(); apply();
  }
  let drag = null;
  svg.addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('[data-clickable]')) return;
    drag = { x: e.clientX, y: e.clientY, sx: st.x, sy: st.y };
    try { svg.setPointerCapture(e.pointerId); } catch (err) { }
    svg.classList.add('grabbing');
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = svg.getBoundingClientRect(); const k = st.w / r.width;
    st.x = drag.sx - (e.clientX - drag.x) * k; st.y = drag.sy - (e.clientY - drag.y) * k;
    clamp(); apply();
  });
  const end = () => { if (drag) { drag = null; svg.classList.remove('grabbing'); } };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.12 : 0.9); }, { passive: false });
  apply();
  return {
    apply,
    zoomIn: () => zoom(0.8), zoomOut: () => zoom(1.25),
    reset: () => { Object.assign(st, base); apply(); },
    centerOn: (x, y, scale) => { st.w = 1000 / (scale || 2); st.h = st.w * 0.7; st.x = x - st.w / 2; st.y = y - st.h / 2; clamp(); apply(); }
  };
}

/* ---------------- 楼层平面渲染（共用） ---------------- */
function clearGroups(...gs) { gs.forEach((g) => { while (g && g.firstChild) g.removeChild(g.firstChild); }); }

function drawWalls(g, floor) {
  const fp = (floor && floor.plan) || {};
  (fp.walls || []).forEach((w) => {
    g.appendChild(svgEl('line', { x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, 'stroke-width': w.w || 5, class: 'wall-line' }));
  });
}

/* 底图图层：按 imageRect 精确铺放。
   底图与店铺/设施/路网共用同一坐标系（viewBox 0 0 1000 700），因此天然像素级对齐。 */
function drawPlan(g, floor, forceOn) {
  const p = (floor && floor.plan) || {};
  if (p.mode !== 'image' || !p.image) return false;
  const on = forceOn === undefined ? (p.showImage !== false) : !!forceOn;
  if (!on) return false;
  const r = p.imageRect || { x: 0, y: 0, w: 1000, h: 700 };
  const img = svgEl('image', {
    x: r.x, y: r.y, width: r.w, height: r.h,
    preserveAspectRatio: 'none',
    opacity: (p.imageOpacity == null ? 1 : p.imageOpacity)
  });
  img.setAttribute('href', p.image);
  img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', p.image);
  g.appendChild(img);
  return true;
}

function drawShops(g, floorId, opt) {
  const o = opt || {};
  const baseOn = !!o.baseOn; // 底图已含店名与分隔线：底图开启时弱化色块、隐藏重复店名
  shops.filter((s) => s.floorId === floorId).forEach((s) => {
    const hl = o.highlightId === s.id;
    const dim = o.dimWhenHighlight && o.highlightId && !hl;
    const rect = svgEl('rect', {
      x: s.x, y: s.y, width: s.w, height: s.h, rx: 10,
      fill: s.color,
      class: 'shop-rect' + (baseOn ? ' on-base' : '') + (hl ? ' hl' : '') + (dim ? ' dim' : ''),
      'data-clickable': '1'
    });
    rect.addEventListener('click', () => openDetail('shop', s.id));
    g.appendChild(rect);
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    if (baseOn) {
      // 仅保留业态图标；店名由底图提供，避免重影
      const ico = svgEl('text', { x: cx, y: cy + 8, class: 'shop-icon', 'font-size': 20 });
      ico.textContent = catMeta(s.cat).icon;
      g.appendChild(ico);
      return;
    }
    const big = s.w >= 90 && s.h >= 66;
    if (big) {
      const ico = svgEl('text', { x: cx, y: cy - 6, class: 'shop-icon', 'font-size': 24 });
      ico.textContent = catMeta(s.cat).icon;
      g.appendChild(ico);
      const lab = svgEl('text', { x: cx, y: cy + 22, class: 'shop-label', 'font-size': Math.min(16, Math.max(11, s.w / 9)) });
      lab.textContent = s.name;
      g.appendChild(lab);
    } else {
      const lab = svgEl('text', { x: cx, y: cy + 5, class: 'shop-label', 'font-size': 13 });
      lab.textContent = s.name;
      g.appendChild(lab);
    }
  });
}

function drawFacilities(g, floorId, opt) {
  const o = opt || {};
  facilities.filter((f) => f.floorId === floorId).forEach((f) => {
    if (o.onlyType && o.onlyType !== 'all' && f.type !== o.onlyType) return;
    const m = facMeta(f.type);
    const w = 44, h = 44, x = f.x - w / 2, y = f.y - h / 2;
    const grp = svgEl('g', { class: 'fac-g', 'data-clickable': '1' });
    grp.addEventListener('click', () => openDetail('facility', f.id));
    grp.appendChild(svgEl('rect', { x, y, width: w, height: h, rx: 10, fill: m.color + '33', stroke: m.color, class: 'fac-bg' }));
    const ico = svgEl('text', { x: f.x, y: f.y + 8, class: 'fac-ico', 'font-size': 22 });
    ico.textContent = m.icon;
    grp.appendChild(ico);
    const lab = svgEl('text', { x: f.x, y: f.y + h / 2 + 16, class: 'fac-label' });
    lab.textContent = f.name;
    grp.appendChild(lab);
    g.appendChild(grp);
  });
}

function drawYouMarker(g, pos) {
  if (!pos) return;
  const ring = svgEl('circle', { cx: pos.x, cy: pos.y, r: 16, class: 'you-pulse', 'stroke-width': 3 });
  ring.innerHTML = '<animate attributeName="r" values="12;26;12" dur="1.8s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0.15;1" dur="1.8s" repeatCount="indefinite"/>';
  g.appendChild(ring);
  g.appendChild(svgEl('circle', { cx: pos.x, cy: pos.y, r: 9, fill: '#ffd166', stroke: '#2a1f00', 'stroke-width': 2 }));
}

/* 楼层导购：渲染当前楼层 */
function renderFloorMap() {
  const floor = floorById(activeFloorId) || floors[0];
  if (!floor) return;
  activeFloorId = floor.id;
  const hl = focus && focus.kind === 'shop' ? focus.id : (focus && focus.kind === 'facility' ? null : null);
  clearGroups($('#gPlan'), $('#gWalls'), $('#gShops'), $('#gFacilities'), $('#gMarkers'));
  const baseOn = drawPlan($('#gPlan'), floor, showBase);
  drawWalls($('#gWalls'), floor);
  drawShops($('#gShops'), floor.id, { highlightId: hl, dimWhenHighlight: !!hl, baseOn });
  drawFacilities($('#gFacilities'), floor.id, { onlyType: activeFacType });
  // 起点「您在这里」（仅当起点位于当前楼层）
  const sn = nodeById(startNode);
  if (sn && sn.floorId === floor.id) drawYouMarker($('#gMarkers'), { x: sn.x, y: sn.y });
  $('#mapFloorName').textContent = floor.short ? `${floor.short} · ${floor.name}` : floor.name;
  $$('#floorRail .floor-tab').forEach((t) => t.classList.toggle('active', t.dataset.fid === floor.id));
}

function goFloor(floorId, opts) {
  activeFloorId = floorId && floorById(floorId) ? floorId : (floors[0] || {}).id;
  const o = opts || {};
  if (o.focus !== undefined) focus = o.focus;
  if (o.facType !== undefined) activeFacType = o.facType;
  buildFloorRail();
  buildFacFilter();
  renderFloorMap();
  if (viewFloor) {
    if (o.zoom && focus) {
      const t = focus.kind === 'shop' ? shopById(focus.id) : facById(focus.id);
      if (t) viewFloor.centerOn(t.x + (t.w || 0) / 2, t.y + (t.h || 0) / 2, 2.2);
    } else if (!o.keepView) viewFloor.reset();
  }
  showScreen('floor');
}

function buildFloorRail() {
  const rail = $('#floorRail'); rail.innerHTML = '';
  // 楼层由高到低展示（符合商场楼层牌习惯）
  [...floors].reverse().forEach((f) => {
    const t = document.createElement('div');
    t.className = 'floor-tab' + (f.id === activeFloorId ? ' active' : '');
    t.dataset.fid = f.id;
    t.innerHTML = `<div class="ft-short">${esc(f.short || f.id)}</div><div class="ft-name">${esc(f.name)}</div>`;
    t.onclick = () => goFloor(f.id, { focus: null });
    rail.appendChild(t);
  });
}

function buildFacFilter() {
  const box = $('#facFilter'); box.innerHTML = '';
  const types = [{ key: 'all', label: '全部', icon: '🔎' }].concat(facTypes.filter((t) => t.key !== 'other'));
  types.forEach((t) => {
    const c = document.createElement('div');
    c.className = 'chip' + (activeFacType === t.key ? ' on' : '');
    c.innerHTML = `<span>${t.icon}</span><span>${esc(t.label)}</span>`;
    c.onclick = () => { activeFacType = t.key; buildFacFilter(); renderFloorMap(); };
    box.appendChild(c);
  });
}

/* ---------------- 品牌导购 ---------------- */
function renderBrand() {
  $('#brandSearch').value = brandKw;
  $('#brandClear').hidden = !brandKw;
  // 业态筛选
  const catBox = $('#catFilter'); catBox.innerHTML = '';
  const usedCats = [...new Set(shops.map((s) => s.cat))];
  [{ key: 'all', label: '全部业态', icon: '🗂️' }].concat(usedCats.map(catMeta)).forEach((c) => {
    const d = document.createElement('div');
    d.className = 'chip' + (activeCat === c.key ? ' on' : '');
    d.innerHTML = `<span>${c.icon}</span><span>${esc(c.label)}</span>`;
    d.onclick = () => { activeCat = c.key; renderBrand(); };
    catBox.appendChild(d);
  });
  const kw = brandKw.trim().toLowerCase();
  let list = shops.filter((s) => {
    if (activeCat !== 'all' && s.cat !== activeCat) return false;
    if (activeLetter !== 'all' && (s.letter || '#') !== activeLetter) return false;
    if (kw && !((s.name || '').toLowerCase().includes(kw) || (s.desc || '').toLowerCase().includes(kw) || catMeta(s.cat).label.includes(kw))) return false;
    return true;
  });
  list.sort((a, b) => (a.letter || 'Z').localeCompare(b.letter || 'Z') || a.name.localeCompare(b.name));

  const grid = $('#brandGrid'); grid.innerHTML = '';
  if (!list.length) { grid.innerHTML = '<div class="brand-empty">未找到匹配的品牌 / 店铺，请换个关键词试试～</div>'; }
  list.forEach((s) => {
    const m = catMeta(s.cat);
    const card = document.createElement('div');
    card.className = 'brand-card';
    const icoInner = s.logo ? `<img src="${esc(s.logo)}" alt="${esc(s.name)}" />` : m.icon;
    card.innerHTML =
      `<div class="brand-ico" style="background:${s.color}33;border:1px solid ${s.color}88">${icoInner}</div>` +
      `<div class="brand-info"><div class="brand-name">${esc(s.name)}</div>` +
      `<div class="brand-meta"><span>${esc(m.label)}</span><span>📍 <b>${esc(floorShort(s.floorId))}</b></span></div></div>`;
    card.onclick = () => openDetail('shop', s.id);
    grid.appendChild(card);
  });

  // A-Z 索引
  const az = $('#azIndex'); az.innerHTML = '';
  const letters = [...new Set(shops.map((s) => s.letter || '#'))].sort();
  const mkBtn = (key, label) => {
    const b = document.createElement('button');
    b.textContent = label; b.className = (activeLetter === key ? 'on' : '');
    b.onclick = () => { activeLetter = key; renderBrand(); };
    az.appendChild(b);
  };
  mkBtn('all', '全');
  letters.forEach((L) => mkBtn(L, L));
}

$('#brandSearch').addEventListener('input', (e) => { brandKw = e.target.value; renderBrand(); $('#brandSearch').focus(); });
$('#brandClear').onclick = () => { brandKw = ''; renderBrand(); $('#brandSearch').focus(); };

/* ---------------- 优惠活动 ---------------- */
function renderPromo() {
  const grid = $('#promoGrid'); grid.innerHTML = '';
  const list = promos.slice().sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  if (!list.length) { grid.innerHTML = '<div class="brand-empty">暂无优惠活动</div>'; return; }
  list.forEach((p) => {
    const md = p.media || { type: 'none' };
    const hasMedia = md.type !== 'none' && !!md.url;
    const card = document.createElement('div');
    card.className = 'promo-card' + (p.active ? '' : ' off');
    if (md.type === 'image' && md.url) {
      card.style.background = `linear-gradient(180deg, rgba(5,9,18,.12), rgba(5,9,18,.84)), url('${md.url}') center/cover no-repeat`;
    } else {
      card.style.background = `linear-gradient(150deg, ${p.color}, ${shade(p.color, -34)})`;
    }
    const tag = { image: '🖼 活动海报', video: '▶ 活动视频', page: '🖱 互动活动' }[md.type] || '活动页面';
    card.innerHTML =
      (p.cat ? `<div class="promo-badge">${esc(p.cat)}</div>` : '') +
      (p.floorShort ? `<div class="promo-floor">📍 ${esc(p.floorShort)}</div>` : '') +
      `<div class="promo-title">${esc(p.title)}</div>` +
      `<div class="promo-date">🗓️ ${esc(p.startDate || '')} ~ ${esc(p.endDate || '')}</div>` +
      (hasMedia ? `<div class="promo-media-tag">${tag} · 点击查看</div>` : '') +
      `<div class="promo-flag">${p.active ? '进行中' : '已结束'}</div>`;
    card.onclick = () => openPromo(p);
    if (p.desc) card.title = p.desc;
    grid.appendChild(card);
  });
}
function shade(hex, amt) {
  const c = String(hex || '#4d8dff').replace('#', '');
  const n = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  const num = parseInt(n, 16);
  let r = (num >> 16) + amt, g = ((num >> 8) & 255) + amt, b = (num & 255) + amt;
  r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/* 素材图层：图片（覆盖式背景） / 视频（静音循环） / 互动网页（iframe 嵌入） */
function mediaLayerHtml(media, cls) {
  const md = media || { type: 'none' };
  if (md.type === 'none' || !md.url) return '';
  if (md.type === 'image') return `<div class="${cls} media-img" style="background-image:url('${esc(md.url)}')"></div>`;
  if (md.type === 'video') return `<video class="${cls} media-video" src="${esc(md.url)}" autoplay muted loop playsinline></video>`;
  return `<iframe class="${cls} media-page" src="${esc(md.url)}" loading="lazy"></iframe>`;
}

/* ---------------- 活动详情 / 素材展示 ---------------- */
function openPromo(p) {
  const md = p.media || { type: 'none' };
  $('#mediaTitle').textContent = p.title || '活动详情';
  const body = $('#mediaBody');
  if (md.type === 'image' && md.url) body.innerHTML = `<img src="${esc(md.url)}" alt="${esc(p.title || '')}" />`;
  else if (md.type === 'video' && md.url) body.innerHTML = `<video src="${esc(md.url)}" controls autoplay muted loop playsinline></video>`;
  else if (md.type === 'page' && md.url) body.innerHTML = `<iframe src="${esc(md.url)}" loading="lazy"></iframe>`;
  else body.innerHTML = `<div class="media-fallback" style="background:linear-gradient(150deg,${p.color || '#ef6c4d'},${shade(p.color || '#ef6c4d', -42)})">
      <div class="mf-badge">${esc(p.cat || '活动')}</div>
      <div class="mf-title">${esc(p.title || '')}</div>
      <div class="mf-date">🗓️ ${esc(p.startDate || '')} ~ ${esc(p.endDate || '')}</div></div>`;
  $('#mediaFoot').innerHTML =
    (p.desc ? `<div class="media-desc">${esc(p.desc)}</div>` : '') +
    `<div class="media-actions">` +
    (p.floorId && floorById(p.floorId) ? `<button class="btn primary" id="mediaGoFloor">📍 查看楼层</button>` : '') +
    `<button class="btn" id="mediaCloseBtn">关闭</button></div>`;
  $('#mediaModal').classList.add('active');
  const gf = $('#mediaGoFloor');
  if (gf) gf.onclick = () => { closePromo(); goFloor(p.floorId, { focus: null }); };
  $('#mediaCloseBtn').onclick = closePromo;
}
function closePromo() {
  $('#mediaModal').classList.remove('active');
  $('#mediaBody').innerHTML = '';
}

/* ---------------- 服务指南（读后台配置 + 占位符实时取数） ---------------- */
// 占位符：{{商场名}} {{地址}} {{营业时间}} {{服务电话}} {{楼层:设施类型}}
// 条目写法：每行一条；以「- 」开头渲染为圆点列表项，否则渲染为段落
function svcFloorList(typeRef) {
  const t = facTypes.find((x) => x.key === typeRef || x.label === typeRef);
  const key = t ? t.key : typeRef;
  const names = [...new Set(facilities.filter((f) => f.type === key).map((f) => floorShort(f.floorId)))];
  return names.length ? names.join('、') : '—';
}
function svcFill(text) {
  const v = {
    '商场名': settings.mallName || '',
    '地址': settings.address || '',
    '营业时间': settings.businessHours || '',
    '服务电话': settings.servicePhone || ''
  };
  return String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, expr) => {
    const e = String(expr).trim();
    const fl = e.match(/^楼层\s*[:：]\s*(.+)$/);
    if (fl) return svcFloorList(fl[1].trim());
    return Object.prototype.hasOwnProperty.call(v, e) ? v[e] : m; // 未识别则原样保留
  });
}
// 条目数组 → HTML：连续的列表项合并进同一个 <ul>（合法 HTML，避免 li 脱离 ul）
function svcBodyHtml(items) {
  const out = [];
  let lis = [];
  const flush = () => { if (lis.length) { out.push('<ul>' + lis.join('') + '</ul>'); lis = []; } };
  (items || []).forEach((line) => {
    const t = svcFill(line);
    const m = t.match(/^[-•*]\s+(.*)$/);
    if (m) {
      const txt = m[1].trim();
      if (txt) lis.push('<li>' + esc(txt) + '</li>'); // 空列表项跳过，避免出现空圆点
      return;
    }
    const p = t.trim();
    if (p) { flush(); out.push('<p>' + esc(p) + '</p>'); }
  });
  flush();
  return out.join('');
}
// 后台未配置卡片时的内置回退（保证老库 / 空库也能正常显示）
function svcFallbackCards() {
  return [
    { icon: 'ℹ️', title: '服务指南', items: ['导视服务正在配置中，如需帮助请联系客服中心。'] }
  ];
}
// 卡片自定义颜色 → 行内样式（后台「服务指南」可配 color / colorMode）
function svcCardStyle(c) {
  const col = (c && c.color) ? String(c.color).trim() : '';
  const img = (c && c.bgImage) ? String(c.bgImage).trim() : '';
  // 自定义背景图优先级最高：cover 铺满 + 居中裁剪 + 暗色蒙版保证文字可读
  if (img) {
    const safe = img.replace(/['"()]/g, '');
    const scrim = 'linear-gradient(180deg, rgba(8,12,22,.42), rgba(8,12,22,.70))';
    let card = `background:${scrim}, url('${safe}') center / cover no-repeat`;
    // 同时设置「边框」色时叠加左侧色条，强化品牌识别
    if (col && c.colorMode !== 'bg') card += `;border-color:${col};border-width:3px;border-left-width:6px`;
    return {
      card,
      icon: `background:rgba(255,255,255,.2);display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:11px`,
      cls: ' svc-bgimg'
    };
  }
  if (!col) return { card: '', icon: '', cls: '' };
  if (c.colorMode === 'bg') {
    return {
      card: `background:${col};border-color:${col}`,
      icon: `background:rgba(255,255,255,.22);display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:11px`,
      cls: ' svc-bg'
    };
  }
  // 边框 / 左侧色条 + 图标底色
  return {
    card: `border-color:${col};border-width:3px;border-left-width:6px`,
    icon: `background:${col};color:#fff;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:11px`,
    cls: ''
  };
}

function renderService() {
  const g = settings.guide || {};
  const head = $('#svcHead'), tEl = $('#svcTitle'), sEl = $('#svcSub');
  const setHead = (title, sub) => {
    if (!head) return;
    if (tEl) tEl.textContent = title;
    if (sEl) sEl.textContent = sub || '';
    head.style.display = 'block';
  };

  // 后台关闭「服务指南」：显示维护提示（保留入口，避免出现空白页 / 死路）
  if (g.enabled === false) {
    setHead(g.title || '服务指南', '');
    $('#serviceGrid').innerHTML =
      '<div class="service-card"><h3><span>🛠️</span>服务指南维护中</h3>' +
      '<p>服务指南内容正在更新，如需帮助请咨询商场客服中心。</p>' +
      `<ul><li>服务热线：${esc(settings.servicePhone || '—')}</li></ul></div>`;
    return;
  }

  let cards = Array.isArray(g.cards) ? g.cards.filter((c) => c && c.enabled !== false && c.title) : [];
  if (!cards.length) cards = svcFallbackCards();

  setHead(g.title || '服务指南', g.sub);
  $('#serviceGrid').innerHTML = cards
    .map((c) => {
      const st = svcCardStyle(c);
      return `<div class="service-card${st.cls}"${st.card ? ` style="${st.card}"` : ''}>` +
        `<h3><span${st.icon ? ` style="${st.icon}"` : ''}>${esc(c.icon || 'ℹ️')}</span>${esc(c.title)}</h3>` +
        svcBodyHtml(c.items) +
        `</div>`;
    })
    .join('');
}

/* ---------------- 点位详情 ---------------- */
function openDetail(kind, id) {
  const isShop = kind === 'shop';
  const o = isShop ? shopById(id) : facById(id);
  if (!o) return;
  const m = isShop ? catMeta(o.cat) : facMeta(o.type);
  $('#detailHero').style.background = `linear-gradient(140deg, ${m.color || '#4d8dff'}, ${shade(m.color || '#4d8dff', -46)})`;
  if (isShop && o.logo) $('#detailIcon').innerHTML = `<img src="${esc(o.logo)}" alt="${esc(o.name)}" />`;
  else $('#detailIcon').textContent = m.icon;
  $('#detailName').textContent = o.name;
  const meta = [];
  meta.push(`📍 ${floorShort(o.floorId)}`);
  meta.push(isShop ? m.label : (o.typeLabel || m.label));
  if (isShop && o.hours) meta.push(`🕙 ${o.hours}`);
  if (isShop && o.phone) meta.push(`☎️ ${o.phone}`);
  $('#detailMeta').innerHTML = meta.map((x) => `<span>${esc(x)}</span>`).join('');
  $('#detailDesc').textContent = o.desc || (isShop ? `${o.name}，${floorShort(o.floorId)}${m.label}商户，欢迎光临。` : `${o.name}，位于${floorShort(o.floorId)}。`);
  const tags = (isShop && Array.isArray(o.tags) && o.tags.length) ? o.tags : [isShop ? m.label : (o.typeLabel || '公共设施')];
  $('#detailTags').innerHTML = tags.map((t) => `<span>${esc(t)}</span>`).join('');
  $('#detailModal').classList.add('active');
  const nav = $('#detailNavBtn');
  nav.onclick = () => { closeDetail(); goGuide({ kind, id }); };
  $('#detailMapBtn').onclick = () => { closeDetail(); goFloor(o.floorId, { focus: { kind, id }, zoom: true }); };
}
function closeDetail() { $('#detailModal').classList.remove('active'); }
$('#detailClose').onclick = closeDetail;
$('#detailModal').addEventListener('click', (e) => { if (e.target === $('#detailModal')) closeDetail(); });

/* ---------------- 路线导航 ---------------- */
async function goGuide(target) {
  const toId = target.id;
  const res = await postJSON('/api/route', { from: startNode, to: toId });
  if (!res.ok) { alert(`无法规划路线：\n${res.error || '路线规划失败'}`); return; }
  if (res.startFallback && res.startNode) startNode = res.startNode;
  currentRoute = res; legIndex = 0;
  const toName = res.to.name || (target.kind === 'shop' ? (shopById(toId) || {}).name : (facById(toId) || {}).name) || '目的地';
  $('#guideTitle').textContent = `导航至：${toName}`;
  buildFloorSwitch();
  showScreen('guide');
  renderGuide();
}

function buildFloorSwitch() {
  const box = $('#floorSwitch'); box.innerHTML = '';
  if (!currentRoute || !currentRoute.legs || currentRoute.legs.length <= 1) return;
  currentRoute.legs.forEach((leg, i) => {
    const b = document.createElement('div');
    b.className = 'fs-btn' + (i === legIndex ? ' active' : '');
    b.textContent = leg.floorName || floorShort(leg.floorId);
    b.onclick = () => { legIndex = i; buildFloorSwitch(); renderGuide(); };
    box.appendChild(b);
  });
}

function renderGuide() {
  const leg = currentRoute.legs[legIndex];
  const floor = floorById(leg.floorId);
  clearGroups($('#ggPlan'), $('#ggWalls'), $('#ggShops'), $('#ggFacilities'), $('#ggPath'), $('#ggMarkers'));
  const baseOn = drawPlan($('#ggPlan'), floor, showBase);
  drawWalls($('#ggWalls'), floor);
  drawShops($('#ggShops'), leg.floorId, { highlightId: currentRoute.to.shopId || null, dimWhenHighlight: !!currentRoute.to.shopId, baseOn });
  drawFacilities($('#ggFacilities'), leg.floorId, {});
  $('#guideFloorName').textContent = leg.floorName || (floor ? floor.name : leg.floorId);

  // 该楼层路径
  const pts = leg.nodes.map((n) => ({ x: n.x, y: n.y }));
  if (pts.length >= 2) {
    const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p.x + ' ' + p.y).join(' ');
    $('#ggPath').appendChild(svgEl('path', { d, class: 'path-shadow' }));
    const line = svgEl('path', { d, class: 'path-line', 'marker-end': 'url(#pathArrow)' });
    $('#ggPath').appendChild(line);
    animatePath(line);
    animateRunner(line);
  }

  const g = $('#ggMarkers');
  const isFirst = legIndex === 0, isLast = legIndex === currentRoute.legs.length - 1;
  const first = pts[0], last = pts[pts.length - 1];
  if (isFirst && first) addMarker(g, first.x, first.y, 'marker-start', '起');
  else if (first) addMarker(g, first.x, first.y, 'marker-end', '换');
  if (isLast && last) addMarker(g, last.x, last.y, 'marker-end', '终', true);
  else if (!isLast && last) addMarker(g, last.x, last.y, 'marker-start', '换');

  renderSteps();
}

function addMarker(g, x, y, cls, label, pulse) {
  if (pulse) {
    const ring = svgEl('circle', { cx: x, cy: y, r: 20, class: 'marker-ring' });
    ring.innerHTML = '<animate attributeName="r" values="16;30;16" dur="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0.15;1" dur="1.6s" repeatCount="indefinite"/>';
    g.appendChild(ring);
  }
  g.appendChild(svgEl('circle', { cx: x, cy: y, r: 13, class: cls }));
  const t = svgEl('text', { x, y: y + 5, class: 'marker-txt', fill: '#04222a' });
  t.textContent = label;
  g.appendChild(t);
}
function animatePath(pathEl) {
  const len = pathEl.getTotalLength();
  pathEl.style.strokeDasharray = len; pathEl.style.strokeDashoffset = len;
  pathEl.getBoundingClientRect();
  requestAnimationFrame(() => { pathEl.style.strokeDashoffset = '0'; });
}
function animateRunner(pathEl) {
  const len = pathEl.getTotalLength();
  const runner = svgEl('circle', { r: 10, class: 'marker-runner' });
  $('#ggMarkers').appendChild(runner);
  const dur = 2400, t0 = performance.now();
  (function frame(t) {
    const k = Math.min(1, (t - t0) / dur);
    const pt = pathEl.getPointAtLength(len * k);
    runner.setAttribute('cx', pt.x); runner.setAttribute('cy', pt.y);
    if (k < 1) requestAnimationFrame(frame);
  })(t0);
}
function renderSteps() {
  const leg = currentRoute.legs[legIndex];
  $('#stepsTotal').innerHTML = `当前楼层：<b>${esc(leg.floorName || '')}</b>　|　全程约 <b>${currentRoute.totalMeters}</b> 米` +
    (currentRoute.legs.length > 1 ? `　|　共 ${currentRoute.legs.length} 层` : '');
  const list = $('#stepsList'); list.innerHTML = '';
  currentRoute.steps.forEach((s) => {
    const li = document.createElement('li');
    li.className = s.type;
    li.innerHTML = `<span class="num">${s.idx}</span><span>${esc(s.text)}</span>`;
    list.appendChild(li);
  });
  list.scrollTop = 0;
  const isLast = legIndex === currentRoute.legs.length - 1;
  $('#stepsFoot').innerHTML = `<button class="btn ${isLast ? 'primary' : ''}" id="stepNext" style="width:100%">` +
    (isLast ? '⌂ 完成，返回首页' : '↓ 前往 ' + esc(currentRoute.legs[legIndex + 1].floorName || '下一楼层')) + '</button>';
  $('#stepNext').onclick = () => { if (isLast) showScreen('home'); else { legIndex++; buildFloorSwitch(); renderGuide(); } };
}

/* ---------------- 首页 ---------------- */
function renderHome() {
  const hero = $('#homeBanner'); hero.innerHTML = '';
  const slides = banners.length ? banners : [{ title: settings.mallName || '欢迎光临', sub: settings.slogan || '', bg: 'linear-gradient(135deg,#4d8dff,#7b5cff)', badge: '欢迎光临' }];
  slides.forEach((b, i) => {
    const s = document.createElement('div');
    s.className = 'hero-slide' + (i === 0 ? ' on' : '');
    s.style.background = b.bg || 'linear-gradient(135deg,#4d8dff,#7b5cff)';
    const md = b.media || { type: 'none' };
    const layer = mediaLayerHtml(md, 'hero-media');
    if (md.type === 'page') {
      // 互动网页独占 Banner 区域（不叠加文案，避免遮挡交互）
      s.innerHTML = layer;
    } else {
      s.innerHTML = layer + (layer ? '<div class="hero-scrim"></div>' : '') +
        (b.badge ? `<div class="hero-badge">${esc(b.badge)}</div>` : '') +
        `<div class="hero-title">${esc(b.title || '')}</div>` +
        (b.sub ? `<div class="hero-sub">${esc(b.sub)}</div>` : '');
    }
    hero.appendChild(s);
  });
  const dots = document.createElement('div');
  dots.className = 'hero-dots';
  slides.forEach((_, i) => { const d = document.createElement('i'); if (i === 0) d.className = 'on'; dots.appendChild(d); });
  hero.appendChild(dots);

  const quick = $('#homeQuick'); quick.innerHTML = '';
  const items = [
    { ico: '🗺️', name: '楼层导购', sub: '平面地图', mod: 'floor', fn: () => goFloor(activeFloorId || (floors[0] || {}).id) },
    { ico: '🛍️', name: '品牌导购', sub: 'A-Z 索引', mod: 'brand', fn: () => { activeCat = 'all'; activeLetter = 'all'; brandKw = ''; renderBrand(); showScreen('brand'); } },
    { ico: '🍽️', name: '畅享美食', sub: '餐饮楼层', mod: 'brand', fn: () => { activeCat = 'food'; activeLetter = 'all'; brandKw = ''; renderBrand(); showScreen('brand'); } },
    { ico: '🎁', name: '优惠活动', sub: '限时特惠', mod: 'promo', fn: () => { renderPromo(); showScreen('promo'); } },
    { ico: '🅿️', name: '停车缴费', sub: '扫码支付', mod: 'service', fn: () => { renderService(); showScreen('service'); } },
    { ico: '🛎️', name: '服务指南', sub: '客服 · 设施', mod: 'service', fn: () => { renderService(); showScreen('service'); } }
  ];
  items.forEach((it) => {
    const c = document.createElement('div');
    c.className = 'quick-card';
    c.dataset.mod = it.mod;
    c.innerHTML = `<div class="quick-ico">${it.ico}</div><div class="quick-name">${esc(it.name)}</div><div class="quick-sub">${esc(it.sub)}</div>`;
    c.onclick = it.fn;
    quick.appendChild(c);
  });

  $('#homeAddress').textContent = '📍 ' + (settings.address || '');
  $('#homeHours').textContent = '🕙 ' + (settings.businessHours || '');
  $('#homePhone').textContent = '☎️ ' + (settings.servicePhone || '');

  startHomeCarousel(slides.length);
}
function startHomeCarousel(n) {
  homeTimers.forEach(clearTimeout); homeTimers = []; homeIdx = 0;
  if (n <= 1) return;
  const slides = $$('#homeBanner .hero-slide'), dots = $$('#homeBanner .hero-dots i');
  const next = () => {
    homeIdx = (homeIdx + 1) % n;
    slides.forEach((s, i) => s.classList.toggle('on', i === homeIdx));
    dots.forEach((d, i) => d.classList.toggle('on', i === homeIdx));
    homeTimers.push(setTimeout(next, 5000));
  };
  homeTimers.push(setTimeout(next, 5000));
}

/* ---------------- 待机页（屏保）· 自定义轮播引擎 ---------------- */
const ssState = { list: [], idx: 0, timer: null, active: false };

function ssConfig() {
  const s = (settings && settings.screensaver) || {};
  return {
    enabled: s.enabled !== false,
    interval: Math.max(3, Number(s.interval) || 8),
    transition: ['fade', 'slide', 'zoom', 'none'].includes(s.transition) ? s.transition : 'fade',
    order: s.order === 'shuffle' ? 'shuffle' : 'sequence',
    loop: s.loop !== false,
    mute: s.mute !== false,
    videoMode: s.videoMode === 'ended' ? 'ended' : 'timed',
    showClock: s.showClock !== false,
    showMallName: s.showMallName !== false,
    showHint: s.showHint !== false,
    showProgress: s.showProgress !== false,
    dim: Math.max(0, Math.min(0.7, Number(s.dim) || 0)),
    tapAction: s.tapAction === 'exit' ? 'exit' : 'activity',   // 点击待机页：进入关联活动 / 退出回首页
    pageTap: s.pageTap === 'interact' ? 'interact' : 'activity', // 点击互动页：整页进活动 / 保留 H5 交互
    items: Array.isArray(s.items) ? s.items.filter((it) => it && it.enabled !== false && it.url) : []
  };
}
function ssIdleSeconds() {
  const s = (settings && settings.screensaver) || {};
  return Math.max(8, Number(s.idleSeconds) || Number(settings.screensaverSeconds) || 45);
}
// 生成节目单；未配置自定义素材时回退为 Banner 内容（兼容旧数据）
function buildSsPlaylist() {
  const cfg = ssConfig();
  let list = cfg.items.map((it) => ({
    type: it.type || 'image', url: it.url, title: it.title || '', sub: it.sub || '', badge: '',
    promoId: it.promoId || '',
    duration: Math.max(3, Number(it.duration) || cfg.interval)
  }));
  if (!list.length) {
    const src = banners.length ? banners : [{ title: settings.mallName || '', sub: settings.slogan || '', bg: 'linear-gradient(135deg,#4d8dff,#7b5cff)' }];
    list = src.map((b) => ({
      type: (b.media && b.media.type) || 'none',
      url: (b.media && b.media.url) || '',
      title: b.title || '', sub: b.sub || '', badge: b.badge || '',
      bg: b.bg, duration: Math.max(3, Number(cfg.interval) || 6)
    }));
  }
  if (cfg.order === 'shuffle') list = list.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
  return list;
}

function enterScreensaver() {
  const cfg = ssConfig();
  if (!cfg.enabled) return;
  const box = $('#screensaver');
  if (box.classList.contains('active')) return;
  const list = buildSsPlaylist();
  if (!list.length) return;

  box.className = 'screensaver active t-' + cfg.transition;
  $('#ssHint').style.display = cfg.showHint ? '' : 'none';
  $('#ssProgress').style.display = cfg.showProgress ? '' : 'none';
  $('#ssBrand').style.display = cfg.showMallName ? '' : 'none';
  $('#ssClock').style.display = cfg.showClock ? '' : 'none';
  $('#ssMallName').textContent = settings.mallName || '';

  const inner = $('#ssInner'); inner.innerHTML = '';
  list.forEach((it, i) => {
    const s = document.createElement('div');
    s.className = 'ss-slide' + (i === 0 ? ' on' : '');
    s.style.background = it.bg || '#0a0f1c';
    if (it.type === 'none') {
      s.innerHTML = `<div class="ss-slide-text">${it.badge ? `<div class="ss-badge">${esc(it.badge)}</div>` : ''}<div class="ss-title">${esc(it.title)}</div>${it.sub ? `<div class="ss-sub">${esc(it.sub)}</div>` : ''}</div>`;
    } else if (it.type === 'page') {
      // HTML5 互动页
      if (cfg.pageTap === 'activity') {
        // 整页点击进入关联活动：iframe 不接收指针，由上层捕获层统一响应点击
        s.innerHTML = `<iframe class="ss-media" src="${esc(it.url)}" loading="lazy" style="pointer-events:none"></iframe><div class="ss-catcher" data-ss-tap="1"></div>`;
      } else {
        // 保留 H5 交互：另给一个角标按钮用于跳转关联活动
        s.innerHTML = `<iframe class="ss-media" src="${esc(it.url)}" loading="lazy"></iframe>` +
          (it.promoId ? '<div class="ss-activity-btn" data-ss-activity="1">🎁 进入活动详情</div>' : '');
      }
    } else {
      const media = it.type === 'video'
        ? `<video class="ss-media" src="${esc(it.url)}" muted playsinline${cfg.videoMode === 'timed' ? ' loop' : ''}></video>`
        : `<div class="ss-media media-img" style="background-image:url('${esc(it.url)}')"></div>`;
      const text = (it.title || it.sub || it.badge)
        ? `<div class="ss-slide-text">${it.badge ? `<div class="ss-badge">${esc(it.badge)}</div>` : ''}<div class="ss-title">${esc(it.title)}</div>${it.sub ? `<div class="ss-sub">${esc(it.sub)}</div>` : ''}</div>`
        : '';
      s.innerHTML = media + `<div class="ss-slide-dim" style="opacity:${cfg.dim}"></div>` + text;
    }
    inner.appendChild(s);
  });

  ssState.list = list; ssState.idx = 0; ssState.active = true;
  showSsSlide(0);
}

function showSsSlide(i) {
  const cfg = ssConfig();
  const list = ssState.list;
  const slides = $$('#ssInner .ss-slide');
  ssState.idx = ((i % list.length) + list.length) % list.length;
  const cur = list[ssState.idx];
  slides.forEach((s, k) => s.classList.toggle('on', k === ssState.idx));
  $('#screensaver').classList.toggle('ss-page', cur.type === 'page');
  tickClock();

  // 点击提示文案随当前素材的跳转目标变化
  if (cfg.showHint) {
    const p = cur.promoId ? promos.find((x) => x.id === cur.promoId) : null;
    const goActivity = (cur.type === 'page') ? (cfg.pageTap === 'activity') : (cfg.tapAction === 'activity');
    $('#ssHint').textContent = !goActivity ? '轻触屏幕任意位置继续'
      : (p ? `轻触进入活动：${p.title}` : '轻触查看（当前内容未关联活动）');
  }

  // 视频：静音策略 + 播放；其它页的视频/iframe 暂停，避免后台占用资源
  const vd = slides[ssState.idx] && slides[ssState.idx].querySelector('video');
  if (vd) { vd.muted = cfg.mute; const p = vd.play(); if (p && p.catch) p.catch(() => { }); }
  slides.forEach((s, k) => {
    if (k === ssState.idx) return;
    const v = s.querySelector('video');
    if (v) { try { v.pause(); v.currentTime = 0; } catch (e) { } }
  });

  // 进度条：按本张停留时长线性推进
  const bar = $('#ssProgress i');
  const dur = Math.max(3, Number(cur.duration) || cfg.interval) * 1000;
  bar.style.transition = 'none'; bar.style.width = '0%';
  void bar.offsetWidth; // 强制重排以重启动画
  if (cfg.showProgress) { bar.style.transition = `width ${dur}ms linear`; bar.style.width = '100%'; }

  // 播放控制：视频「播完切换」监听 ended，其余按停留时长切换
  clearTimeout(ssState.timer);
  const last = ssState.idx === list.length - 1;
  if (vd && cfg.videoMode === 'ended') {
    let done = false;
    const goNext = () => { if (done) return; done = true; nextSsSlide(last); };
    vd.addEventListener('ended', goNext, { once: true });
    ssState.timer = setTimeout(goNext, Math.min(dur * 4, 180000)); // 兜底，避免异常卡住
  } else {
    ssState.timer = setTimeout(() => nextSsSlide(last), dur);
  }
}

function nextSsSlide(last) {
  const cfg = ssConfig();
  if (last && !cfg.loop) { exitScreensaver(); resetIdle(); return; }
  showSsSlide(ssState.idx + 1);
}

function exitScreensaver() {
  clearTimeout(ssState.timer); ssState.timer = null; ssState.active = false;
  $$('#ssInner video').forEach((v) => { try { v.pause(); } catch (e) { } });
  $('#screensaver').className = 'screensaver';
  $('#ssInner').innerHTML = '';
}
/* 待机页点击：优先跳转「关联活动」；未关联或活动已删除时给出明确提示并优雅退出（不再一律回首页） */
function showSsToast(msg) {
  const t = $('#ssToast');
  if (!t) return;
  t.textContent = msg; t.classList.add('on');
  clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove('on'), 2000);
}
function openSsActivity(promoId) {
  const p = promoId ? promos.find((x) => x.id === promoId) : null;
  if (!p) {
    // 异常兜底：无对应活动 → 明确提示，短暂停留后退出待机页，避免"点了没反应"卡在待机页
    showSsToast(promoId ? '关联的活动已不存在，即将返回首页' : '该待机内容暂未关联活动，即将返回首页');
    clearTimeout(ssState.timer); ssState.timer = null;
    setTimeout(() => { exitScreensaver(); resetIdle(); }, 1500);
    return;
  }
  exitScreensaver();
  openPromo(p);
  resetIdle();
}
function onSsTap(e) {
  if (e) {
    if (e.stopPropagation) e.stopPropagation();
    // 角标按钮自带点击逻辑，避免被此处提前退出
    if (e.target && e.target.closest && e.target.closest('[data-ss-activity]')) return;
  }
  const cfg = ssConfig();
  const cur = ssState.list[ssState.idx] || {};
  const toActivity = (cur.type === 'page') ? (cfg.pageTap === 'activity') : (cfg.tapAction === 'activity');
  if (toActivity) { openSsActivity(cur.promoId); return; }
  exitScreensaver();
  resetIdle();
}
$('#screensaver').addEventListener('pointerdown', onSsTap);
$('#screensaver').addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-ss-activity]');
  if (!btn) return;
  e.stopPropagation();
  openSsActivity((ssState.list[ssState.idx] || {}).promoId);
});

function resetIdle() {
  clearTimeout(idleTimer);
  if ($('#screensaver').classList.contains('active')) return; // 待机页中等待触摸退出
  idleTimer = setTimeout(enterScreensaver, ssIdleSeconds() * 1000);
}
document.addEventListener('pointerdown', () => { if (!$('#screensaver').classList.contains('active')) resetIdle(); }, true);
document.addEventListener('keydown', () => { if (!$('#screensaver').classList.contains('active')) resetIdle(); }, true);

/* ---------------- 商场 LOGO 动态应用 ---------------- */
function applyMallLogo(logo) {
  const top = $('#mallLogo'), topEmoji = $('#brandLogo');
  if (logo) { if (top) { top.src = logo; top.hidden = false; } if (topEmoji) topEmoji.style.display = 'none'; }
  else { if (top) top.hidden = true; if (topEmoji) topEmoji.style.display = ''; }
  const ss = $('#ssMallLogo'), ssEmoji = $('#ssLogo');
  if (logo) { if (ss) { ss.src = logo; ss.hidden = false; } if (ssEmoji) ssEmoji.style.display = 'none'; }
  else { if (ss) ss.hidden = true; if (ssEmoji) ssEmoji.style.display = ''; }
}

/* ---------------- 初始化 ---------------- */
async function init() {
  const mallHint = resolveMallHintSync();
  try { M = await getJSON('/api/map' + (mallHint ? '?mall=' + encodeURIComponent(mallHint) : '')); } catch (e) { alert('无法连接导视服务，请确认服务已启动。'); return; }
  if (!M || !M.ok) { alert('导视数据加载失败。'); return; }
  window.__mallId = M.mallId || '';
  floors = M.floors || []; shops = M.shops || []; facilities = M.facilities || [];
  promos = M.promos || []; banners = M.banners || []; graph = M.graph || { nodes: [], edges: [] };
  settings = M.settings || {}; cats = M.categories || []; facTypes = M.facilityTypes || [];
  startNode = settings.startNode;

  $('#mallName').textContent = settings.mallName || '商场智能导视';
  $('#mallSlogan').textContent = settings.slogan || '';
  document.title = (settings.mallName || '商场') + ' · 智能导视系统';
  applyMallLogo(settings.mallLogo);

  activeFloorId = (floors[0] || {}).id;
  viewFloor = createMapView($('#mapSvg'));
  viewGuide = createMapView($('#guideSvg'));
  $('#zoomIn').onclick = () => viewFloor.zoomIn();
  $('#zoomOut').onclick = () => viewFloor.zoomOut();
  $('#zoomReset').onclick = () => viewFloor.reset();
  const tb = $('#toggleBase');
  if (tb) {
    tb.classList.toggle('on', showBase);
    tb.onclick = () => {
      showBase = !showBase;
      tb.classList.toggle('on', showBase);
      renderFloorMap();
      if (currentRoute) renderGuide();
    };
  }
  const mc = $('#mediaClose');
  if (mc) mc.onclick = closePromo;
  const mm = $('#mediaModal');
  if (mm) mm.addEventListener('click', (e) => { if (e.target === mm) closePromo(); });

  renderHome();
  buildFloorRail();
  buildFacFilter();
  renderFloorMap();
  renderPromo();
  renderService();
  showScreen('home');

  // 支持 ?ss=1 直接预览「待机页」（供后台预览按钮使用）
  if (/[?&]ss=1/.test(location.search)) setTimeout(() => { clearTimeout(idleTimer); enterScreensaver(); }, 400);
  // 支持 ?go=service 直接预览「服务指南」（供后台预览按钮使用）
  if (/[?&]go=service/.test(location.search)) { renderService(); showScreen('service'); }

  // 多屏分发：按自身位置标识加载专属界面，并开启远程切换轮询
  bootScreen();
}

tickClock(); setInterval(tickClock, 1000);
init();

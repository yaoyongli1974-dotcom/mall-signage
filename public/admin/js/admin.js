/* ============================================================
   商场智能导视系统 - 管理后台逻辑（原生 JS，无依赖）
   模块：登录 / 概览 / 楼层 / 店铺 / 设施 / 活动 / Banner /
        平面编辑（可视化拖拽）/ 节点与连线 / 系统设置
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $svg = (n, a) => { const e = document.createElementNS('http://www.w3.org/2000/svg', n); for (const k in (a || {})) e.setAttribute(k, a[k]); return e; };

const TOKEN_KEY = 'mallAdminToken';
let token = localStorage.getItem(TOKEN_KEY) || '';
let me = null;             // 当前登录账号 {id,username,role,mallId,perms}；role = platform | mall
let malls = [];            // 平台侧商场列表（含数据计数）
let users = [];            // 用户列表（平台=全量，商场=本商场）
let curMall = localStorage.getItem('mallAdminMall') || '';  // 平台账号当前操作的商场
let D = { floors: [], shops: [], facilities: [], promos: [], banners: [], graph: { nodes: [], edges: [] }, settings: {} };
let cats = [], facTypes = [];
let tab = 'overview';
let editing = {};        // 各表单的编辑态
let editorFloor = null, selShopId = null, editorMode = 'shop'; // shop=拖拽店铺, base=拖拽底图

/* ---------------- 请求封装 ---------------- */
async function api(method, path, body) {
  const opt = { method, headers: {} };
  if (token) { opt.headers['x-auth-token'] = token; opt.headers['x-admin-token'] = token; }
  if (me && me.role === 'platform' && curMall) opt.headers['x-mall-id'] = curMall;
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  if (r.status === 401) { logout(); throw new Error('登录已失效，请重新登录'); }
  return r.json();
}
async function getPublic(path) { return (await fetch(path)).json(); }

function toast(msg, type) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast on ' + (type || '');
  clearTimeout(t._tm); t._tm = setTimeout(() => { t.className = 'toast ' + (type || ''); }, 2200);
}

/* ---------------- 素材上传 / 媒体编辑器（店铺 Logo · 活动页面 · Banner 素材共用） ---------------- */
const MEDIA_LABEL = { none: '无（仅文字）', image: '图片', video: '视频', page: '互动网页（H5 链接）' };

function mediaPill(m) {
  const type = (m && m.type) || 'none';
  if (type === 'none' || !(m && m.url)) return '<span class="pill">仅文字</span>';
  const color = { image: 'rgba(77,141,255,.55)', video: 'rgba(123,92,255,.55)', page: 'rgba(52,211,153,.55)' }[type] || 'var(--line)';
  return `<span class="pill" style="border-color:${color}">${MEDIA_LABEL[type] || type}</span>`;
}

async function uploadAsset(file, prefix) {
  const isVid = /^video\//.test(file.type);
  const maxMB = isVid ? 40 : 4;
  if (file.size > maxMB * 1024 * 1024) throw new Error(`${isVid ? '视频' : '图片'}需小于 ${maxMB}MB`);
  const dataUrl = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
  const r = await api('POST', '/api/upload/asset', { dataUrl, prefix });
  if (!r.ok) throw new Error(r.error || '上传失败');
  return r.url;
}

function mediaEditorHtml(prefix, m) {
  const md = m || { type: 'none', url: '' };
  return `<div class="media-editor" id="me-${prefix}">
    <div class="form-grid">
      <div class="field"><label>页面 / 素材类型</label>
        <select class="sel me-type">
          ${['none', 'image', 'video', 'page'].map((t) => `<option value="${t}" ${md.type === t ? 'selected' : ''}>${MEDIA_LABEL[t]}</option>`).join('')}
        </select></div>
      <div class="field"><label>素材地址 / 链接</label>
        <input class="inp me-url" placeholder="上传后自动填入，或粘贴外链 https://…" value="${esc(md.url || '')}" /></div>
    </div>
    <div class="inline" style="margin-top:10px">
      <input type="file" class="me-file" />
      <span class="help me-tip" style="margin:0"></span>
    </div>
    <div class="me-preview"></div>
  </div>`;
}

function syncMediaEditor(prefix) {
  const box = $('#me-' + prefix); if (!box) return;
  const type = $('.me-type', box).value;
  const fileEl = $('.me-file', box);
  const tip = $('.me-tip', box);
  const prev = $('.me-preview', box);
  const url = $('.me-url', box).value.trim();
  if (type === 'image') { fileEl.disabled = false; fileEl.accept = 'image/png,image/jpeg,image/webp,image/svg+xml,image/gif'; tip.textContent = '图片：PNG / JPG / WEBP / SVG / GIF，≤4MB（建议比例见下方说明）'; }
  else if (type === 'video') { fileEl.disabled = false; fileEl.accept = 'video/mp4,video/webm,video/ogg'; tip.textContent = '视频：MP4 / WEBM / OGG，≤40MB，建议 1080p、16:9、时长 ≤30s'; }
  else if (type === 'page') { fileEl.disabled = true; fileEl.accept = ''; tip.textContent = '互动网页：请填写 https:// 开头的 H5 链接（目标站点需允许被 iframe 嵌入）'; }
  else { fileEl.disabled = true; fileEl.accept = ''; tip.textContent = '选择类型后，上传素材或填写链接'; }
  if (!url || type === 'none') { prev.innerHTML = ''; return; }
  if (type === 'image') prev.innerHTML = `<img src="${esc(url)}" alt="预览" />`;
  else if (type === 'video') prev.innerHTML = `<video src="${esc(url)}" controls muted playsinline></video>`;
  else prev.innerHTML = `<iframe src="${esc(url)}" loading="lazy"></iframe><div class="help">若上方空白：目标站点可能禁止被 iframe 嵌入（X-Frame-Options / CSP frame-ancestors）。</div>`;
}

function wireMediaEditor(prefix) {
  const box = $('#me-' + prefix); if (!box) return;
  $('.me-type', box).onchange = () => syncMediaEditor(prefix);
  $('.me-url', box).oninput = () => syncMediaEditor(prefix);
  $('.me-file', box).onchange = async () => {
    const f = $('.me-file', box).files && $('.me-file', box).files[0];
    if (!f) return;
    try {
      toast('素材上传中…');
      const url = await uploadAsset(f, prefix === 'pr' ? 'promo' : (prefix === 'bn' ? 'banner' : prefix));
      $('.me-url', box).value = url;
      const t = $('.me-type', box);
      if (t.value === 'none') t.value = (/^video\//.test(f.type) || /\.(mp4|webm|ogg)$/i.test(f.name)) ? 'video' : 'image';
      syncMediaEditor(prefix);
      toast('素材已上传，记得点保存', 'ok');
    } catch (e) { toast(e.message || '上传失败', 'err'); }
  };
  syncMediaEditor(prefix);
}

function collectMedia(prefix) {
  const box = $('#me-' + prefix);
  if (!box) return { type: 'none', url: '', poster: '' };
  const type = $('.me-type', box).value;
  const url = $('.me-url', box).value.trim();
  return { type: url ? type : 'none', url, poster: '' };
}

/* ---------------- 登录 ---------------- */
function showLogin() { $('#login').classList.remove('hidden'); $('#adminApp').hidden = true; }
function showApp() { $('#login').classList.add('hidden'); $('#adminApp').hidden = false; }

$('#loginBtn').onclick = doLogin;
$('#loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('#loginUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
async function doLogin() {
  const username = $('#loginUser').value.trim(), pass = $('#loginPass').value;
  if (!username || !pass) { $('#loginTip').textContent = '请输入用户名与密码'; $('#loginTip').className = 'login-tip err'; return; }
  const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: pass }) });
  const j = await r.json();
  if (j.ok) {
    token = j.token; me = j.user;
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem('mallAdminUser', JSON.stringify(me));
    curMall = me.role === 'mall' ? me.mallId : '';
    localStorage.setItem('mallAdminMall', curMall);
    $('#loginTip').textContent = '平台账号默认 admin / admin123'; $('#loginTip').className = 'login-tip';
    await boot();
  } else {
    $('#loginTip').textContent = j.error || '登录失败'; $('#loginTip').className = 'login-tip err';
  }
}
$('#logout').onclick = logout;
function logout() { token = ''; me = null; localStorage.removeItem(TOKEN_KEY); localStorage.removeItem('mallAdminUser'); showLogin(); }

/* ---------------- 数据加载 ---------------- */
async function loadAll() {
  const m = await getPublic('/api/map' + (me && me.role === 'platform' && curMall ? '?mall=' + encodeURIComponent(curMall) : ''));
  if (!m || !m.ok) throw new Error('数据加载失败');
  D.floors = m.floors || []; D.shops = m.shops || []; D.facilities = m.facilities || [];
  D.promos = m.promos || []; D.banners = m.banners || []; D.graph = m.graph || { nodes: [], edges: [] };
  D.settings = m.settings || {}; cats = m.categories || []; facTypes = m.facilityTypes || [];
  if (m.mallId) { curMall = m.mallId; localStorage.setItem('mallAdminMall', curMall); }
  const sc = await api('GET', '/api/screens');
  D.screens = (sc && sc.ok) ? (sc.data || []) : [];
  if (me) {
    const ul = await api('GET', '/api/users');
    users = (ul && ul.ok) ? (ul.data || []) : [];
    if (me.role === 'platform') {
      const ml = await api('GET', '/api/malls');
      malls = (ml && ml.ok) ? (ml.data || []) : [];
    }
    applyRoleUI();
  }
  if (!editorFloor || !D.floors.some((f) => f.id === editorFloor)) editorFloor = (D.floors[0] || {}).id;
}
function applyRoleUI() {
  const isPlatform = me && me.role === 'platform';
  $$('#sideNav .pt-only').forEach((b) => b.hidden = !isPlatform);
  // 商场账号：按模块权限显隐页签（perms 空 = 全部）
  const PERM_OF_TAB = { floors: 'floors', shops: 'shops', facilities: 'facilities', promos: 'promos', banners: 'banners', screen: 'standby', guide: 'guide', screens: 'screens', map: 'map', graph: 'graph', settings: 'settings' };
  $$('#sideNav button').forEach((b) => {
    const t = b.dataset.tab;
    if (me && me.role === 'mall' && PERM_OF_TAB[t]) b.hidden = !canPerm(PERM_OF_TAB[t]);
    if (t === 'overview') b.hidden = false;
  });
  const sw = $('#mallSwitch');
  if (sw) {
    sw.hidden = !isPlatform;
    if (isPlatform) {
      sw.innerHTML = malls.map((mm) => `<option value="${esc(mm.id)}" ${mm.id === curMall ? 'selected' : ''}>🏬 ${esc(mm.name)}${mm.status === 'disabled' ? '（停用）' : ''}</option>`).join('');
    }
  }
}
function switchMall(id) {
  if (id === curMall) return;
  curMall = id; localStorage.setItem('mallAdminMall', id);
  editorFloor = null; selShopId = null; editing = {}; tab = 'overview';
  $$('#sideNav button').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'overview'));
  refresh();
}
const canPerm = (mod) => !me || me.role === 'platform' || !me.perms || !me.perms.length || me.perms.includes(mod);
const catMeta = (k) => cats.find((c) => c.key === k) || { key: k, label: '其他', icon: '📍', color: '#90a4ae' };
const facMeta = (t) => facTypes.find((f) => f.key === t) || { key: t, label: '设施', icon: '📍', color: '#90a4ae' };
const floorShort = (id) => { const f = D.floors.find((x) => x.id === id); return f ? (f.short || f.name) : id; };
const floorName = (id) => { const f = D.floors.find((x) => x.id === id); return f ? f.name : id; };

/* ---------------- 侧栏 ---------------- */
$$('#sideNav button').forEach((b) => b.addEventListener('click', () => {
  tab = b.dataset.tab;
  $$('#sideNav button').forEach((x) => x.classList.toggle('on', x === b));
  render();
}));
const ms = $('#mallSwitch');
if (ms) ms.onchange = () => switchMall(ms.value);

async function refresh() { await loadAll(); render(); }

/* ---------------- 渲染分发 ---------------- */
function render() {
  const c = $('#content');
  if (tab === 'overview') c.innerHTML = viewOverview();
  else if (tab === 'malls') c.innerHTML = viewMalls();
  else if (tab === 'users') c.innerHTML = viewUsers();
  else if (tab === 'floors') c.innerHTML = viewFloors();
  else if (tab === 'shops') c.innerHTML = viewShops();
  else if (tab === 'facilities') c.innerHTML = viewFacilities();
  else if (tab === 'promos') c.innerHTML = viewPromos();
  else if (tab === 'banners') c.innerHTML = viewBanners();
  else if (tab === 'screen') c.innerHTML = viewScreen();
  else if (tab === 'guide') c.innerHTML = viewGuide();
  else if (tab === 'screens') c.innerHTML = viewScreens();
  else if (tab === 'map') c.innerHTML = viewMap();
  else if (tab === 'graph') c.innerHTML = viewGraph();
  else if (tab === 'settings') c.innerHTML = viewSettings();
  wire();
}

/* ---------------- 概览 ---------------- */
function viewOverview() {
  const byFloor = D.floors.map((f) => ({
    f, shops: D.shops.filter((s) => s.floorId === f.id).length, facs: D.facilities.filter((x) => x.floorId === f.id).length
  }));
  const activePromos = D.promos.filter((p) => p.active).length;
  return `
  <div class="page-head"><div><h1>数据概览</h1><div class="sub">导视系统内容一览 · ${esc(D.settings.mallName || '')}</div></div>
    <button class="btn" onclick="location.reload()">↻ 刷新数据</button></div>
  <div class="stats">
    <div class="stat"><div class="v">${D.floors.length}</div><div class="l">楼层</div></div>
    <div class="stat"><div class="v">${D.shops.length}</div><div class="l">店铺 / 品牌</div></div>
    <div class="stat"><div class="v">${D.facilities.length}</div><div class="l">公共设施</div></div>
    <div class="stat"><div class="v">${D.promos.length}</div><div class="l">优惠活动（进行中 ${activePromos}）</div></div>
    <div class="stat"><div class="v">${D.banners.length}</div><div class="l">首页 Banner</div></div>
    <div class="stat"><div class="v">${D.graph.nodes.length}</div><div class="l">导航节点</div></div>
    <div class="stat"><div class="v">${D.graph.edges.length}</div><div class="l">路网连线</div></div>
  </div>
  <div class="card"><h3>各楼层分布</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>楼层</th><th>标识</th><th>店铺</th><th>设施</th><th>主题</th></tr></thead>
      <tbody>${byFloor.map((r) => `<tr><td>${esc(r.f.name)}</td><td><span class="pill">${esc(r.f.short || r.f.id)}</span></td><td>${r.shops}</td><td>${r.facs}</td><td class="mono">${esc(r.f.theme || '—')}</td></tr>`).join('')}</tbody>
    </table></div>
  </div>`;
}

/* ---------------- 楼层 ---------------- */
function viewFloors() {
  const ed = editing.floor;
  return `
  <div class="page-head"><div><h1>楼层管理</h1><div class="sub">楼层 ID 按层序自动连续编号（F1…Fn）</div></div>
    <button class="btn primary" id="addFloor">＋ 新增楼层</button></div>
  <div class="card"><h3>${ed ? '编辑楼层' : '楼层列表'}</h3>
    ${ed ? floorForm(ed) : `<div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>名称</th><th>标识</th><th>层序</th><th>主题</th><th>店铺</th><th>操作</th></tr></thead>
      <tbody>${D.floors.map((f) => `<tr>
        <td class="mono">${esc(f.id)}</td><td>${esc(f.name)}</td><td><span class="pill">${esc(f.short || '')}</span></td>
        <td>${f.level}</td><td class="mono">${esc(f.theme || '—')}</td><td>${D.shops.filter((s) => s.floorId === f.id).length}</td>
        <td><button class="btn sm" data-edit-floor="${esc(f.id)}">编辑</button>
            <button class="btn sm danger" data-del-floor="${esc(f.id)}">删除</button></td></tr>`).join('')}</tbody>
    </table></div>`}
  </div>`;
}
function floorForm(f) {
  const nf = f === 'new';
  const o = nf ? { name: '', short: '', level: (D.floors.reduce((m, x) => Math.max(m, x.level || 0), 0) + 1), theme: '' } : f;
  return `<div class="form-grid">
    <div class="field"><label>楼层名称</label><input id="fl-name" value="${esc(o.name)}" placeholder="如：五层" /></div>
    <div class="field"><label>楼层标识</label><input id="fl-short" value="${esc(o.short || '')}" placeholder="如：5F / B2" /></div>
    <div class="field"><label>层序（数字，越小越靠下）</label><input id="fl-level" type="number" value="${o.level}" /></div>
    <div class="field"><label>楼层主题</label><input id="fl-theme" value="${esc(o.theme || '')}" placeholder="如：环球美食 · 影院娱乐" /></div>
  </div>
  <div class="form-actions">
    <button class="btn primary" id="fl-save">${nf ? '创建楼层' : '保存修改'}</button>
    <button class="btn" id="fl-cancel">取消</button>
  </div>`;
}
function wireFloors() {
  const add = $('#addFloor'); if (add) add.onclick = () => { editing.floor = 'new'; render(); };
  $$('[data-edit-floor]').forEach((b) => b.onclick = () => { editing.floor = D.floors.find((f) => f.id === b.dataset.editFloor); render(); });
  $$('[data-del-floor]').forEach((b) => b.onclick = async () => {
    if (!confirm('确认删除该楼层？其下店铺、设施与节点将一并删除，且删后楼层 ID 会重排。')) return;
    const r = await api('DELETE', '/api/floors/' + b.dataset.delFloor);
    r.ok ? (toast('已删除楼层', 'ok'), refresh()) : toast(r.error || '删除失败', 'err');
  });
  const save = $('#fl-save');
  if (save) save.onclick = async () => {
    const body = { name: $('#fl-name').value.trim(), short: $('#fl-short').value.trim(), level: Number($('#fl-level').value), theme: $('#fl-theme').value.trim() };
    if (!body.name) return toast('请填写楼层名称', 'err');
    const isNew = editing.floor === 'new';
    const r = await api(isNew ? 'POST' : 'PUT', isNew ? '/api/floors' : '/api/floors/' + editing.floor.id, body);
    if (r.ok) { toast(isNew ? '楼层已创建' : '已保存', 'ok'); editing.floor = null; refresh(); } else toast(r.error || '保存失败', 'err');
  };
  const cancel = $('#fl-cancel'); if (cancel) cancel.onclick = () => { editing.floor = null; render(); };
}

/* ---------------- 店铺 ---------------- */
function viewShops() {
  const ed = editing.shop;
  const kw = (editing.shopKw || '').trim().toLowerCase();
  let list = D.shops.slice();
  if (kw) list = list.filter((s) => (s.name || '').toLowerCase().includes(kw) || catMeta(s.cat).label.includes(kw));
  return `
  <div class="page-head"><div><h1>店铺 / 品牌管理</h1><div class="sub">共 ${D.shops.length} 家商户，坐标用于平面图标注与路线规划</div></div>
    <div class="inline">
      <input id="shopKw" class="inp" placeholder="搜索店铺…" value="${esc(editing.shopKw || '')}" />
      <button class="btn primary" id="addShop">＋ 新增店铺</button>
    </div></div>
  <div class="card"><h3>${ed ? (ed === 'new' ? '新增店铺' : '编辑店铺：' + esc(ed.name)) : '店铺列表'}</h3>
    ${ed ? shopForm(ed) : `<div class="table-wrap"><table>
      <thead><tr><th>名称</th><th>业态</th><th>楼层</th><th>坐标 (x,y)</th><th>尺寸</th><th>电话</th><th>操作</th></tr></thead>
      <tbody>${list.map((s) => `<tr>
        <td>${esc(s.name)}</td><td><span class="pill" style="border-color:${catMeta(s.cat).color}88">${catMeta(s.cat).icon} ${esc(catMeta(s.cat).label)}</span></td>
        <td>${esc(floorShort(s.floorId))}</td><td class="mono">${s.x}, ${s.y}</td><td class="mono">${s.w}×${s.h}</td><td class="mono">${esc(s.phone || '—')}</td>
        <td><button class="btn sm" data-edit-shop="${esc(s.id)}">编辑</button>
            <button class="btn sm danger" data-del-shop="${esc(s.id)}">删除</button></td></tr>`).join('')}</tbody>
    </table></div>`}
  </div>`;
}
function shopForm(s) {
  const nf = s === 'new';
  const o = nf ? { name: '', floorId: (D.floors[0] || {}).id, cat: 'other', letter: '', x: 100, y: 100, w: 200, h: 110, color: '', phone: '', hours: '10:00 - 22:00', desc: '', tags: [] } : s;
  return `<div class="form-grid">
    <div class="field"><label>店铺名称 *</label><input id="sh-name" value="${esc(o.name)}" /></div>
    <div class="field"><label>所在楼层</label><select id="sh-floor">${D.floors.map((f) => `<option value="${esc(f.id)}" ${f.id === o.floorId ? 'selected' : ''}>${esc(f.name)}（${esc(f.short || f.id)}）</option>`).join('')}</select></div>
    <div class="field"><label>经营业态</label><select id="sh-cat">${cats.map((c) => `<option value="${esc(c.key)}" ${c.key === o.cat ? 'selected' : ''}>${c.icon} ${esc(c.label)}</option>`).join('')}</select></div>
    <div class="field"><label>字母索引</label><input id="sh-letter" value="${esc(o.letter || '')}" maxlength="1" placeholder="如 X" /></div>
    <div class="field"><label>X 坐标（像素）</label><input id="sh-x" type="number" value="${o.x}" /></div>
    <div class="field"><label>Y 坐标（像素）</label><input id="sh-y" type="number" value="${o.y}" /></div>
    <div class="field"><label>宽度</label><input id="sh-w" type="number" value="${o.w}" /></div>
    <div class="field"><label>高度</label><input id="sh-h" type="number" value="${o.h}" /></div>
    <div class="field"><label>标注颜色</label><input id="sh-color" type="color" value="${esc(o.color || catMeta(o.cat).color)}" style="padding:4px" /></div>
    <div class="field"><label>联系电话</label><input id="sh-phone" value="${esc(o.phone || '')}" /></div>
    <div class="field"><label>营业时间</label><input id="sh-hours" value="${esc(o.hours || '')}" /></div>
    <div class="field"><label>标签（逗号分隔）</label><input id="sh-tags" value="${esc((o.tags || []).join(','))}" /></div>
  </div>
  <div class="field" style="margin-top:14px"><label>店铺 Logo（可选）</label>
    <div class="inline">
      <div class="logo-preview" id="sh-logo-prev">${o.logo ? `<img src="${esc(o.logo)}" alt="logo" />` : '<span class="help">未上传</span>'}</div>
      <input type="file" id="sh-logo-file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" />
      <button class="btn sm" id="sh-logo-clear" type="button">清除</button>
    </div>
    <div class="help">格式：PNG / JPG / WEBP / SVG / GIF；建议 <b>1:1 正方形、≥256×256px</b>，PNG 或 SVG 透明底更佳，单张 ≤2MB。前台用于「品牌导购」卡片头像与「店铺详情」头部标识。</div>
    <input type="hidden" id="sh-logo" value="${esc(o.logo || '')}" />
  </div>
  <div class="field" style="margin-top:14px"><label>店铺介绍</label><textarea id="sh-desc">${esc(o.desc || '')}</textarea></div>
  <div class="form-actions">
    <button class="btn primary" id="sh-save">${nf ? '创建店铺' : '保存修改'}</button>
    <button class="btn" id="sh-cancel">取消</button>
  </div>
  <div class="help">提示：坐标原点为平面图左上角（viewBox 1000×700）。可先在「平面编辑」中拖拽定位，再回到本页微调数值。</div>`;
}
function wireShops() {
  const add = $('#addShop'); if (add) add.onclick = () => { editing.shop = 'new'; render(); };
  const kwEl = $('#shopKw');
  if (kwEl) kwEl.addEventListener('input', () => { editing.shopKw = kwEl.value; render(); setTimeout(() => { const e = $('#shopKw'); if (e) { e.focus(); e.setSelectionRange(e.value.length, e.value.length); } }, 0); });
  $$('[data-edit-shop]').forEach((b) => b.onclick = () => { editing.shop = D.shops.find((s) => s.id === b.dataset.editShop); render(); });
  $$('[data-del-shop]').forEach((b) => b.onclick = async () => {
    if (!confirm('确认删除该店铺？其导航节点将保留但失去名称关联。')) return;
    const r = await api('DELETE', '/api/shops/' + b.dataset.delShop);
    r.ok ? (toast('已删除', 'ok'), refresh()) : toast(r.error || '删除失败', 'err');
  });
  const logoFile = $('#sh-logo-file');
  if (logoFile) logoFile.onchange = async () => {
    const f = logoFile.files && logoFile.files[0];
    if (!f) return;
    try {
      toast('Logo 上传中…');
      const url = await uploadAsset(f, 'logo');
      $('#sh-logo').value = url;
      $('#sh-logo-prev').innerHTML = `<img src="${esc(url)}" alt="logo" />`;
      toast('Logo 已上传，记得点「保存修改」', 'ok');
    } catch (e) { toast(e.message || '上传失败', 'err'); }
  };
  const logoClear = $('#sh-logo-clear');
  if (logoClear) logoClear.onclick = () => { $('#sh-logo').value = ''; $('#sh-logo-prev').innerHTML = '<span class="help">未上传</span>'; };

  const save = $('#sh-save');
  if (save) save.onclick = async () => {
    const body = {
      name: $('#sh-name').value.trim(), floorId: $('#sh-floor').value, cat: $('#sh-cat').value,
      letter: $('#sh-letter').value.trim(), x: Number($('#sh-x').value), y: Number($('#sh-y').value),
      w: Number($('#sh-w').value), h: Number($('#sh-h').value), color: $('#sh-color').value,
      phone: $('#sh-phone').value.trim(), hours: $('#sh-hours').value.trim(),
      logo: $('#sh-logo').value,
      desc: $('#sh-desc').value.trim(), tags: $('#sh-tags').value.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
    };
    if (!body.name) return toast('请填写店铺名称', 'err');
    const isNew = editing.shop === 'new';
    const r = await api(isNew ? 'POST' : 'PUT', isNew ? '/api/shops' : '/api/shops/' + editing.shop.id, body);
    if (r.ok) { toast(isNew ? '店铺已创建' : '已保存', 'ok'); editing.shop = null; refresh(); } else toast(r.error || '保存失败', 'err');
  };
  const cancel = $('#sh-cancel'); if (cancel) cancel.onclick = () => { editing.shop = null; render(); };
}

/* ---------------- 设施 ---------------- */
function viewFacilities() {
  const ed = editing.facility;
  return `
  <div class="page-head"><div><h1>公共设施管理</h1><div class="sub">洗手间、电梯、客服、母婴室、停车场等</div></div>
    <button class="btn primary" id="addFac">＋ 新增设施</button></div>
  <div class="card"><h3>${ed ? (ed === 'new' ? '新增设施' : '编辑设施：' + esc(ed.name)) : '设施列表'}</h3>
    ${ed ? facForm(ed) : `<div class="table-wrap"><table>
      <thead><tr><th>类型</th><th>名称</th><th>楼层</th><th>坐标</th><th>操作</th></tr></thead>
      <tbody>${D.facilities.map((f) => `<tr>
        <td>${facMeta(f.type).icon} ${esc(facMeta(f.type).label)}</td><td>${esc(f.name)}</td><td>${esc(floorShort(f.floorId))}</td>
        <td class="mono">${f.x}, ${f.y}</td>
        <td><button class="btn sm" data-edit-fac="${esc(f.id)}">编辑</button>
            <button class="btn sm danger" data-del-fac="${esc(f.id)}">删除</button></td></tr>`).join('')}</tbody>
    </table></div>`}
  </div>`;
}
function facForm(f) {
  const nf = f === 'new';
  const o = nf ? { type: 'restroom', name: '洗手间', floorId: (D.floors[0] || {}).id, x: 300, y: 300 } : f;
  return `<div class="form-grid">
    <div class="field"><label>设施类型</label><select id="fa-type">${facTypes.map((t) => `<option value="${esc(t.key)}" ${t.key === o.type ? 'selected' : ''}>${t.icon} ${esc(t.label)}</option>`).join('')}</select></div>
    <div class="field"><label>设施名称</label><input id="fa-name" value="${esc(o.name)}" /></div>
    <div class="field"><label>所在楼层</label><select id="fa-floor">${D.floors.map((f) => `<option value="${esc(f.id)}" ${f.id === o.floorId ? 'selected' : ''}>${esc(f.name)}（${esc(f.short || f.id)}）</option>`).join('')}</select></div>
    <div class="field"><label>X 坐标</label><input id="fa-x" type="number" value="${o.x}" /></div>
    <div class="field"><label>Y 坐标</label><input id="fa-y" type="number" value="${o.y}" /></div>
  </div>
  <div class="form-actions"><button class="btn primary" id="fa-save">${nf ? '创建设施' : '保存修改'}</button>
    <button class="btn" id="fa-cancel">取消</button></div>`;
}
function wireFacilities() {
  const add = $('#addFac'); if (add) add.onclick = () => { editing.facility = 'new'; render(); };
  $$('[data-edit-fac]').forEach((b) => b.onclick = () => { editing.facility = D.facilities.find((f) => f.id === b.dataset.editFac); render(); });
  $$('[data-del-fac]').forEach((b) => b.onclick = async () => {
    if (!confirm('确认删除该设施？')) return;
    const r = await api('DELETE', '/api/facilities/' + b.dataset.delFac);
    r.ok ? (toast('已删除', 'ok'), refresh()) : toast(r.error || '删除失败', 'err');
  });
  const save = $('#fa-save');
  if (save) save.onclick = async () => {
    const body = { type: $('#fa-type').value, name: $('#fa-name').value.trim(), floorId: $('#fa-floor').value, x: Number($('#fa-x').value), y: Number($('#fa-y').value) };
    if (!body.name) return toast('请填写设施名称', 'err');
    const isNew = editing.facility === 'new';
    const r = await api(isNew ? 'POST' : 'PUT', isNew ? '/api/facilities' : '/api/facilities/' + editing.facility.id, body);
    if (r.ok) { toast(isNew ? '设施已创建' : '已保存', 'ok'); editing.facility = null; refresh(); } else toast(r.error || '保存失败', 'err');
  };
  const cancel = $('#fa-cancel'); if (cancel) cancel.onclick = () => { editing.facility = null; render(); };
}

/* ---------------- 活动 ---------------- */
function viewPromos() {
  const ed = editing.promo;
  return `
  <div class="page-head"><div><h1>优惠活动管理</h1><div class="sub">按有效期自动判断进行中 / 已结束</div></div>
    <button class="btn primary" id="addPromo">＋ 新增活动</button></div>
  <div class="card"><h3>${ed ? (ed === 'new' ? '新增活动' : '编辑活动') : '活动列表'}</h3>
    ${ed ? promoForm(ed) : `<div class="table-wrap"><table>
      <thead><tr><th>标题</th><th>分类</th><th>楼层</th><th>有效期</th><th>活动页面</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${D.promos.map((p) => `<tr>
        <td>${esc(p.title)}</td><td><span class="pill">${esc(p.cat || '')}</span></td><td>${esc(p.floorShort || '全场')}</td>
        <td class="mono">${esc(p.startDate || '')} ~ ${esc(p.endDate || '')}</td>
        <td>${mediaPill(p.media)}</td>
        <td>${p.active ? '<span class="pill" style="border-color:rgba(52,211,153,.5)">进行中</span>' : '<span class="pill">已结束</span>'}</td>
        <td><button class="btn sm" data-edit-promo="${esc(p.id)}">编辑</button>
            <button class="btn sm danger" data-del-promo="${esc(p.id)}">删除</button></td></tr>`).join('')}</tbody>
    </table></div>`}
  </div>`;
}
function promoForm(p) {
  const nf = p === 'new';
  const o = nf ? { title: '', cat: '品牌特惠', startDate: '', endDate: '', floorId: '', color: '#ef6c4d', desc: '' } : p;
  return `<div class="form-grid">
    <div class="field"><label>活动标题 *</label><input id="pr-title" value="${esc(o.title)}" /></div>
    <div class="field"><label>分类</label><input id="pr-cat" value="${esc(o.cat || '')}" placeholder="品牌特惠 / 节日活动 / 会员专享…" /></div>
    <div class="field"><label>开始日期</label><input id="pr-start" type="date" value="${esc(o.startDate || '')}" /></div>
    <div class="field"><label>结束日期</label><input id="pr-end" type="date" value="${esc(o.endDate || '')}" /></div>
    <div class="field"><label>关联楼层（可选）</label><select id="pr-floor"><option value="">全场</option>${D.floors.map((f) => `<option value="${esc(f.id)}" ${f.id === o.floorId ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></div>
    <div class="field"><label>卡片主色</label><input id="pr-color" type="color" value="${esc(o.color || '#ef6c4d')}" style="padding:4px" /></div>
  </div>
  <div class="field" style="margin-top:16px"><label>活动页面素材（可选）</label></div>
  ${mediaEditorHtml('pr', o.media)}
  <div class="help">类型与展示效果：<br>
    • <b>图片</b>：直接上传或外链；前台点击活动卡片后<b>全屏展示</b>活动海报。<br>
    • <b>视频</b>：上传 MP4/WEBM（≤40MB）或外链；前台详情页内嵌播放器<b>自动静音播放、可全屏</b>。<br>
    • <b>互动网页</b>：填 H5 链接（https://…）；前台详情页以 <b>iframe 嵌入</b>，支持抽奖/报名/小游戏等交互。<br>
    ⚠️ 互动网页的站点需允许被 iframe 嵌入（未设置 X-Frame-Options / CSP frame-ancestors）。</div>
  <div class="field" style="margin-top:14px"><label>活动说明</label><textarea id="pr-desc">${esc(o.desc || '')}</textarea></div>
  <div class="form-actions"><button class="btn primary" id="pr-save">${nf ? '创建活动' : '保存修改'}</button>
    <button class="btn" id="pr-cancel">取消</button></div>`;
}
function wirePromos() {
  const add = $('#addPromo'); if (add) add.onclick = () => { editing.promo = 'new'; render(); };
  $$('[data-edit-promo]').forEach((b) => b.onclick = () => { editing.promo = D.promos.find((p) => p.id === b.dataset.editPromo); render(); });
  $$('[data-del-promo]').forEach((b) => b.onclick = async () => {
    if (!confirm('确认删除该活动？')) return;
    const r = await api('DELETE', '/api/promos/' + b.dataset.delPromo);
    r.ok ? (toast('已删除', 'ok'), refresh()) : toast(r.error || '删除失败', 'err');
  });
  wireMediaEditor('pr');
  const save = $('#pr-save');
  if (save) save.onclick = async () => {
    const body = { title: $('#pr-title').value.trim(), cat: $('#pr-cat').value.trim(), startDate: $('#pr-start').value, endDate: $('#pr-end').value, floorId: $('#pr-floor').value, color: $('#pr-color').value, desc: $('#pr-desc').value.trim(), media: collectMedia('pr') };
    if (!body.title) return toast('请填写活动标题', 'err');
    const isNew = editing.promo === 'new';
    const r = await api(isNew ? 'POST' : 'PUT', isNew ? '/api/promos' : '/api/promos/' + editing.promo.id, body);
    if (r.ok) { toast(isNew ? '活动已创建' : '已保存', 'ok'); editing.promo = null; refresh(); } else toast(r.error || '保存失败', 'err');
  };
  const cancel = $('#pr-cancel'); if (cancel) cancel.onclick = () => { editing.promo = null; render(); };
}

/* ---------------- Banner ---------------- */
function viewBanners() {
  const ed = editing.banner;
  return `
  <div class="page-head"><div><h1>Banner 管理</h1><div class="sub">用于首页轮播与屏保广告，背景支持 CSS 渐变或颜色</div></div>
    <button class="btn primary" id="addBanner">＋ 新增 Banner</button></div>
  <div class="card"><h3>${ed ? (ed === 'new' ? '新增 Banner' : '编辑 Banner') : 'Banner 列表'}</h3>
    ${ed ? bannerForm(ed) : `<div class="table-wrap"><table>
      <thead><tr><th>预览</th><th>标题</th><th>副标题</th><th>素材</th><th>跳转</th><th>操作</th></tr></thead>
      <tbody>${D.banners.map((b) => `<tr>
        <td><div style="width:120px;height:52px;border-radius:9px;background:${esc(b.bg || '#4d8dff')};display:grid;place-items:center;font-size:12px;color:#fff;${b.media && b.media.type === 'image' && b.media.url ? `background-image:url('${esc(b.media.url)}');background-size:cover;background-position:center` : ''}">${esc(b.badge || '')}</div></td>
        <td>${esc(b.title || '')}</td><td class="mono">${esc(b.sub || '')}</td>
        <td>${mediaPill(b.media)}</td>
        <td><span class="pill">${esc(b.action || 'floor')}</span></td>
        <td><button class="btn sm" data-edit-banner="${esc(b.id)}">编辑</button>
            <button class="btn sm danger" data-del-banner="${esc(b.id)}">删除</button></td></tr>`).join('')}</tbody>
    </table></div>`}
  </div>`;
}
function bannerForm(b) {
  const nf = b === 'new';
  const o = nf ? { title: '', sub: '', bg: 'linear-gradient(135deg,#4d8dff,#7b5cff)', badge: '', action: 'floor' } : b;
  return `<div class="form-grid">
    <div class="field"><label>主标题</label><input id="bn-title" value="${esc(o.title)}" /></div>
    <div class="field"><label>副标题</label><input id="bn-sub" value="${esc(o.sub || '')}" /></div>
    <div class="field"><label>角标文字</label><input id="bn-badge" value="${esc(o.badge || '')}" /></div>
    <div class="field"><label>背景（CSS 渐变/颜色）</label><input id="bn-bg" value="${esc(o.bg || '')}" /></div>
    <div class="field"><label>点击动作</label><select id="bn-action">
      <option value="floor" ${o.action === 'floor' ? 'selected' : ''}>跳转楼层导购</option>
      <option value="promo" ${o.action === 'promo' ? 'selected' : ''}>跳转优惠活动</option>
      <option value="service" ${o.action === 'service' ? 'selected' : ''}>跳转服务指南</option>
      <option value="none" ${o.action === 'none' ? 'selected' : ''}>无动作</option></select></div>
  </div>
  <div class="field" style="margin-top:16px"><label>Banner 素材（可选，覆盖背景）</label></div>
  ${mediaEditorHtml('bn', o.media)}
  <div class="help">首页 Banner 区域为<b>固定 4:1 宽幅</b>（视口 1920 宽时实测约 1868×467），素材以 <code>background-size:cover</code> 铺满，超出部分被裁切：<br>
    • <b>图片</b>：建议 <b>1920×480（4:1）</b>，同比例放大亦可（如 2560×640、3840×960）。若只有 16:9 素材，请把主体放在画面中央——上下各约 36% 会被裁掉。<br>
    • <b>视频</b>：上传 MP4/WEBM（≤40MB）或外链，按 4:1 取景；Banner 内<b>静音循环自动播放</b>作为动态背景，文案叠加在上层。<br>
    • <b>互动网页</b>：填 H5 链接，按 4:1 设计版式；Banner 区域<b>以 iframe 嵌入</b>，此时不再叠加文案（整块区域交给互动页）。<br>
    ⚠️ 注意：<b>「待机页」是全屏 16:9（1920×1080）</b>，与首页 Banner 的 4:1 不同，两处素材不可混用。</div>
  <div class="form-actions"><button class="btn primary" id="bn-save">${nf ? '创建 Banner' : '保存修改'}</button>
    <button class="btn" id="bn-cancel">取消</button></div>`;
}
function wireBanners() {
  const add = $('#addBanner'); if (add) add.onclick = () => { editing.banner = 'new'; render(); };
  $$('[data-edit-banner]').forEach((b) => b.onclick = () => { editing.banner = D.banners.find((x) => x.id === b.dataset.editBanner); render(); });
  $$('[data-del-banner]').forEach((b) => b.onclick = async () => {
    if (!confirm('确认删除该 Banner？')) return;
    const r = await api('DELETE', '/api/banners/' + b.dataset.delBanner);
    r.ok ? (toast('已删除', 'ok'), refresh()) : toast(r.error || '删除失败', 'err');
  });
  wireMediaEditor('bn');
  const save = $('#bn-save');
  if (save) save.onclick = async () => {
    const body = { title: $('#bn-title').value.trim(), sub: $('#bn-sub').value.trim(), badge: $('#bn-badge').value.trim(), bg: $('#bn-bg').value.trim(), action: $('#bn-action').value, media: collectMedia('bn') };
    if (!body.title) return toast('请填写主标题', 'err');
    const isNew = editing.banner === 'new';
    const r = await api(isNew ? 'POST' : 'PUT', isNew ? '/api/banners' : '/api/banners/' + editing.banner.id, body);
    if (r.ok) { toast(isNew ? 'Banner 已创建' : '已保存', 'ok'); editing.banner = null; refresh(); } else toast(r.error || '保存失败', 'err');
  };
  const cancel = $('#bn-cancel'); if (cancel) cancel.onclick = () => { editing.banner = null; render(); };
}

/* ---------------- 待机页配置（图片 / 视频 / HTML5 互动页 轮播） ---------------- */
function ssThumb(it) {
  if (it.type === 'image') return `<img src="${esc(it.url)}" alt="" style="width:72px;height:40px;object-fit:cover;border-radius:6px;border:1px solid var(--line);display:block" />`;
  if (it.type === 'video') return '<span class="pill" style="border-color:rgba(123,92,255,.55)">▶ 视频</span>';
  return '<span class="pill" style="border-color:rgba(52,211,153,.55)">🖱 互动页</span>';
}

// 关联活动单元格：未关联 / 正常 / 关联已失效（活动被删）
function promoLinkCell(it) {
  if (!it.promoId) return '<span class="pill">未关联</span>';
  const p = (D.promos || []).find((x) => x.id === it.promoId);
  if (!p) return '<span class="pill" style="border-color:rgba(248,113,113,.6);color:#f87171">⚠️ 活动已删除</span>';
  return `<span class="pill" style="border-color:rgba(52,211,153,.5)">🎁 ${esc(p.title)}</span>`;
}

function viewScreen() {
  const ss = D.settings.screensaver || { items: [] };
  const items = ss.items || [];
  // 失效关联：promoId 指向的活动已不存在（点击时会走异常兜底）
  const dangling = items.filter((it) => it.promoId && !(D.promos || []).find((p) => p.id === it.promoId));
  const ed = editing.ssItem;
  const flags = [
    ['showClock', '🕙 显示时钟', ss.showClock !== false],
    ['showMallName', '🏬 显示商场名', ss.showMallName !== false],
    ['showHint', '👆 显示触摸提示', ss.showHint !== false],
    ['showProgress', '▬ 显示进度条', ss.showProgress !== false]
  ];
  return `
  <div class="page-head"><div><h1>待机页配置</h1><div class="sub">无操作后进入的待机页：轮播展示图片 / 视频 / HTML5 互动页</div></div>
    <div class="inline">
      <a class="btn" href="/?ss=1" target="_blank" rel="noopener">👁 预览待机页</a>
      <button class="btn primary" id="ss-add">＋ 新增素材</button>
    </div></div>

  <div class="card"><h3>播放参数</h3>
    <div class="form-grid">
      <div class="field"><label>启用待机页</label><select class="sel" id="ss-enabled">
        <option value="1" ${ss.enabled !== false ? 'selected' : ''}>启用</option>
        <option value="0" ${ss.enabled === false ? 'selected' : ''}>关闭</option></select></div>
      <div class="field"><label>触发时间（秒无操作）</label><input class="inp" id="ss-idle" type="number" min="10" value="${ss.idleSeconds || 45}" /></div>
      <div class="field"><label>默认停留（秒 / 张）</label><input class="inp" id="ss-interval" type="number" min="3" value="${ss.interval || 8}" /></div>
      <div class="field"><label>切换方式</label><select class="sel" id="ss-transition">
        ${[['fade', '淡入淡出'], ['slide', '横向滑动'], ['zoom', '缓慢缩放'], ['none', '无动画']].map(([v, l]) => `<option value="${v}" ${ss.transition === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>
      <div class="field"><label>播放顺序</label><select class="sel" id="ss-order">
        <option value="sequence" ${ss.order !== 'shuffle' ? 'selected' : ''}>按顺序</option>
        <option value="shuffle" ${ss.order === 'shuffle' ? 'selected' : ''}>随机</option></select></div>
      <div class="field"><label>播完最后一屏</label><select class="sel" id="ss-loop">
        <option value="1" ${ss.loop !== false ? 'selected' : ''}>循环继续</option>
        <option value="0" ${ss.loop === false ? 'selected' : ''}>退出待机页</option></select></div>
      <div class="field"><label>视频切换策略</label><select class="sel" id="ss-videoMode">
        <option value="timed" ${ss.videoMode !== 'ended' ? 'selected' : ''}>按停留时长切换</option>
        <option value="ended" ${ss.videoMode === 'ended' ? 'selected' : ''}>播放完自动切换</option></select></div>
      <div class="field"><label>视频声音</label><select class="sel" id="ss-mute">
        <option value="1" ${ss.mute !== false ? 'selected' : ''}>静音（推荐）</option>
        <option value="0" ${ss.mute === false ? 'selected' : ''}>开启声音</option></select></div>
      <div class="field"><label>画面暗化（0 ~ 0.7）</label><input class="inp" id="ss-dim" type="number" step="0.05" min="0" max="0.7" value="${ss.dim == null ? 0.15 : ss.dim}" /></div>
      <div class="field"><label>点击行为（图片 / 视频）</label><select class="sel" id="ss-tapAction">
        <option value="activity" ${ss.tapAction !== 'exit' ? 'selected' : ''}>进入关联活动页</option>
        <option value="exit" ${ss.tapAction === 'exit' ? 'selected' : ''}>退出待机页回首页</option></select></div>
      <div class="field"><label>互动页点击行为</label><select class="sel" id="ss-pageTap">
        <option value="activity" ${ss.pageTap !== 'interact' ? 'selected' : ''}>整页点击进活动（H5 不响应点击）</option>
        <option value="interact" ${ss.pageTap === 'interact' ? 'selected' : ''}>保留 H5 交互（给角标按钮进活动）</option></select></div>
    </div>
    <div class="chips" style="margin-top:14px">
      ${flags.map(([k, label, on]) => `<button data-ssflag="${k}" class="${on ? 'on' : ''}">${label}</button>`).join('')}
    </div>
    <div class="form-actions"><button class="btn primary" id="ss-save">保存播放参数</button></div>
    <div class="help">「触发时间」与「系统设置 → 待机页触发」同一数值；修改任一处都会同步。</div>
  </div>

  ${dangling.length ? `<div class="card" style="border-color:rgba(248,113,113,.5)">
    <h3 style="color:#f87171">⚠️ 存在失效的活动关联（${dangling.length} 条）</h3>
    <div class="help">以下素材关联的活动已被删除：点击时会提示「关联的活动已不存在」并返回首页。请重新指定关联活动，或改为「不关联」。<br>
      ${dangling.map((it) => `• ${esc(it.title || it.url)}　<span class="mono">promoId=${esc(it.promoId)}</span>`).join('<br>')}
    </div></div>` : ''}

  <div class="card"><h3>${ed ? (ed === 'new' ? '新增素材' : '编辑素材') : '节目单（' + items.length + ' 项，按列表顺序播放）'}</h3>
    ${ed ? ssItemForm(ed) : (items.length ? `<div class="table-wrap"><table>
      <thead><tr><th>#</th><th>类型</th><th>预览</th><th>标题 / 地址</th><th>关联活动</th><th>停留</th><th>状态</th><th>排序</th><th>操作</th></tr></thead>
      <tbody>${items.map((it, i) => `<tr>
        <td class="mono">${i + 1}</td>
        <td>${mediaPill({ type: it.type, url: it.url })}</td>
        <td>${ssThumb(it)}</td>
        <td><div>${esc(it.title || '—')}</div><div class="mono">${esc(it.url)}</div></td>
        <td>${promoLinkCell(it)}</td>
        <td class="mono">${it.duration}s</td>
        <td>${it.enabled !== false ? '✅ 启用' : '⛔ 停用'}</td>
        <td><button class="btn sm" data-ss-up="${esc(it.id)}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn sm" data-ss-down="${esc(it.id)}" ${i === items.length - 1 ? 'disabled' : ''}>↓</button></td>
        <td><button class="btn sm" data-ss-edit="${esc(it.id)}">编辑</button>
            <button class="btn sm danger" data-ss-del="${esc(it.id)}">删除</button></td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="help">还没有素材。点右上角「＋ 新增素材」上传图片 / 视频，或填写 HTML5 互动页链接。</div>')}
  </div>`;
}

function ssItemForm(it) {
  const nf = it === 'new';
  const o = nf ? { type: 'image', url: '', title: '', sub: '', duration: (D.settings.screensaver || {}).interval || 8, enabled: true } : it;
  return `<div class="form-grid">
    <div class="field"><label>素材类型</label><select class="sel" id="si-type">
      <option value="image" ${o.type === 'image' ? 'selected' : ''}>图片</option>
      <option value="video" ${o.type === 'video' ? 'selected' : ''}>视频</option>
      <option value="page" ${o.type === 'page' ? 'selected' : ''}>HTML5 互动页</option></select></div>
    <div class="field"><label>停留时长（秒）</label><input class="inp" id="si-duration" type="number" min="3" value="${o.duration}" /></div>
    <div class="field"><label>显示状态</label><select class="sel" id="si-enabled">
      <option value="1" ${o.enabled !== false ? 'selected' : ''}>启用</option>
      <option value="0" ${o.enabled === false ? 'selected' : ''}>停用</option></select></div>
    <div class="field"><label>关联活动（点击时跳转目标）</label><select class="sel" id="si-promo">
      <option value="" ${!o.promoId ? 'selected' : ''}>不关联</option>
      ${(D.promos || []).map((p) => `<option value="${esc(p.id)}" ${o.promoId === p.id ? 'selected' : ''}>${esc(p.title)}${p.active ? '' : '（已结束）'}</option>`).join('')}
    </select></div>
  </div>
  <div class="help">关联后：点击该待机素材将打开对应「活动详情页」；未关联或活动已被删除时，会提示并返回首页（异常兜底）。</div>
  <div class="form-grid" style="margin-top:12px">
    <div class="field"><label>标题（可选，叠加在画面上）</label><input class="inp" id="si-title" value="${esc(o.title || '')}" /></div>
    <div class="field"><label>副标题（可选）</label><input class="inp" id="si-sub" value="${esc(o.sub || '')}" /></div>
  </div>
  <div class="field" style="margin-top:12px"><label>素材地址 / 链接</label>
    <input class="inp" id="si-url" placeholder="上传后自动填入，或粘贴 https://…" value="${esc(o.url || '')}" /></div>
  <div class="inline" style="margin-top:10px">
    <input type="file" id="si-file" />
    <span class="help" id="si-tip" style="margin:0"></span>
  </div>
  <div class="me-preview" id="si-preview"></div>
  <div class="form-actions"><button class="btn primary" id="si-save">${nf ? '添加到节目单' : '保存修改'}</button>
    <button class="btn" id="si-cancel">取消</button></div>`;
}

function ssPreview() {
  const type = ($('#si-type') || {}).value || 'image';
  const url = ($('#si-url') || {}).value.trim();
  const file = $('#si-file'), tip = $('#si-tip'), box = $('#si-preview');
  if (type === 'image') { file.disabled = false; file.accept = 'image/png,image/jpeg,image/webp,image/svg+xml,image/gif'; tip.textContent = '图片：PNG / JPG / WEBP / SVG / GIF，≤4MB，建议 16:9（1920×1080）'; }
  else if (type === 'video') { file.disabled = false; file.accept = 'video/mp4,video/webm,video/ogg'; tip.textContent = '视频：MP4 / WEBM / OGG，≤40MB，建议 1080p、≤30s、静音'; }
  else { file.disabled = true; file.accept = ''; tip.textContent = 'HTML5 互动页：填写 https:// 链接或站内 .html 路径（需允许被 iframe 嵌入）'; }
  if (!url) { box.innerHTML = ''; return; }
  if (type === 'image') box.innerHTML = `<img src="${esc(url)}" alt="预览" />`;
  else if (type === 'video') box.innerHTML = `<video src="${esc(url)}" controls muted playsinline></video>`;
  else box.innerHTML = `<iframe src="${esc(url)}" loading="lazy"></iframe><div class="help">若上方空白：目标站点可能禁止被 iframe 嵌入（X-Frame-Options / CSP）。</div>`;
}

function wireScreen() {
  const add = $('#ss-add'); if (add) add.onclick = () => { editing.ssItem = 'new'; render(); };

  const save = $('#ss-save');
  if (save) save.onclick = async () => {
    const flag = (k) => $('[data-ssflag="' + k + '"]').classList.contains('on');
    const body = {
      enabled: $('#ss-enabled').value === '1',
      idleSeconds: Number($('#ss-idle').value),
      interval: Number($('#ss-interval').value),
      transition: $('#ss-transition').value,
      order: $('#ss-order').value,
      loop: $('#ss-loop').value === '1',
      videoMode: $('#ss-videoMode').value,
      mute: $('#ss-mute').value === '1',
      dim: Number($('#ss-dim').value),
      tapAction: $('#ss-tapAction').value,
      pageTap: $('#ss-pageTap').value,
      showClock: flag('showClock'), showMallName: flag('showMallName'),
      showHint: flag('showHint'), showProgress: flag('showProgress')
    };
    const r = await api('PUT', '/api/screensaver', body);
    r.ok ? (toast('播放参数已保存', 'ok'), refresh()) : toast(r.error || '保存失败', 'err');
  };
  $$('[data-ssflag]').forEach((b) => b.onclick = () => b.classList.toggle('on'));

  const mkMove = (dir) => async (id) => {
    const ids = (D.settings.screensaver.items || []).map((x) => x.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const r = await api('POST', '/api/screensaver/reorder', { ids });
    r.ok ? refresh() : toast(r.error || '排序失败', 'err');
  };
  $$('[data-ss-up]').forEach((b) => b.onclick = () => mkMove(-1)(b.dataset.ssUp));
  $$('[data-ss-down]').forEach((b) => b.onclick = () => mkMove(1)(b.dataset.ssDown));
  $$('[data-ss-edit]').forEach((b) => b.onclick = () => { editing.ssItem = (D.settings.screensaver.items || []).find((x) => x.id === b.dataset.ssEdit); render(); });
  $$('[data-ss-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('确认从节目单移除该素材？（不会删除已上传的文件）')) return;
    const r = await api('DELETE', '/api/screensaver/items/' + b.dataset.ssDel);
    r.ok ? (toast('已移除', 'ok'), refresh()) : toast(r.error || '删除失败', 'err');
  });

  if (!$('#si-type')) return;
  $('#si-type').onchange = ssPreview;
  $('#si-url').oninput = ssPreview;
  $('#si-file').onchange = async () => {
    const f = $('#si-file').files && $('#si-file').files[0];
    if (!f) return;
    try {
      toast('素材上传中…');
      const url = await uploadAsset(f, 'ss');
      $('#si-url').value = url;
      if (/^video\//.test(f.type)) $('#si-type').value = 'video';
      ssPreview();
      toast('素材已上传，记得保存', 'ok');
    } catch (e) { toast(e.message || '上传失败', 'err'); }
  };
  $('#si-save').onclick = async () => {
    const body = {
      type: $('#si-type').value, url: $('#si-url').value.trim(),
      title: $('#si-title').value.trim(), sub: $('#si-sub').value.trim(),
      duration: Number($('#si-duration').value), enabled: $('#si-enabled').value === '1',
      promoId: $('#si-promo').value
    };
    if (!body.url) return toast('请上传素材或填写链接', 'err');
    const isNew = editing.ssItem === 'new';
    const r = await api(isNew ? 'POST' : 'PUT', isNew ? '/api/screensaver/items' : '/api/screensaver/items/' + editing.ssItem.id, body);
    if (r.ok) { toast(isNew ? '已加入节目单' : '已保存', 'ok'); editing.ssItem = null; refresh(); } else toast(r.error || '保存失败', 'err');
  };
  $('#si-cancel').onclick = () => { editing.ssItem = null; render(); };
  ssPreview();
}

/* ---------------- 服务指南（卡片内容后台可配 + 占位符实时取数） ---------------- */
// 占用符语法：{{商场名}} {{地址}} {{营业时间}} {{服务电话}} {{楼层:设施类型}}
// 条目写法：每行一条；以「- 」开头渲染为圆点列表项，否则渲染为段落
const GP_ICONS = ['🅿️', '🛎️', '🚻', '🛗', '🏧', 'ℹ️', '🛍️', '🍽️', '🎬', '🚇', '♿', '👶', '🔋', '🧳', '🎁', '🗺️', '☎️', '🕙'];
const GP_VARS = ['{{商场名}}', '{{地址}}', '{{营业时间}}', '{{服务电话}}'];
// 服务指南卡片预设调色板（点击即可选用，亦可用系统取色器自定义）
const GUIDE_PALETTE = ['#4a7fe0', '#7b5cff', '#ef6c4d', '#3aa76d', '#f5a623', '#e8699a', '#37c2d6', '#f06292', '#26a69a', '#9c7b6b', '#78909c', '#b06ad6'];

// 卡片自定义颜色 → 行内样式（与前台 app.js 的 svcCardStyle 保持一致）
function gpCardStyle(c) {
  const col = (c && c.color) ? String(c.color).trim() : '';
  const img = (c && c.bgImage) ? String(c.bgImage).trim() : '';
  if (img) {
    const safe = img.replace(/['"()]/g, '');
    const scrim = 'linear-gradient(180deg, rgba(8,12,22,.42), rgba(8,12,22,.70))';
    let card = `background:${scrim}, url('${safe}') center / cover no-repeat;border-color:rgba(255,255,255,.18)`;
    if (col && c.colorMode !== 'bg') card += `;border-width:3px;border-left-width:6px;border-color:${col}`;
    return {
      card,
      icon: `background:rgba(255,255,255,.2);display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px`,
      cls: ' gp-bg'
    };
  }
  if (!col) return { card: '', icon: '', cls: '' };
  if (c.colorMode === 'bg') {
    return {
      card: `background:${col};border-color:${col}`,
      icon: `background:rgba(255,255,255,.22);display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px`,
      cls: ' gp-bg'
    };
  }
  return {
    card: `border-color:${col};border-width:3px;border-left-width:6px`,
    icon: `background:${col};color:#fff;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px`,
    cls: ''
  };
}
function isHexColor(s) { return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(s || '').trim()); }

// 占位符取值：楼层类按「中文标签」或「类型 key」查设施
function gpFloorList(typeRef) {
  const t = (facTypes || []).find((x) => x.key === typeRef || x.label === typeRef);
  const key = t ? t.key : typeRef;
  const list = (D.facilities || []).filter((f) => f.type === key);
  const names = [...new Set(list.map((f) => floorShort(f.floorId)))];
  return names.length ? names.join('、') : '—';
}
function gpFill(text) {
  const s = D.settings || {};
  const v = { '商场名': s.mallName || '', '地址': s.address || '', '营业时间': s.businessHours || '', '服务电话': s.servicePhone || '' };
  return String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, expr) => {
    const e = String(expr).trim();
    const fl = e.match(/^楼层\s*[:：]\s*(.+)$/);
    if (fl) return gpFloorList(fl[1].trim());
    if (Object.prototype.hasOwnProperty.call(v, e)) return v[e];
    return m; // 未知占位符原样保留，便于发现拼写错误
  });
}
// 把条目数组渲染成 HTML（连续列表项包进同一个 <ul>）
function gpBodyHtml(items) {
  const out = [];
  let lis = [];
  const flush = () => { if (lis.length) { out.push('<ul>' + lis.join('') + '</ul>'); lis = []; } };
  (items || []).forEach((line) => {
    const t = gpFill(line);
    const m = t.match(/^[-•*]\s+(.*)$/);
    if (m) {
      const txt = m[1].trim();
      if (txt) lis.push(`<li>${esc(txt)}</li>`); // 空列表项跳过，避免出现空圆点
      return;
    }
    const p = t.trim();
    if (p) { flush(); out.push(`<p>${esc(p)}</p>`); }
  });
  flush();
  return out.join('');
}
// 占位符拼错检查：返回文本中所有无法识别的 {{...}}
function gpBadTokens(text) {
  const s = D.settings || {};
  const v = { '商场名': s.mallName || '', '地址': s.address || '', '营业时间': s.businessHours || '', '服务电话': s.servicePhone || '' };
  const bad = [];
  String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, expr) => {
    const e = String(expr).trim();
    const ok = /^楼层\s*[:：]\s*.+$/.test(e) || Object.prototype.hasOwnProperty.call(v, e);
    if (!ok) bad.push(m);
    return m;
  });
  return bad;
}

function viewGuide() {
  const g = D.settings.guide || { cards: [] };
  const cards = g.cards || [];
  const ed = editing.guideCard;
  // 占位符体检：全库扫一遍，列出无效占位符
  const allText = cards.reduce((acc, c) => acc.concat(c.items || []), []);
  const badAll = [...new Set(allText.reduce((acc, t) => acc.concat(gpBadTokens(t)), []))];
  return `
  <div class="page-head"><div><h1>服务指南</h1><div class="sub">前台「服务指南」页的卡片内容，支持占位符自动读取楼层 / 商场信息</div></div>
    <div class="inline">
      <a class="btn" href="/?go=service" target="_blank" rel="noopener">👁 预览服务指南</a>
      <button class="btn" id="gd-reset">↺ 恢复默认</button>
      <button class="btn primary" id="gd-add">＋ 新增卡片</button>
    </div></div>

  <div class="card"><h3>页面参数</h3>
    <div class="form-grid">
      <div class="field"><label>启用服务指南</label><select class="sel" id="gd-enabled">
        <option value="1" ${g.enabled !== false ? 'selected' : ''}>启用</option>
        <option value="0" ${g.enabled === false ? 'selected' : ''}>关闭</option></select></div>
      <div class="field"><label>页面标题</label><input class="inp" id="gd-title" value="${esc(g.title || '服务指南')}" maxlength="20" /></div>
      <div class="field"><label>页面副标题</label><input class="inp" id="gd-sub" value="${esc(g.sub || '')}" /></div>
    </div>
    <div class="form-actions"><button class="btn primary" id="gd-save">保存页面参数</button></div>
  </div>

  ${badAll.length ? `<div class="card" style="border-color:rgba(248,113,113,.5)">
    <h3 style="color:#f87171">⚠️ 存在无法识别的占位符（${badAll.length} 个）</h3>
    <div class="help">以下写法不被支持，前台会原样显示这段文字，请检查拼写：<br>
      ${badAll.map((t) => `<span class="pill" style="border-color:rgba(248,113,113,.6);color:#f87171">${esc(t)}</span>`).join(' ')}
    </div></div>` : ''}

  <div class="card"><h3>${ed ? (ed === 'new' ? '新增卡片' : '编辑卡片：' + esc(ed.title)) : '卡片列表（' + cards.length + ' 张，按列表顺序展示）'}</h3>
    ${ed ? guideCardForm(ed) : (cards.length ? `<div class="table-wrap"><table>
      <thead><tr><th>#</th><th>图标</th><th>标题</th><th>条目</th><th>前台预览</th><th>状态</th><th>排序</th><th>操作</th></tr></thead>
      <tbody>${cards.map((c, i) => `<tr>
        <td class="mono">${i + 1}</td>
        <td style="font-size:20px">${esc(c.icon || 'ℹ️')}</td>
        <td>${esc(c.title)}</td>
        <td class="mono">${(c.items || []).length} 条</td>
        <td><div class="gp-preview"><div class="gp-card${gpCardStyle(c).cls}"${gpCardStyle(c).card ? ` style="${gpCardStyle(c).card}"` : ''}><h3><span${gpCardStyle(c).icon ? ` style="${gpCardStyle(c).icon}"` : ''}>${esc(c.icon || 'ℹ️')}</span>${esc(c.title)}</h3>${gpBodyHtml(c.items)}</div></div></td>
        <td>${c.enabled !== false ? '✅ 启用' : '⛔ 停用'}</td>
        <td><button class="btn sm" data-gd-up="${esc(c.id)}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn sm" data-gd-down="${esc(c.id)}" ${i === cards.length - 1 ? 'disabled' : ''}>↓</button></td>
        <td><button class="btn sm" data-gd-edit="${esc(c.id)}">编辑</button>
            <button class="btn sm danger" data-gd-del="${esc(c.id)}">删除</button></td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="help">还没有卡片。点右上角「＋ 新增卡片」，或「↺ 恢复默认」载入内置 6 张卡片。</div>')}
  </div>

  <div class="card"><h3>占位符速查（写在条目里，前台自动替换）</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>占位符</th><th>说明</th><th>当前取值</th></tr></thead>
      <tbody>
        ${GP_VARS.map((v) => `<tr><td class="mono">${esc(v)}</td><td>${esc({ '{{商场名}}': '商场名称', '{{地址}}': '商场地址', '{{营业时间}}': '营业时间', '{{服务电话}}': '服务电话' }[v])}（取自「系统设置」）</td><td>${esc(gpFill(v))}</td></tr>`).join('')}
        ${(facTypes || []).map((t) => `<tr><td class="mono">{{楼层:${esc(t.label)}}}</td><td>列出「${esc(t.label)}」设施所在楼层（可用类型名 <span class="mono">${esc(t.key)}</span>）</td><td>${esc(gpFloorList(t.key))}</td></tr>`).join('')}
      </tbody>
    </table></div>
    <div class="help">楼层类占位符按设施数据实时汇总；若该类型暂无设施，显示 <span class="mono">—</span>。</div>
  </div>`;
}

function guideCardForm(c) {
  const nf = c === 'new';
  const o = nf ? { icon: 'ℹ️', title: '', items: [], enabled: true } : c;
  const colorMode = o.colorMode === 'bg' ? 'bg' : 'border';
  const colorVal = isHexColor(o.color) ? o.color : '#4a7fe0';
  return `
  <div class="form-grid">
    <div class="field"><label>卡片图标（emoji）</label><input class="inp" id="gc-icon" value="${esc(o.icon || 'ℹ️')}" maxlength="8" /></div>
    <div class="field"><label>卡片标题</label><input class="inp" id="gc-title" value="${esc(o.title || '')}" maxlength="20" /></div>
    <div class="field"><label>显示状态</label><select class="sel" id="gc-enabled">
      <option value="1" ${o.enabled !== false ? 'selected' : ''}>启用</option>
      <option value="0" ${o.enabled === false ? 'selected' : ''}>停用</option></select></div>
  </div>
  <div class="inline" style="margin-top:10px;gap:6px">
    <span class="help" style="margin:0">快速选图标：</span>
    ${GP_ICONS.map((i) => `<button class="btn sm" data-gc-icon="${esc(i)}" style="font-size:15px">${i}</button>`).join('')}
  </div>

  <div class="card" style="margin-top:16px">
    <h4 style="margin:0 0 10px">🎨 卡片颜色</h4>
    <div class="field"><label>应用方式</label>
      <select class="sel" id="gc-colormode">
        <option value="border" ${colorMode !== 'bg' ? 'selected' : ''}>边框 / 左侧色条 + 图标底色</option>
        <option value="bg" ${colorMode === 'bg' ? 'selected' : ''}>整卡背景（自动白字）</option>
      </select></div>
    <div class="field"><label>颜色（点预设或自定义取色）</label>
      <div class="gc-colorbar">
        <input type="color" id="gc-color" class="gc-colorinput" value="${esc(colorVal)}" />
        <input type="hidden" id="gc-color-val" value="${esc(o.color || '')}" />
        <div class="gc-palette">
          ${GUIDE_PALETTE.map((c) => `<button type="button" class="gc-swatch${o.color === c ? ' on' : ''}" data-gc-color="${c}" title="${c}" style="background:${c}"></button>`).join('')}
        </div>
        <button type="button" class="btn sm" id="gc-color-clear">清除颜色</button>
      </div>
      <div class="help" style="margin-top:8px">不指定颜色时卡片跟随主题默认外观。下方「前台效果预览」会随选择实时更新。</div>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <h4 style="margin:0 0 10px">🖼️ 卡片背景图片</h4>
    <div class="field"><label>上传背景图（自动铺满卡片、居中裁剪、不变形）</label>
      <div class="gc-bgimg-bar">
        <input type="file" id="gc-bgimage-file" accept="image/*" class="inp" />
        <input type="hidden" id="gc-bgimage-val" value="${esc(o.bgImage || '')}" />
        <button type="button" class="btn sm" id="gc-bgimage-clear">清除图片</button>
      </div>
      <div id="gc-bgimage-thumb" class="gc-bgimg-thumb"${o.bgImage ? ` style="background-image:url('${esc(o.bgImage)}')"` : ''}></div>
      <div class="help" style="margin-top:8px">图片以 <span class="mono">cover</span> 方式填充整张卡片并自动居中裁剪多余部分，不同屏幕宽度下自适应不变形；文字上方叠加暗色蒙版以保证清晰可读。建议尺寸比例接近卡片（约 3:2）以获得最佳观感。</div>
    </div>
  </div>

  <div class="field" style="margin-top:14px"><label>卡片条目（每行一条，最多 20 条）</label>
    <textarea id="gc-items" rows="7" placeholder="地下停车场位于 {{楼层:停车场}}。&#10;- 扫码支付：出口处张贴缴费二维码">${esc((o.items || []).join('\n'))}</textarea></div>
  <div class="inline" style="margin-top:8px;gap:6px">
    <span class="help" style="margin:0">插入占位符：</span>
    ${GP_VARS.map((v) => `<button class="btn sm" data-gc-ins="${esc(v)}">${esc(v)}</button>`).join('')}
    <button class="btn sm" data-gc-ins="{{楼层:洗手间}}">{{楼层:洗手间}}</button>
  </div>
  <div class="help">以 <span class="mono">- </span> 开头的行渲染为圆点列表项，其余行渲染为段落。占位符会在前台按实时数据替换（见下方「占位符速查」）。</div>
  <div class="gp-preview" id="gc-preview" style="margin-top:14px"></div>
  <div class="form-actions"><button class="btn primary" id="gc-save">${nf ? '创建卡片' : '保存修改'}</button>
    <button class="btn" id="gc-cancel">取消</button></div>`;
}

// 编辑卡片时：右侧实时预览 + 无效占位符告警
function gcPreview() {
  const box = $('#gc-preview');
  if (!box) return;
  const icon = ($('#gc-icon') || {}).value || 'ℹ️';
  const title = ($('#gc-title') || {}).value || '未命名';
  const raw = ($('#gc-items') || {}).value || '';
  const color = (($('#gc-color-val') || {}).value || '').trim();
  const colorMode = (($('#gc-colormode') || {}).value || 'border') === 'bg' ? 'bg' : 'border';
  const bgImage = (($('#gc-bgimage-val') || {}).value || '').trim();
  const st = gpCardStyle({ color, colorMode, bgImage });
  const items = raw.split('\n').map((x) => x.trim()).filter(Boolean);
  const bad = [...new Set(items.reduce((acc, t) => acc.concat(gpBadTokens(t)), []))];
  box.innerHTML = `<div class="help" style="margin-bottom:8px">前台效果预览</div>
    <div class="gp-card gp-solo${st.cls}"${st.card ? ` style="${st.card}"` : ''}><h3><span${st.icon ? ` style="${st.icon}"` : ''}>${esc(icon)}</span>${esc(title)}</h3>${gpBodyHtml(items) || '<p style="color:var(--muted)">（暂无条目）</p>'}</div>
    ${bad.length ? `<div class="help" style="color:#f87171;margin-top:8px">⚠️ 无法识别的占位符：${bad.map((t) => esc(t)).join('、')}</div>` : ''}`;
}

function wireGuide() {
  const add = $('#gd-add'); if (add) add.onclick = () => { editing.guideCard = 'new'; render(); };

  const save = $('#gd-save');
  if (save) save.onclick = async () => {
    const r = await api('PUT', '/api/guide', {
      enabled: $('#gd-enabled').value === '1',
      title: $('#gd-title').value.trim(),
      sub: $('#gd-sub').value.trim()
    });
    r.ok ? (toast('页面参数已保存', 'ok'), refresh()) : toast(r.error || '保存失败', 'err');
  };

  const reset = $('#gd-reset');
  if (reset) reset.onclick = async () => {
    if (!confirm('确认恢复为内置的 6 张默认卡片？当前卡片配置将被覆盖（不影响其它数据）。')) return;
    const r = await api('POST', '/api/guide/reset', {});
    r.ok ? (toast('已恢复默认卡片', 'ok'), editing.guideCard = null, refresh()) : toast(r.error || '恢复失败', 'err');
  };

  const mkMove = (dir) => async (id) => {
    const ids = (D.settings.guide.cards || []).map((x) => x.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const r = await api('POST', '/api/guide/cards/reorder', { ids });
    r.ok ? refresh() : toast(r.error || '排序失败', 'err');
  };
  $$('[data-gd-up]').forEach((b) => b.onclick = () => mkMove(-1)(b.dataset.gdUp));
  $$('[data-gd-down]').forEach((b) => b.onclick = () => mkMove(1)(b.dataset.gdDown));
  $$('[data-gd-edit]').forEach((b) => b.onclick = () => { editing.guideCard = (D.settings.guide.cards || []).find((x) => x.id === b.dataset.gdEdit); render(); });
  $$('[data-gd-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('确认删除该卡片？前台将不再显示它。')) return;
    const r = await api('DELETE', '/api/guide/cards/' + b.dataset.gdDel);
    r.ok ? (toast('已删除', 'ok'), refresh()) : toast(r.error || '删除失败', 'err');
  });

  if (!$('#gc-title')) return;
  $$('[data-gc-icon]').forEach((b) => b.onclick = () => { $('#gc-icon').value = b.dataset.gcIcon; gcPreview(); });
  $$('[data-gc-ins]').forEach((b) => b.onclick = () => {
    const ta = $('#gc-items');
    ta.value = (ta.value ? ta.value.replace(/\s*$/, '') + '\n' : '') + b.dataset.gcIns;
    ta.focus();
    gcPreview();
  });
  // 卡片颜色：预设色板 + 系统取色器 + 清除
  const refreshSwatch = () => {
    const v = ($('#gc-color-val') || {}).value || '';
    $$('.gc-swatch').forEach((sw) => sw.classList.toggle('on', sw.dataset.gcColor === v));
  };
  $$('.gc-swatch').forEach((b) => b.onclick = () => {
    const col = b.dataset.gcColor;
    const ci = $('#gc-color'); if (ci) ci.value = col;
    const cv = $('#gc-color-val'); if (cv) cv.value = col;
    refreshSwatch(); gcPreview();
  });
  const colorInput = $('#gc-color');
  if (colorInput) colorInput.oninput = () => { const cv = $('#gc-color-val'); if (cv) cv.value = colorInput.value; refreshSwatch(); gcPreview(); };
  const colorClear = $('#gc-color-clear');
  if (colorClear) colorClear.onclick = () => { const cv = $('#gc-color-val'); if (cv) cv.value = ''; refreshSwatch(); gcPreview(); };
  const colorModeSel = $('#gc-colormode');
  if (colorModeSel) colorModeSel.onchange = gcPreview;
  // 卡片背景图片：上传 + 清除
  const bgFile = $('#gc-bgimage-file');
  if (bgFile) bgFile.onchange = async () => {
    const f = bgFile.files && bgFile.files[0];
    if (!f) return;
    try {
      const url = await uploadAsset(f, 'guide');
      const v = $('#gc-bgimage-val'); if (v) v.value = url;
      const th = $('#gc-bgimage-thumb'); if (th) th.style.backgroundImage = `url('${url}')`;
      toast('背景图已上传', 'ok'); gcPreview();
    } catch (e) { toast(e.message || '上传失败', 'err'); }
  };
  const bgClear = $('#gc-bgimage-clear');
  if (bgClear) bgClear.onclick = () => {
    const v = $('#gc-bgimage-val'); if (v) v.value = '';
    const th = $('#gc-bgimage-thumb'); if (th) th.removeAttribute('style');
    if (bgFile) bgFile.value = '';
    gcPreview();
  };
  $('#gc-icon').oninput = gcPreview;
  $('#gc-title').oninput = gcPreview;
  $('#gc-items').oninput = gcPreview;
  $('#gc-save').onclick = async () => {
    const items = $('#gc-items').value.split('\n').map((x) => x.trim()).filter(Boolean);
    const color = ($('#gc-color-val') || {}).value || '';
    const colorMode = ($('#gc-colormode') || {}).value === 'bg' ? 'bg' : 'border';
    const bgImage = ($('#gc-bgimage-val') || {}).value || '';
    const body = { icon: $('#gc-icon').value.trim(), title: $('#gc-title').value.trim(), items, enabled: $('#gc-enabled').value === '1', color, colorMode, bgImage };
    if (!body.title) return toast('请填写卡片标题', 'err');
    if (!items.length) return toast('请至少填写一条内容', 'err');
    const isNew = editing.guideCard === 'new';
    const r = await api(isNew ? 'POST' : 'PUT', isNew ? '/api/guide/cards' : '/api/guide/cards/' + editing.guideCard.id, body);
    if (r.ok) { toast(isNew ? '卡片已创建' : '已保存', 'ok'); editing.guideCard = null; refresh(); } else toast(r.error || '保存失败', 'err');
  };
  $('#gc-cancel').onclick = () => { editing.guideCard = null; render(); };
  refreshSwatch();
  gcPreview();
}

/* ---------------- 多屏管理（内容分发） ---------------- */
const SCREEN_TAB_LABEL = { home: '首页', floor: '楼层导购(地图)', brand: '品牌导购', promo: '优惠活动', service: '服务指南' };
const SCREEN_MOD_LABEL = { floor: '楼层导购', brand: '品牌导购', promo: '优惠活动', service: '服务指南', guide: '路线导航' };

function viewScreens() {
  const ed = editing.screenId;
  const list = D.screens || [];
  return `
  <div class="page-head"><div><h1>多屏管理</h1><div class="sub">每台物理屏按「屏幕标识」加载专属界面 · 保存或「立即下发」后屏端 15 秒内自动切换，无需人工刷新</div></div>
    <button class="btn primary" id="scr-add">＋ 新增屏幕</button></div>

  <div class="card"><h3>位置标识与下发方式</h3>
    <div class="help">
      • <b>URL 参数</b>：把屏端浏览器首页设为 <span class="mono">http://服务器:4000/?screen=屏幕标识</span>（如 <span class="mono">?screen=F1-LOBBY</span>）。<br>
      • <b>本地标识文件</b>：无法统一改首页的一体机，将 <span class="mono">public/screen-id.example.json</span> 复制为该机上的 <span class="mono">public/screen-id.json</span>，写入 <span class="mono">{"id":"屏幕标识"}</span>。<br>
      • 屏端首次解析后用 localStorage 记忆，断网重连自动恢复；<b>未登记的屏幕自动回落默认界面</b>（全模块开放、从首页进入）。<br>
      • 内容分配：全馆共享楼层 / 店铺 / 活动 / 指南基础数据，每屏仅覆盖展示参数（默认页签、聚焦楼层、模块开关、主题色、本地点位公告）→ 远程更新统一生效。
    </div>
  </div>

  <div class="card"><h3>${ed ? (ed === 'new' ? '新增屏幕' : '编辑屏幕：' + esc(((D.screens || []).find((x) => x.id === ed) || {}).name || ed)) : '屏幕列表（' + list.length + ' 台）'}</h3>
    ${ed ? screenForm(ed) : (list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>屏幕标识</th><th>名称</th><th>位置</th><th>默认页签</th><th>聚焦楼层</th><th>模块</th><th>状态</th><th>版本</th><th>操作</th></tr></thead>
      <tbody>${list.map((s) => `<tr>
        <td class="mono">${esc(s.id)}</td>
        <td>${esc(s.name)}</td>
        <td>${esc(s.location || '—')}</td>
        <td>${esc(SCREEN_TAB_LABEL[s.defaultTab] || s.defaultTab)}</td>
        <td class="mono">${esc(s.focusFloorId || '首层(自动)')}</td>
        <td class="mono">${Object.keys(SCREEN_MOD_LABEL).filter((k) => s.modules && s.modules[k] !== false).map((k) => esc(SCREEN_MOD_LABEL[k])).join('、')}</td>
        <td>${s.enabled !== false ? '✅ 启用' : '⛔ 停用'}</td>
        <td class="mono">r${s.rev}</td>
        <td><button class="btn sm" data-scr-edit="${esc(s.id)}">编辑</button>
            <button class="btn sm" data-scr-push="${esc(s.id)}">立即下发</button>
            <button class="btn sm danger" data-scr-del="${esc(s.id)}">删除</button></td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="help">还没有登记屏幕。点右上角「＋ 新增屏幕」创建第一台屏的专属配置。</div>')}
  </div>

  <div class="card"><h3>屏幕标识预览链接</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>屏幕</th><th>打开专属界面</th></tr></thead>
      <tbody>${list.map((s) => `<tr><td>${esc(s.name)}（<span class="mono">${esc(s.id)}</span>）</td>
        <td><a class="mono" href="/?screen=${encodeURIComponent(s.id)}" target="_blank">/?screen=${esc(s.id)}</a></td></tr>`).join('')}</tbody>
    </table></div>
    <div class="help">点击链接即模拟该屏加载：验证「默认页签 / 聚焦楼层 / 模块 / 公告 / 主题色」是否按配置生效。</div>
  </div>`;
}

function screenForm(id) {
  const nf = id === 'new';
  const o = nf ? { id: '', name: '', location: '', enabled: true, defaultTab: 'home', focusFloorId: '', modules: {}, accent: '', notice: '' } : (D.screens.find((x) => x.id === id) || {});
  return `
  <div class="form-grid">
    <div class="field"><label>屏幕标识（唯一，字母/数字/-/.，写入屏端 URL 或 screen-id.json）</label><input id="sc-id" value="${esc(o.id || '')}" ${nf ? '' : 'disabled'} placeholder="如 F1-LOBBY" /></div>
    <div class="field"><label>屏幕名称</label><input id="sc-name" value="${esc(o.name || '')}" placeholder="如 一层中庭导视屏" /></div>
    <div class="field"><label>物理位置</label><input id="sc-location" value="${esc(o.location || '')}" placeholder="如 一层中庭东侧" /></div>
    <div class="field"><label>状态</label><select class="sel" id="sc-enabled">
      <option value="1" ${o.enabled !== false ? 'selected' : ''}>启用</option>
      <option value="0" ${o.enabled === false ? 'selected' : ''}>停用（该屏回落默认界面）</option></select></div>
    <div class="field"><label>启动后默认页签</label><select class="sel" id="sc-tab">
      ${Object.keys(SCREEN_TAB_LABEL).map((k) => `<option value="${k}" ${o.defaultTab === k ? 'selected' : ''}>${SCREEN_TAB_LABEL[k]}</option>`).join('')}</select></div>
    <div class="field"><label>聚焦楼层（地图默认楼层）</label><select class="sel" id="sc-floor">
      <option value="">首层（自动）</option>
      ${D.floors.map((f) => `<option value="${esc(f.id)}" ${o.focusFloorId === f.id ? 'selected' : ''}>${esc(f.name)}（${esc(f.id)}）</option>`).join('')}</select></div>
  </div>
  <div class="field" style="margin-top:12px"><label>启用模块（未勾选的模块在该屏的导航与首页入口中隐藏）</label>
    <div class="chips">${Object.keys(SCREEN_MOD_LABEL).map((k) => `<label class="scr-mod"><input type="checkbox" data-scr-mod="${k}" ${(o.modules ? o.modules[k] !== false : true) ? 'checked' : ''}/> ${SCREEN_MOD_LABEL[k]}</label>`).join('')}</div></div>
  <div class="form-grid" style="margin-top:12px">
    <div class="field"><label>主题色（可选，覆盖该屏强调色）</label>
      <div class="gc-colorbar">
        <input type="color" id="sc-accent" value="${/^#[0-9a-fA-F]{6}$/.test(o.accent || '') ? o.accent : '#4d8dff'}" />
        <input type="hidden" id="sc-accent-val" value="${esc(o.accent || '')}" />
        <button type="button" class="btn sm" id="sc-accent-clear">清除（跟随全局）</button>
      </div></div>
  </div>
  <div class="field" style="margin-top:12px"><label>本地点位公告（显示在顶部，留空则不显示）</label>
    <textarea id="sc-notice" rows="2" placeholder="如：您当前位于一层中庭，最近的洗手间在东侧扶梯旁">${esc(o.notice || '')}</textarea></div>
  <div class="form-actions">
    <button class="btn primary" id="sc-save">${nf ? '创建屏幕' : '保存并下发'}</button>
    <button class="btn" id="sc-cancel">取消</button>
  </div>`;
}

function wireScreens() {
  const add = $('#scr-add'); if (add) add.onclick = () => { editing.screenId = 'new'; render(); };
  $$('[data-scr-edit]').forEach((b) => b.onclick = () => { editing.screenId = b.dataset.scrEdit; render(); });
  $$('[data-scr-push]').forEach((b) => b.onclick = async () => {
    const r = await api('POST', '/api/screens/' + b.dataset.scrPush + '/push', {});
    r.ok ? (toast('已下发，屏端 15 秒内自动切换', 'ok'), refresh()) : toast(r.error || '下发失败', 'err');
  });
  $$('[data-scr-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('确认删除该屏幕配置？该屏将回落到默认界面。')) return;
    const r = await api('DELETE', '/api/screens/' + b.dataset.scrDel);
    r.ok ? (toast('已删除', 'ok'), refresh()) : toast(r.error || '删除失败', 'err');
  });
  if (!$('#sc-save')) return;
  const ci = $('#sc-accent'), cv = $('#sc-accent-val');
  if (ci) ci.oninput = () => { if (cv) cv.value = ci.value; };
  const clr = $('#sc-accent-clear');
  if (clr) clr.onclick = () => { if (cv) cv.value = ''; };
  $('#sc-save').onclick = async () => {
    const modules = {};
    $$('[data-scr-mod]').forEach((c) => { modules[c.dataset.scrMod] = c.checked; });
    const body = {
      name: $('#sc-name').value.trim(),
      location: $('#sc-location').value.trim(),
      enabled: $('#sc-enabled').value === '1',
      defaultTab: $('#sc-tab').value,
      focusFloorId: $('#sc-floor').value,
      modules,
      accent: ($('#sc-accent-val') || {}).value || '',
      notice: $('#sc-notice').value.trim()
    };
    if (editing.screenId === 'new') {
      const id = ($('#sc-id').value || '').trim();
      if (!id) return toast('请填写屏幕标识', 'err');
      body.id = id;
      const r = await api('POST', '/api/screens', body);
      if (r.ok) { toast('屏幕已创建', 'ok'); editing.screenId = null; refresh(); } else toast(r.error || '创建失败', 'err');
    } else {
      const r = await api('PUT', '/api/screens/' + editing.screenId, body);
      if (r.ok) { toast('已保存并下发', 'ok'); editing.screenId = null; refresh(); } else toast(r.error || '保存失败', 'err');
    }
  };
  $('#sc-cancel').onclick = () => { editing.screenId = null; render(); };
}

/* ---------------- 平面编辑（拖拽定位） ---------------- */
function viewMap() {
  const f = D.floors.find((x) => x.id === editorFloor) || D.floors[0] || {};
  const sel = D.shops.find((s) => s.id === selShopId);
  const p = f.plan || {};
  const ir = p.imageRect || { x: 0, y: 0, w: 1000, h: 700 };
  const show = p.showImage !== false;
  const op = (p.imageOpacity == null ? 1 : p.imageOpacity);
  const hasImg = p.mode === 'image' && !!p.image;
  return `
  <div class="page-head"><div><h1>平面编辑</h1><div class="sub">底图图层 + 店铺定位：二者共用同一坐标系，对齐即所见即所得</div></div>
    <div class="inline">
      <div class="chips">
        <button data-mode="shop" class="${editorMode === 'shop' ? 'on' : ''}">✋ 拖拽店铺</button>
        <button data-mode="base" class="${editorMode === 'base' ? 'on' : ''}">🗺️ 拖拽底图</button>
      </div>
      <select id="ed-floor" class="sel">
        ${D.floors.map((x) => `<option value="${esc(x.id)}" ${x.id === f.id ? 'selected' : ''}>${esc(x.name)}（${esc(x.short || x.id)}）</option>`).join('')}
      </select>
      <button class="btn" id="ed-reset">重置视图</button>
    </div></div>
  <div class="editor-wrap">
    <div class="editor-map" id="edWrap"></div>
    <div class="editor-side">
      <div class="card"><h3>底图图层 ${hasImg ? '' : '<span class="pill">未上传</span>'}</h3>
        <div class="inline" style="margin-bottom:12px">
          <label class="help" style="margin:0">显示底图</label>
          <input type="checkbox" id="ed-show" ${show ? 'checked' : ''} />
          <span class="help" style="margin:0">透明度</span>
          <input type="range" id="ed-op" min="0" max="1" step="0.05" value="${op}" style="flex:1;min-width:90px" />
          <span class="mono" id="ed-opv">${op}</span>
        </div>
        <div class="form-grid" style="grid-template-columns:1fr 1fr">
          <div class="field"><label>X</label><input id="ed-ix" type="number" value="${ir.x}" /></div>
          <div class="field"><label>Y</label><input id="ed-iy" type="number" value="${ir.y}" /></div>
          <div class="field"><label>宽度</label><input id="ed-iw" type="number" value="${ir.w}" /></div>
          <div class="field"><label>高度</label><input id="ed-ih" type="number" value="${ir.h}" /></div>
        </div>
        <div class="form-actions" style="flex-wrap:wrap">
          <button class="btn primary" id="ed-savebase">保存底图参数</button>
          <button class="btn" id="ed-fit">铺满画布</button>
        </div>
        <div class="field" style="margin-top:12px"><label>上传底图（PNG / JPG / SVG，≤8MB）</label>
          <input type="file" id="ed-file" accept="image/png,image/jpeg,image/webp,image/svg+xml" /></div>
        <div class="help">上传真实 CAD 导出的图片后，切到「✋ 拖拽店铺 / 🗺️ 拖拽底图」对应模式做对齐：先用底图模式把底图铺到位，再用店铺模式把色块拖到真实铺位上。</div>
      </div>
      <div class="card"><h3>选中店铺</h3>
        ${sel ? `<div class="field"><label>名称</label><input value="${esc(sel.name)}" readonly /></div>
        <div class="form-grid" style="grid-template-columns:1fr 1fr;margin-top:10px">
          <div class="field"><label>X</label><input id="ed-x" type="number" value="${sel.x}" /></div>
          <div class="field"><label>Y</label><input id="ed-y" type="number" value="${sel.y}" /></div>
          <div class="field"><label>宽</label><input id="ed-w" type="number" value="${sel.w}" /></div>
          <div class="field"><label>高</label><input id="ed-h" type="number" value="${sel.h}" /></div>
        </div>
        <div class="form-actions"><button class="btn primary" id="ed-save">保存坐标</button></div>`
        : '<div class="help">在平面图中点击任意店铺方块以选中，可拖拽移动或精确输入坐标。</div>'}
      </div>
      <div class="card"><h3>图例</h3><div class="help">
        🔵 店铺方块（可拖拽）<br>🟢 公共设施（只读）<br>⚪ 导航节点<br>虚线 路网连线　灰线 墙体
      </div></div>
    </div>
  </div>`;
}
function drawEditor() {
  const wrap = $('#edWrap'); if (!wrap) return;
  const f = D.floors.find((x) => x.id === editorFloor) || D.floors[0];
  if (!f) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = '';
  const svg = $svg('svg', { viewBox: '0 0 1000 700', preserveAspectRatio: 'xMidYMid meet' });
  // 底图图层（最底层）：与业务图层同坐标系，按 imageRect 精确铺放
  const p = f.plan || {};
  if (p.mode === 'image' && p.image && p.showImage !== false) {
    const r = p.imageRect || { x: 0, y: 0, w: 1000, h: 700 };
    const img = $svg('image', { x: r.x, y: r.y, width: r.w, height: r.h, preserveAspectRatio: 'none', opacity: (p.imageOpacity == null ? 1 : p.imageOpacity), 'data-base': '1' });
    img.setAttribute('href', p.image);
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', p.image);
    svg.appendChild(img);
  }
  if (editorMode === 'base') svg.addEventListener('pointerdown', (e) => startBaseDrag(e, svg, f));
  // 墙体
  ((f.plan || {}).walls || []).forEach((w) => svg.appendChild($svg('line', { x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, stroke: 'rgba(150,170,210,.45)', 'stroke-width': w.w || 5, 'stroke-linecap': 'round' })));
  // 店铺
  D.shops.filter((s) => s.floorId === f.id).forEach((s) => {
    const r = $svg('rect', { x: s.x, y: s.y, width: s.w, height: s.h, rx: 8, fill: s.color || '#4d8dff', 'fill-opacity': .85, stroke: s.id === selShopId ? '#ffd166' : 'rgba(255,255,255,.25)', 'stroke-width': s.id === selShopId ? 3 : 1.4, class: 'e-shop-rect', 'data-id': s.id });
    r.addEventListener('pointerdown', (e) => startDrag(e, svg, s, r, wrap));
    r.addEventListener('click', () => { selShopId = s.id; render(); });
    svg.appendChild(r);
    const t = $svg('text', { x: s.x + s.w / 2, y: s.y + s.h / 2 + 5, fill: '#fff', 'font-size': Math.min(15, Math.max(10, s.w / 10)), 'text-anchor': 'middle', 'pointer-events': 'none' });
    t.textContent = s.name;
    svg.appendChild(t);
  });
  // 设施
  D.facilities.filter((x) => x.floorId === f.id).forEach((x) => {
    svg.appendChild($svg('circle', { cx: x.x, cy: x.y, r: 12, fill: facMeta(x.type).color + 'cc', stroke: '#0b1120', 'stroke-width': 2, class: 'e-fac' }));
  });
  // 节点
  D.graph.nodes.filter((n) => n.floorId === f.id).forEach((n) => {
    svg.appendChild($svg('circle', { cx: n.x, cy: n.y, r: 4.5, class: 'e-node', 'pointer-events': 'none' }));
  });
  // 连线
  D.graph.edges.forEach((e) => {
    const a = D.graph.nodes.find((n) => n.id === e.from), b = D.graph.nodes.find((n) => n.id === e.to);
    if (!a || !b || a.floorId !== f.id || b.floorId !== f.id) return;
    svg.appendChild($svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: 'rgba(140,165,210,.3)', 'stroke-width': 1.2, 'stroke-dasharray': '4 6', 'pointer-events': 'none' }));
  });
  wrap.appendChild(svg);
}
function startDrag(ev, svg, shop, rect, wrap) {
  if (editorMode === 'base') return; // 底图模式下由 svg 级拖拽接管
  ev.stopPropagation();
  const pt = (e) => { const m = svg.getScreenCTM().inverse(); const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(m); };
  const start = pt(ev);
  const ox = shop.x, oy = shop.y;
  let moved = false;
  const move = (e) => {
    const p = pt(e);
    const nx = Math.round(ox + (p.x - start.x)), ny = Math.round(oy + (p.y - start.y));
    if (Math.abs(p.x - start.x) > 1 || Math.abs(p.y - start.y) > 1) moved = true;
    rect.setAttribute('x', nx); rect.setAttribute('y', ny);
    shop.x = nx; shop.y = ny;
  };
  const up = async () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (moved) {
      const r = await api('PUT', '/api/shops/' + shop.id, { x: shop.x, y: shop.y });
      if (r.ok) toast(`已保存「${shop.name}」坐标 (${shop.x}, ${shop.y})`, 'ok'); else toast(r.error || '保存失败', 'err');
      if (selShopId === shop.id) { loadAll().then(() => { drawEditor(); const x = $('#ed-x'); if (x) { x.value = shop.x; $('#ed-y').value = shop.y; } }); }
    }
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

/* 拖拽底图：在「拖拽底图」模式下按住画布移动整张底图，松开自动保存 */
function startBaseDrag(ev, svg, floor) {
  const p = floor.plan || {};
  if (p.mode !== 'image' || !p.image) return;
  const rectEl = svg.querySelector('image[data-base]');
  if (!rectEl) return;
  const r = Object.assign({ x: 0, y: 0, w: 1000, h: 700 }, p.imageRect || {});
  const pt = (e) => { const m = svg.getScreenCTM().inverse(); const q = svg.createSVGPoint(); q.x = e.clientX; q.y = e.clientY; return q.matrixTransform(m); };
  const s = pt(ev);
  const ox = r.x, oy = r.y;
  let moved = false;
  const move = (e) => {
    const q = pt(e);
    r.x = Math.round(ox + (q.x - s.x)); r.y = Math.round(oy + (q.y - s.y));
    moved = true;
    rectEl.setAttribute('x', r.x); rectEl.setAttribute('y', r.y);
  };
  const up = async () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (!moved) return;
    p.imageRect = r;
    const res = await api('PUT', '/api/floors/' + floor.id + '/plan', { imageRect: r });
    if (res.ok) toast(`底图位置已保存 (${r.x}, ${r.y})`, 'ok'); else toast(res.error || '保存失败', 'err');
    const ix = $('#ed-ix');
    if (ix) { ix.value = r.x; $('#ed-iy').value = r.y; }
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function wireMap() {
  const sel = $('#ed-floor');
  if (sel) sel.onchange = () => { editorFloor = sel.value; selShopId = null; render(); };
  const reset = $('#ed-reset'); if (reset) reset.onclick = () => render();
  $$('[data-mode]').forEach((b) => b.onclick = () => { editorMode = b.dataset.mode; render(); });

  const floorId = (D.floors.find((x) => x.id === editorFloor) || D.floors[0] || {}).id;
  const saveBase = async (body) => {
    const r = await api('PUT', '/api/floors/' + floorId + '/plan', body);
    if (r.ok) { toast('底图参数已保存', 'ok'); await loadAll(); render(); } else toast(r.error || '保存失败', 'err');
  };

  const showEl = $('#ed-show');
  if (showEl) showEl.onchange = () => saveBase({ showImage: showEl.checked });

  const opEl = $('#ed-op');
  if (opEl) {
    opEl.oninput = () => { const v = $('#ed-opv'); if (v) v.textContent = opEl.value; };
    opEl.onchange = () => saveBase({ imageOpacity: Number(opEl.value) });
  }

  const sb = $('#ed-savebase');
  if (sb) sb.onclick = () => saveBase({
    imageRect: { x: Number($('#ed-ix').value), y: Number($('#ed-iy').value), w: Number($('#ed-iw').value), h: Number($('#ed-ih').value) }
  });

  const fit = $('#ed-fit');
  if (fit) fit.onclick = () => saveBase({ imageRect: { x: 0, y: 0, w: 1000, h: 700 } });

  const file = $('#ed-file');
  if (file) file.onchange = () => {
    const f = file.files && file.files[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) return toast('图片需小于 8MB', 'err');
    const fr = new FileReader();
    fr.onload = async () => {
      const r = await api('POST', '/api/upload/plan', { floorId, dataUrl: fr.result });
      if (r.ok) { toast('底图已上传，可继续微调对齐', 'ok'); await loadAll(); render(); }
      else toast(r.error || '上传失败', 'err');
    };
    fr.readAsDataURL(f);
  };

  const save = $('#ed-save');
  if (save) save.onclick = async () => {
    const s = D.shops.find((x) => x.id === selShopId); if (!s) return;
    const r = await api('PUT', '/api/shops/' + s.id, { x: Number($('#ed-x').value), y: Number($('#ed-y').value), w: Number($('#ed-w').value), h: Number($('#ed-h').value) });
    if (r.ok) { toast('坐标已保存', 'ok'); refresh(); } else toast(r.error || '保存失败', 'err');
  };
  drawEditor();
}

/* ---------------- 节点与连线 ---------------- */
function viewGraph() {
  const nodes = D.graph.nodes, edges = D.graph.edges;
  return `
  <div class="page-head"><div><h1>节点与连线（路网）</h1><div class="sub">路线规划依赖此路网：节点=可通行点，连线=通道。跨层连线类型应为 floor</div></div>
    <div class="inline"><button class="btn" id="g-conn">诊断连通性</button>
      <button class="btn primary" id="g-auto">⚡ 一键生成路网连线</button></div></div>
  <div id="g-connBox"></div>
  <div class="card"><h3>起点设置</h3>
    <div class="inline">
      <select id="g-start" class="sel" style="min-width:320px">
        ${nodes.map((n) => `<option value="${esc(n.id)}" ${n.id === D.settings.startNode ? 'selected' : ''}>${esc(n.name)}（${esc(floorShort(n.floorId))} · ${esc(n.id)}）</option>`).join('')}
      </select>
      <button class="btn primary" id="g-saveStart">保存起点</button>
      <span class="mono">当前起点：${esc(D.settings.startName || '—')}</span>
    </div>
    <div class="help">导视屏所在位置即「起点」，前台规划路线时从该点出发。</div>
  </div>
  <div class="card"><h3>新增连线</h3>
    <div class="inline">
      <select id="e-from" class="sel" style="min-width:260px">
        ${nodes.map((n) => `<option value="${esc(n.id)}">${esc(n.name)}（${esc(n.id)}）</option>`).join('')}</select>
      <span>→</span>
      <select id="e-to" class="sel" style="min-width:260px">
        ${nodes.map((n) => `<option value="${esc(n.id)}">${esc(n.name)}（${esc(n.id)}）</option>`).join('')}</select>
      <select id="e-type" class="sel">
        <option value="walk">同层通道</option><option value="floor">跨层（电梯/扶梯）</option></select>
      <button class="btn primary" id="e-add">添加连线</button>
    </div>
  </div>
  <div class="card"><h3>节点（${nodes.length}）</h3>
    <div class="table-wrap"><table><thead><tr><th>ID</th><th>名称</th><th>楼层</th><th>坐标</th><th>关联</th><th>操作</th></tr></thead>
      <tbody>${nodes.map((n) => `<tr><td class="mono">${esc(n.id)}</td><td>${esc(n.name)}</td><td>${esc(floorShort(n.floorId))}</td>
        <td class="mono">${n.x}, ${n.y}</td><td class="mono">${esc(n.shopName || n.facilityName || '—')}</td>
        <td><button class="btn sm danger" data-del-node="${esc(n.id)}">删除</button></td></tr>`).join('')}</tbody></table></div>
  </div>
  <div class="card"><h3>连线（${edges.length}）</h3>
    <div class="table-wrap"><table><thead><tr><th>ID</th><th>起点</th><th>终点</th><th>类型</th><th>长度</th><th>操作</th></tr></thead>
      <tbody>${edges.map((e) => { const a = nodes.find((n) => n.id === e.from), b = nodes.find((n) => n.id === e.to); return `<tr>
        <td class="mono">${esc(e.id)}</td><td>${esc(a ? a.name : e.from)}</td><td>${esc(b ? b.name : e.to)}</td>
        <td><span class="pill">${e.type === 'floor' ? '跨层' : '同层'}</span></td><td class="mono">${e.weight || '—'}</td>
        <td><button class="btn sm danger" data-del-edge="${esc(e.id)}">删除</button></td></tr>`; }).join('')}</tbody></table></div>
  </div>`;
}
function wireGraph() {
  const conn = $('#g-conn');
  if (conn) conn.onclick = async () => {
    const r = await api('GET', '/api/graph/connectivity');
    if (!r.ok) return toast(r.error || '失败', 'err');
    const d = r.data;
    $('#g-connBox').innerHTML = `<div class="card"><h3>连通性诊断</h3><div class="help">
      节点总数 <b>${d.nodes}</b>　连线总数 <b>${d.edges}</b>　连通分量 <b>${d.components}</b>　孤立节点 <b>${d.isolated.length}</b><br>
      ${d.components > 1 ? '⚠️ 存在多个连通分量，部分地点之间无法规划路线，请补充连线。' : '✅ 全图连通，任意两地之间均可规划路线。'}
      ${d.isolated.length ? '<br>孤立节点：' + d.isolated.slice(0, 20).map(esc).join('、') + (d.isolated.length > 20 ? ' …' : '') : ''}
    </div></div>`;
  };
  const auto = $('#g-auto');
  if (auto) auto.onclick = async () => {
    if (!confirm('将按坐标邻近关系自动补齐连线（只新增，不删除已有连线）。确定继续？')) return;
    const r = await api('POST', '/api/graph/autoconnect', { maxDist: 320, k: 2, crossFloor: true });
    if (r.ok) { toast(`已新增 ${r.data.added} 条连线`, 'ok'); refresh(); } else toast(r.error || '失败', 'err');
  };
  const ss = $('#g-saveStart');
  if (ss) ss.onclick = async () => {
    const r = await api('PUT', '/api/settings', { startNode: $('#g-start').value });
    r.ok ? (toast('起点已保存', 'ok'), refresh()) : toast(r.error || '失败', 'err');
  };
  const add = $('#e-add');
  if (add) add.onclick = async () => {
    const from = $('#e-from').value, to = $('#e-to').value, type = $('#e-type').value;
    if (from === to) return toast('起点与终点不能相同', 'err');
    const r = await api('POST', '/api/edges', { from, to, type });
    r.ok ? (toast('连线已添加', 'ok'), refresh()) : toast(r.error || '失败', 'err');
  };
  $$('[data-del-node]').forEach((b) => b.onclick = async () => {
    if (!confirm('确认删除该节点？其相关连线将一并删除，可能影响路线规划。')) return;
    const r = await api('DELETE', '/api/nodes/' + b.dataset.delNode);
    r.ok ? (toast('已删除', 'ok'), refresh()) : toast(r.error || '失败', 'err');
  });
  $$('[data-del-edge]').forEach((b) => b.onclick = async () => {
    const r = await api('DELETE', '/api/edges/' + b.dataset.delEdge);
    r.ok ? (toast('已删除', 'ok'), refresh()) : toast(r.error || '失败', 'err');
  });
}

/* ---------------- 商场管理（平台） ---------------- */
function viewMalls() {
  return `
  <div class="page-head"><div><h1>商场管理</h1><div class="sub">多商场租户 · 各商场数据完全隔离（楼层/店铺/活动/屏幕/路网）</div></div>
    <button class="btn primary" id="ml-add">＋ 新增商场</button></div>
  <div class="card"><h3>商场列表（${malls.length}）· 当前操作：${esc((malls.find((x) => x.id === curMall) || {}).name || curMall || '—')}</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>名称</th><th>状态</th><th>楼层</th><th>店铺</th><th>设施</th><th>活动</th><th>屏幕</th><th>节点</th><th>操作</th></tr></thead>
      <tbody>${malls.map((mm) => `<tr>
        <td class="mono">${esc(mm.id)}</td><td>${esc(mm.name)}</td>
        <td>${mm.status === 'active' ? '✅ 启用' : '⛔ 停用'}</td>
        <td class="mono">${mm.counts.floors}</td><td class="mono">${mm.counts.shops}</td><td class="mono">${mm.counts.facilities}</td>
        <td class="mono">${mm.counts.promos}</td><td class="mono">${mm.counts.screens}</td><td class="mono">${mm.counts.nodes}</td>
        <td><button class="btn sm" data-ml-switch="${esc(mm.id)}" ${mm.status === 'disabled' ? 'disabled' : ''}>进入管理</button>
            <button class="btn sm" data-ml-toggle="${esc(mm.id)}">${mm.status === 'active' ? '停用' : '启用'}</button>
            <button class="btn sm danger" data-ml-del="${esc(mm.id)}">删除</button></td></tr>`).join('')}</tbody>
    </table></div>
    <div class="help">「进入管理」把左侧所有模块切换到该商场的数据；商场账号登录后只能看到并操作自己所属商场。也可用顶部下拉快速切换。前台对应入口：<span class="mono">/?mall=商场ID</span>。</div>
  </div>`;
}
function wireMalls() {
  const add = $('#ml-add'); if (add) add.onclick = async () => {
    const name = prompt('新商场名称（如：星悦广场）：');
    if (!name || !name.trim()) return;
    const r = await api('POST', '/api/malls', { name: name.trim() });
    r.ok ? (toast('商场已创建', 'ok'), refresh()) : toast(r.error || '创建失败', 'err');
  };
  $$('[data-ml-switch]').forEach((b) => b.onclick = () => switchMall(b.dataset.mlSwitch));
  $$('[data-ml-toggle]').forEach((b) => b.onclick = async () => {
    const mm = malls.find((x) => x.id === b.dataset.mlToggle);
    const to = mm.status === 'active' ? 'disabled' : 'active';
    const r = await api('PUT', '/api/malls/' + mm.id, { status: to });
    r.ok ? (toast(to === 'active' ? '已启用' : '已停用', 'ok'), refresh()) : toast(r.error || '失败', 'err');
  });
  $$('[data-ml-del]').forEach((b) => b.onclick = async () => {
    const mm = malls.find((x) => x.id === b.dataset.mlDel);
    if (!confirm(`⚠️ 将永久删除商场「${mm.name}」及其全部楼层/店铺/活动/屏幕/路网数据与账号，不可恢复！确认删除？`)) return;
    const r = await api('DELETE', '/api/malls/' + b.dataset.mlDel);
    r.ok ? (toast('已删除', 'ok'), refresh()) : toast(r.error || '删除失败', 'err');
  });
}

/* ---------------- 用户与权限 ---------------- */
const MALL_PERMS = ['floors', 'shops', 'facilities', 'promos', 'banners', 'standby', 'guide', 'screens', 'map', 'graph', 'settings'];
const PERM_LABEL = { floors: '楼层', shops: '店铺', facilities: '设施', promos: '活动', banners: 'Banner', standby: '待机页', guide: '服务指南', screens: '多屏', map: '平面', graph: '路网', settings: '设置' };
function permsText(perms) { return (!perms || !perms.length) ? '全部模块' : (perms.map((p) => PERM_LABEL[p] || p).join('、')); }
function viewUsers() {
  const isPlatform = me && me.role === 'platform';
  const mallName = (id) => (malls.find((x) => x.id === id) || {}).name || id || '—';
  return `
  <div class="page-head"><div><h1>用户与权限</h1><div class="sub">${isPlatform ? '平台账号可跨商场；商场账号只能访问所属商场的数据与功能' : '为本商场创建与管理员工账号'}</div></div></div>
  <div class="card"><h3>新建账号</h3>
    <div class="form-grid">
      <div class="field"><label>用户名（2-30 位字母/数字/._-）</label><input id="us-name" placeholder="如 mall2-manager" /></div>
      <div class="field"><label>初始密码（≥6 位）</label><input id="us-pass" type="password" placeholder="密码" /></div>
      ${isPlatform ? `<div class="field"><label>角色</label><select class="sel" id="us-role">
        <option value="mall">商场账号</option><option value="platform">平台账号</option></select></div>
      <div class="field"><label>所属商场（商场账号必选）</label><select class="sel" id="us-mall">
        <option value="">— 选择商场 —</option>${malls.map((mm) => `<option value="${esc(mm.id)}">${esc(mm.name)}</option>`).join('')}</select></div>` : ''}
    </div>
    <div class="field" style="margin-top:10px"><label>模块权限（商场账号；不勾选 = 全部模块）</label>
      <div class="chips">${MALL_PERMS.map((p) => `<label class="scr-mod"><input type="checkbox" data-us-perm="${p}"/> ${PERM_LABEL[p]}</label>`).join('')}</div></div>
    <div class="form-actions"><button class="btn primary" id="us-add">创建账号</button></div>
  </div>
  <div class="card"><h3>账号列表（${users.length}）</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>用户名</th><th>角色</th><th>所属商场</th><th>模块权限</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead>
      <tbody>${users.map((u) => `<tr>
        <td class="mono">${esc(u.username)}</td>
        <td>${u.role === 'platform' ? '🛡️ 平台' : '🏬 商场'}</td>
        <td>${u.role === 'platform' ? '—' : esc(mallName(u.mallId))}</td>
        <td class="mono">${u.role === 'platform' ? '—' : permsText(u.perms)}</td>
        <td>${u.enabled !== false ? '✅ 启用' : '⛔ 停用'}</td>
        <td class="mono">${esc((u.lastLoginAt || '').replace('T', ' ').slice(0, 16) || '—')}</td>
        <td><button class="btn sm" data-us-pass="${esc(u.id)}">重置密码</button>
            ${isPlatform || u.mallId === (me || {}).mallId ? `<button class="btn sm" data-us-perms="${esc(u.id)}" ${u.role === 'platform' ? 'disabled' : ''}>权限</button>
            <button class="btn sm" data-us-toggle="${esc(u.id)}" ${u.id === (me || {}).id ? 'disabled' : ''}>${u.enabled !== false ? '停用' : '启用'}</button>
            <button class="btn sm danger" data-us-del="${esc(u.id)}" ${u.id === (me || {}).id ? 'disabled' : ''}>删除</button>` : ''}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="help">商场账号登录后台后，左侧仅出现被授权的模块，且所有接口都被强制限定在本商场数据范围内（服务端隔离，前端隐藏仅为体验）。</div>
  </div>`;
}
function wireUsers() {
  const add = $('#us-add'); if (add) add.onclick = async () => {
    const username = $('#us-name').value.trim(), password = $('#us-pass').value;
    const perms = $$('[data-us-perm]').filter((c) => c.checked).map((c) => c.dataset.usPerm);
    const body = { username, password, perms };
    if (me && me.role === 'platform') {
      body.role = $('#us-role').value;
      body.mallId = $('#us-mall').value;
      if (body.role === 'mall' && !body.mallId) return toast('请选择所属商场', 'err');
    }
    const r = await api('POST', '/api/users', body);
    r.ok ? (toast('账号已创建', 'ok'), refresh()) : toast(r.error || '创建失败', 'err');
  };
  $$('[data-us-pass]').forEach((b) => b.onclick = async () => {
    const np = prompt('为该账号设置新密码（≥6 位）：');
    if (!np) return;
    const r = await api('PUT', '/api/users/' + b.dataset.usPass, { newPassword: np });
    r.ok ? toast('密码已重置', 'ok') : toast(r.error || '失败', 'err');
  });
  $$('[data-us-perms]').forEach((b) => b.onclick = async () => {
    const u = users.find((x) => x.id === b.dataset.usPerms);
    const cur = (u.perms || []).join(',');
    const val = prompt('输入允许的模块（逗号分隔，留空 = 全部）：\n' + MALL_PERMS.join(', '), cur);
    if (val === null) return;
    const perms = val.split(',').map((x) => x.trim()).filter((x) => MALL_PERMS.includes(x));
    const r = await api('PUT', '/api/users/' + u.id, { perms });
    r.ok ? (toast('权限已更新', 'ok'), refresh()) : toast(r.error || '失败', 'err');
  });
  $$('[data-us-toggle]').forEach((b) => b.onclick = async () => {
    const u = users.find((x) => x.id === b.dataset.usToggle);
    const r = await api('PUT', '/api/users/' + u.id, { enabled: u.enabled === false });
    r.ok ? (toast(u.enabled === false ? '已启用' : '已停用', 'ok'), refresh()) : toast(r.error || '失败', 'err');
  });
  $$('[data-us-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('确认删除该账号？')) return;
    const r = await api('DELETE', '/api/users/' + b.dataset.usDel);
    r.ok ? (toast('已删除', 'ok'), refresh()) : toast(r.error || '删除失败', 'err');
  });
}

/* ---------------- 系统设置 ---------------- */
function viewSettings() {
  const s = D.settings;
  return `
  <div class="page-head"><div><h1>系统设置</h1><div class="sub">商场信息与显示参数（作用于当前商场：${esc(s.mallName || '')}）</div></div></div>
  <div class="card"><h3>商场信息</h3>
    <div class="form-grid">
      <div class="field"><label>商场名称</label><input id="st-name" value="${esc(s.mallName || '')}" /></div>
      <div class="field"><label>宣传语</label><input id="st-slogan" value="${esc(s.slogan || '')}" /></div>
      <div class="field"><label>地址</label><input id="st-addr" value="${esc(s.address || '')}" /></div>
      <div class="field"><label>服务电话</label><input id="st-phone" value="${esc(s.servicePhone || '')}" /></div>
      <div class="field"><label>营业时间</label><input id="st-hours" value="${esc(s.businessHours || '')}" /></div>
      <div class="field"><label>像素/米（平面比例尺）</label><input class="inp" id="st-scale" type="number" value="${s.scalePxPerM || 10}" /></div>
      <div class="field"><label>待机页触发（秒无操作）</label><input class="inp" id="st-ss" type="number" value="${s.screensaverSeconds || 45}" /></div>
    </div>
    <div class="form-actions"><button class="btn primary" id="st-save">保存设置</button></div>
    <div class="help">待机页的<b>内容与轮播参数</b>请在左侧「🖥️ 待机页配置」中维护；账号与密码安全请前往「👥 用户与权限」。</div>
  </div>`;
}
function wireSettings() {
  const save = $('#st-save');
  if (save) save.onclick = async () => {
    const body = {
      mallName: $('#st-name').value.trim(), slogan: $('#st-slogan').value.trim(), address: $('#st-addr').value.trim(),
      servicePhone: $('#st-phone').value.trim(), businessHours: $('#st-hours').value.trim(),
      scalePxPerM: Number($('#st-scale').value), screensaverSeconds: Number($('#st-ss').value)
    };
    const r = await api('PUT', '/api/settings', body);
    r.ok ? (toast('设置已保存', 'ok'), refresh()) : toast(r.error || '保存失败', 'err');
  };
}

/* ---------------- 事件绑定分发 ---------------- */
function wire() {
  if (tab === 'malls') wireMalls();
  else if (tab === 'users') wireUsers();
  else if (tab === 'floors') wireFloors();
  else if (tab === 'shops') wireShops();
  else if (tab === 'facilities') wireFacilities();
  else if (tab === 'promos') wirePromos();
  else if (tab === 'banners') wireBanners();
  else if (tab === 'screen') wireScreen();
  else if (tab === 'guide') wireGuide();
  else if (tab === 'screens') wireScreens();
  else if (tab === 'map') wireMap();
  else if (tab === 'graph') wireGraph();
  else if (tab === 'settings') wireSettings();
}

/* ---------------- 启动 ---------------- */
async function boot() {
  try { await loadAll(); } catch (e) { toast(e.message || '数据加载失败', 'err'); return; }
  showApp(); render();
}
if (token) {
  (async () => {
    try {
      // 新会话 token 优先
      const r = await fetch('/api/auth/me', { headers: { 'x-auth-token': token } });
      const j = await r.json().catch(() => null);
      if (j && j.ok) { me = j.user; curMall = me.role === 'mall' ? me.mallId : curMall; await boot(); return; }
      // 旧平台密码 token 兼容（升级前保存的 adminPass）
      const r2 = await fetch('/api/settings', { headers: { 'x-admin-token': token } });
      const j2 = await r2.json().catch(() => null);
      if (j2 && j2.ok) { me = { username: 'admin', role: 'platform', perms: [] }; await boot(); return; }
      showLogin();
    } catch (e) { showLogin(); }
  })();
} else showLogin();

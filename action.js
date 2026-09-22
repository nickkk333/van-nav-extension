/*!
 * VanNav 管理扩展 - action.js
 *
 * 重构要点：
 *  1. 统一请求封装：超时 + HTTP 状态校验 + 错误透出
 *  2. Toast 通知替代 alert，加载态防重复提交
 *  3. 修复原代码中 formDefault1 为空导致的“添加工具”崩溃
 *  4. 分类缓存改存 chrome.storage.local（规避 sync 8KB 单项上限）
 *  5. 首次使用自动引导进入设置页
 *  6. 添加工具支持排序 sort（-1 添加到最后，0 或留空添加到最前）
 *  7. 描述 desc 改为读取网页 meta description（读取失败时回退为页面标题）
 */
'use strict';

/* ============================ DOM 引用 ============================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const els = {
  pages: $$('.page'),
  mainPage: $('#mainPage'),
  confirmPage: $('#confirmPage'),
  settingPage: $('#settingPage'),
  currentTabInfo: $('#currentTabInfo'),

  addForm: $('#addForm'),
  settingForm: $('#settingForm'),

  btnRefresh: $('#refreshCatalog'),
  btnAddTool: $('#addTool'),
  btnOpenAdmin: $('#openAdmin'),
  btnOpenWebsite: $('#openWebsite'),
  btnOpenSetting: $('#openSetting'),
  btnOpenWindow: $('#openWindow'),
  btnCancelAdd: $('#cancelAdd'),
  btnCancelSetting: $('#cancelSetting'),
  btnTestConn: $('#testConn'),
  btnFetchCatalog: $('#fetchCatelog'),
  btnToggleToken: $('#toggleToken'),

  formCatalog: $('#catelog'),
  formName: $('#name'),
  formUrl: $('#url'),
  formLogo: $('#logo'),
  formDesc: $('#desc'),
  formSort: $('#sort'),
  formHide1: $('#hide1'),
  formDefault1: $('#default1'),

  settingBaseUrl: $('#baseUrl'),
  settingToken: $('#token'),

  toast: $('#toast'),
  toastContent: $('#toastContent'),
};

/* ============================ 状态 ============================ */
const state = {
  baseUrl: '',
  token: '',
  catalog: [],
  lastCatalog: '',
  currentTab: null,
  fetching: false,
};

/* ============================ 通用工具 ============================ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HTML 转义，防止页面标题/URL 注入
const escapeHtml = (str) =>
  String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 为无协议的网址自动补全 https://
const normalizeUrl = (raw) => {
  const url = String(raw || '').trim();
  if (!url) return '';
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? url : `https://${url}`;
};

const isWebUrl = (raw) => /^https?:\/\/.+/i.test(String(raw || ''));

// 排序默认值：-1 表示添加到分类最后
const DEFAULT_SORT = -1;

// 解析排序输入：非法值或留空按 0 处理（0 表示添加到最前）
const resolveSort = (raw) => {
  const num = Number.parseInt(String(raw || '').trim(), 10);
  return Number.isFinite(num) ? num : 0;
};

/* ============================ 存储封装 ============================ */
function getSync(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(keys, (res) => {
      const err = chrome.runtime.lastError;
      err ? reject(new Error(err.message)) : resolve(res || {});
    });
  });
}

function setSync(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(values, () => {
      const err = chrome.runtime.lastError;
      err ? reject(new Error(err.message)) : resolve();
    });
  });
}

function getLocal(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (res) => {
      const err = chrome.runtime.lastError;
      err ? reject(new Error(err.message)) : resolve(res || {});
    });
  });
}

function setLocal(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const err = chrome.runtime.lastError;
      err ? reject(new Error(err.message)) : resolve();
    });
  });
}

/* ============================ 请求封装 ============================ */
async function api(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(state.baseUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: state.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    // 兼容返回体不是 JSON 的情况
    const json = await res.json().catch(() => null);

    if (!res.ok) {
      const msg = json && (json.msg || json.message);
      throw new Error(msg || `请求失败（HTTP ${res.status}）`);
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时，请检查网络或站点地址');
    if (err.name === 'TypeError') throw new Error('网络错误，请检查站点地址或网络');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ============================ Toast 通知 ============================ */
let toastTimer = null;
function showToast(message, type = 'info', duration = 2600) {
  els.toast.className = `toast ${type} show`;
  els.toastContent.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), duration);
}

/* ============================ 加载态 ============================ */
function setLoading(on) {
  document.body.classList.toggle('loading', !!on);
  $$('button').forEach((btn) => {
    btn.disabled = !!on;
  });
}

/* ============================ 页面导航 ============================ */
function showPage(page) {
  els.pages.forEach((p) => p.classList.toggle('active', p === page));
}

/* ============================ 分类管理 ============================ */
function renderCatalog() {
  const select = els.formCatalog;
  const current = select.value || state.lastCatalog || '';
  select.innerHTML = '';

  if (!state.catalog.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '暂无分类，请先获取';
    select.appendChild(opt);
    select.disabled = true;
    return;
  }

  state.catalog.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });

  select.disabled = false;
  if (state.catalog.includes(current)) {
    select.value = current;
  } else if (state.lastCatalog && state.catalog.includes(state.lastCatalog)) {
    select.value = state.lastCatalog;
  }
}

async function loadCatalog(force = false) {
  if (state.fetching) return; // 防连点
  if (!state.baseUrl || !state.token) {
    showToast('请先完成设置', 'error');
    setTimeout(handleOpenSetting, 600);
    return;
  }
  if (!force && state.catalog.length) {
    renderCatalog();
    return;
  }

  state.fetching = true;
  setLoading(true);
  try {
    const json = await api('/api/admin/all');
    const catelogs = (json && json.data && json.data.catelogs) || [];
    const names = catelogs.map((i) => i && i.name).filter(Boolean);

    if (names.length) {
      state.catalog = names;
      await setLocal({ options: names });
      renderCatalog();
      showToast(`已获取 ${names.length} 个分类`, 'success', 1800);
    } else {
      showToast('后台暂无分类数据', 'error');
    }
  } catch (err) {
    showToast(err.message || '获取分类失败', 'error', 4000);
  } finally {
    state.fetching = false;
    setLoading(false);
  }
}

/* ============================ 页面动作 ============================ */
function requireConfig() {
  if (state.baseUrl && state.token) return true;
  showToast('请先在设置中配置 baseUrl 与 Token', 'error');
  setTimeout(handleOpenSetting, 600);
  return false;
}

// 当前正在进行的“网页描述读取”任务，提交前需确保其完成
let descTask = null;

// 读取当前页面 meta description（优先 name=description，其次 og/twitter）
// 无法注入或页面未提供描述时返回空串，由调用方决定兜底策略
async function readPageDescription(tabId) {
  if (!tabId || !chrome.scripting || !chrome.scripting.executeScript) return '';
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const metas = [...document.querySelectorAll('meta')];
        const readMeta = (attr, value) => {
          const hit = metas.find((m) => (m.getAttribute(attr) || '').toLowerCase() === value);
          const content = hit && hit.getAttribute('content');
          return content ? String(content).replace(/\s+/g, ' ').trim() : '';
        };
        return readMeta('name', 'description') ||
          readMeta('property', 'og:description') ||
          readMeta('name', 'twitter:description') ||
          '';
      },
    });
    return (result && result.result) || '';
  } catch (_) {
    return ''; // 特殊页面（内置页 / 无权限）静默降级
  }
}

// 异步用网页描述覆盖表单描述；用户已手动改动时不覆盖
async function fillDescFromPage(tab) {
  const fallback = els.formDesc.value;
  const desc = await readPageDescription(tab.id);
  if (!desc) return;
  if (els.formDesc.value !== fallback) return;
  els.formDesc.value = desc;
}

function handleAddTool() {
  if (!requireConfig()) return;

  if (!state.catalog.length) {
    showToast('暂无分类，正在获取…', 'info');
    loadCatalog(true);
    return;
  }

  const tab = state.currentTab;
  if (!tab || !isWebUrl(tab.url)) {
    showToast('当前页面不是普通网页，无法自动填充', 'error');
    return;
  }

  // 用当前标签页预填表单
  els.formCatalog.value = state.lastCatalog && state.catalog.includes(state.lastCatalog)
    ? state.lastCatalog
    : state.catalog[0];
  els.formName.value = tab.title || '';
  els.formDesc.value = tab.title || ''; // 先用标题兜底，随后替换为网页 description
  els.formUrl.value = tab.url || '';
  els.formLogo.value = tab.favIconUrl || '';
  els.formSort.value = String(DEFAULT_SORT);
  els.formHide1.checked = false;
  els.formDefault1.checked = true;

  showPage(els.confirmPage);
  els.formName.focus();

  // 异步读取网页 description，填充得更准（不阻塞页面展示）
  descTask = fillDescFromPage(tab);
}

async function handleConfirmAdd() {
  // 若描述仍在读取中，先等它完成，避免提交到标题兜底值
  if (descTask) {
    try { await descTask; } catch (_) {}
    descTask = null;
  }

  const payload = {
    catelog: els.formCatalog.value,
    name: els.formName.value.trim(),
    url: normalizeUrl(els.formUrl.value),
    desc: els.formDesc.value.trim(),
    logo: els.formLogo.value.trim(),
    sort: resolveSort(els.formSort.value),
    hide: els.formHide1.checked,
    default: els.formDefault1.checked,
  };

  // 必填校验（图标除外）
  const missing = ['catelog', 'name', 'url', 'desc'].filter((k) => !payload[k]);
  if (missing.length) {
    showToast('除图标外均为必填项', 'error');
    return;
  }
  if (!isWebUrl(payload.url)) {
    showToast('网址格式不正确，需以 http(s):// 开头', 'error');
    return;
  }

  setLoading(true);
  try {
    const res = await api('/api/admin/tool', { method: 'POST', body: payload });
    if (res && res.success) {
      state.lastCatalog = payload.catelog;
      setSync({ lastOption: payload.catelog }).catch(() => {});
      showToast('站点添加成功 🎉', 'success', 1800);
      await sleep(800);
      window.close();
    } else {
      setLoading(false);
      showToast((res && (res.msg || res.message)) || '添加失败，请稍后重试', 'error', 4000);
    }
  } catch (err) {
    setLoading(false);
    showToast(err.message || '添加失败', 'error', 4000);
  }
}

function handleOpenSetting() {
  els.settingBaseUrl.value = state.baseUrl;
  els.settingToken.value = state.token;
  showPage(els.settingPage);
}

// 将设置表单中的输入临时同步到 state（供“测试连接 / 获取分类”使用）
function applySettingsInputs() {
  const baseUrl = els.settingBaseUrl.value.trim().replace(/\/+$/, '');
  const token = els.settingToken.value.trim();
  if (baseUrl) state.baseUrl = baseUrl;
  if (token) state.token = token;
}

async function handleSaveSetting() {
  const baseUrl = els.settingBaseUrl.value.trim().replace(/\/+$/, '');
  const token = els.settingToken.value.trim();

  if (!isWebUrl(baseUrl)) {
    showToast('站点地址需以 http(s):// 开头', 'error');
    return;
  }
  if (!token) {
    showToast('Token 不能为空', 'error');
    return;
  }

  setLoading(true);
  try {
    await setSync({ baseUrl, token });
    state.baseUrl = baseUrl;
    state.token = token;
    showToast('设置已保存', 'success', 1500);
    showPage(els.mainPage);
  } catch (err) {
    showToast('保存失败：' + err.message, 'error');
  } finally {
    setLoading(false);
  }
  // 拉取最新分类（失败不影响设置保存）
  loadCatalog(true);
}

async function handleTestConn() {
  const baseUrl = els.settingBaseUrl.value.trim().replace(/\/+$/, '');
  const token = els.settingToken.value.trim();
  if (!baseUrl || !token) {
    showToast('请先填写 baseUrl 与 Token', 'error');
    return;
  }

  const prev = { baseUrl: state.baseUrl, token: state.token };
  state.baseUrl = baseUrl;
  state.token = token;

  setLoading(true);
  try {
    await api('/api/admin/all');
    showToast('连接正常 ✓', 'success', 1800);
  } catch (err) {
    showToast('连接失败：' + err.message, 'error', 4000);
  } finally {
    state.baseUrl = prev.baseUrl;
    state.token = prev.token;
    setLoading(false);
  }
}

// 打开标签页；若当前窗口已存在相同站点则直接切换过去
async function findOrOpenTab(urlToOpen, matchUrl) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const hit = tabs.find((t) => t.url && t.url.indexOf(matchUrl) !== -1);
  if (hit) {
    await chrome.tabs.update(hit.id, { active: true });
  } else {
    await chrome.tabs.create({ url: urlToOpen });
  }
  window.close();
}

async function handleOpenAdmin() {
  if (!requireConfig()) return;
  try {
    await findOrOpenTab(state.baseUrl + '/admin', state.baseUrl + '/admin');
  } catch (err) {
    showToast(err.message || '打开后台失败', 'error');
  }
}

async function handleOpenWebsite() {
  if (!requireConfig()) return;
  try {
    await findOrOpenTab(state.baseUrl, state.baseUrl);
  } catch (err) {
    showToast(err.message || '打开前台失败', 'error');
  }
}

function handleOpenWindow() {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
}

function handleToggleToken() {
  const show = els.settingToken.type === 'password';
  els.settingToken.type = show ? 'text' : 'password';
  els.btnToggleToken.textContent = show ? '隐藏' : '显示';
}

/* ============================ 当前标签页信息 ============================ */
function renderTabInfo(tab) {
  const box = els.currentTabInfo;
  if (!tab || !tab.url) {
    box.classList.remove('hidden');
    box.innerHTML = '<span class="tab-badge warn">未知页面</span>' +
      '<span class="tab-meta"><small class="tab-url">无法获取当前标签页信息</small></span>';
    return;
  }
  if (!isWebUrl(tab.url)) {
    box.classList.remove('hidden');
    box.innerHTML = '<span class="tab-badge warn">不可添加</span>' +
      '<span class="tab-meta"><small class="tab-url">当前页面不支持收录，请切换到普通网页</small></span>';
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML =
    `<img class="tab-favicon" src="${escapeHtml(tab.favIconUrl || '')}" alt="" onerror="this.style.visibility='hidden'" />` +
    '<span class="tab-meta">' +
    `<strong class="tab-title">${escapeHtml(tab.title || '未知页面')}</strong>` +
    `<small class="tab-url">${escapeHtml(tab.url)}</small>` +
    '</span>' +
    '<span class="tab-badge ok">可添加</span>';
}

/* ============================ 初始化 ============================ */
async function init() {
  // 1. 读取配置与缓存
  let sync = {};
  let local = {};
  try { sync = await getSync(['baseUrl', 'token', 'lastOption']); } catch (_) {}
  try { local = await getLocal(['options']); } catch (_) {}

  state.baseUrl = String(sync.baseUrl || '').trim();
  state.token = String(sync.token || '').trim();
  state.lastCatalog = String(sync.lastOption || '').trim();

  // 旧版本分类缓存在 sync，迁移到 local 后清理
  let cachedOptions = Array.isArray(local.options) ? local.options : [];
  if (!cachedOptions.length && Array.isArray(sync.options) && sync.options.length) {
    cachedOptions = sync.options;
    setLocal({ options: cachedOptions }).catch(() => {});
    setSync({ options: undefined }).catch(() => {});
  }
  state.catalog = cachedOptions;

  // 2. 读取当前标签页
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.currentTab = tab || null;
  } catch (_) {}
  renderTabInfo(state.currentTab);

  // 3. 首次使用：引导进入设置页
  if (!state.baseUrl || !state.token) {
    showToast('首次使用，请先设置站点地址与 Token', 'info', 4000);
    handleOpenSetting();
    return;
  }

  renderCatalog();
  if (!state.catalog.length) loadCatalog();
}

/* ============================ 事件绑定 ============================ */
function bindEvents() {
  els.addForm.addEventListener('submit', (e) => { e.preventDefault(); handleConfirmAdd(); });
  els.settingForm.addEventListener('submit', (e) => { e.preventDefault(); handleSaveSetting(); });

  els.btnAddTool.addEventListener('click', handleAddTool);
  els.btnOpenAdmin.addEventListener('click', handleOpenAdmin);
  els.btnOpenWebsite.addEventListener('click', handleOpenWebsite);
  els.btnOpenSetting.addEventListener('click', handleOpenSetting);
  els.btnOpenWindow.addEventListener('click', handleOpenWindow);
  els.btnRefresh.addEventListener('click', () => loadCatalog(true));

  els.btnCancelAdd.addEventListener('click', () => showPage(els.mainPage));
  els.btnCancelSetting.addEventListener('click', () => showPage(els.mainPage));
  els.btnTestConn.addEventListener('click', handleTestConn);
  els.btnFetchCatalog.addEventListener('click', () => { applySettingsInputs(); loadCatalog(true); });
  els.btnToggleToken.addEventListener('click', handleToggleToken);

  // Esc 返回主页面
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (els.confirmPage.classList.contains('active') || els.settingPage.classList.contains('active')) {
      showPage(els.mainPage);
    }
  });
}

bindEvents();
init();

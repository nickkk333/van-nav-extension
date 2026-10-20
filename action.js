/*!
 * Van Nav 管理扩展 - action.js
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
  browserSettingForm: $('#browserSettingForm'),
  browserSettingPage: $('#browserSettingPage'),
  browserSiteUrl: $('#browserSiteUrl'),
  browserSiteWarning: $('#browserSiteWarning'),
  browserModeInputs: $$('input[name="browserMode"]'),

  btnRefresh: $('#refreshCatalog'),
  btnAddTool: $('#addTool'),
  btnOpenSetting: $('#openSetting'),
  btnOpenBrowserSettings: $('#openBrowserSettings'),
  btnOpenWindow: $('#openWindow'),
  btnCancelAdd: $('#cancelAdd'),
  btnCancelSetting: $('#cancelSetting'),
  btnTestConn: $('#testConn'),
  btnFetchCatalog: $('#fetchCatelog'),
  btnToggleToken: $('#toggleToken'),
  btnCancelBrowserSetting: $('#cancelBrowserSetting'),

  formCatalog: $('#catelog'),
  formName: $('#name'),
  formUrl: $('#url'),
  formInternalUrl: $('#internalUrl'),
  formLogo: $('#logo'),
  formDesc: $('#desc'),
  formSort: $('#sort'),
  formHide1: $('#hide1'),
  formDefault1: $('#default1'),

  settingBaseUrl: $('#baseUrl'),
  settingIntranetUrl: $('#intranetUrl'),
  settingToken: $('#token'),
  networkStateText: $('#networkStateText'),
  btnRefreshNetwork: $('#refreshNetwork'),

  toast: $('#toast'),
  toastContent: $('#toastContent'),
};

/* ============================ 状态 ============================ */
const state = {
  baseUrl: '',
  intranetUrl: '',
  networkState: 'external',
  token: '',
  browserMode: 'off',
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

// 内网地址允许省略协议，默认补全 http://
const normalizeIntranetUrl = (raw) => {
  const url = String(raw || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) ? url : `http://${url}`;
};

// 工具内网网址允许省略协议，默认补全 http://（保留路径与结尾斜杠）
const normalizeToolInternalUrl = (raw) => {
  const url = String(raw || '').trim();
  if (!url) return '';
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) ? url : `http://${url}`;
};

// 当前网络状态下实际使用的站点地址
const activeBaseUrl = () =>
  (state.networkState === 'intranet' && state.intranetUrl ? state.intranetUrl : state.baseUrl);

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
    const res = await fetch(activeBaseUrl() + path, {
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
  els.formInternalUrl.value = ''; // 内网网址选填，默认留空
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
    // 内网网址选填：留空提交空串，表示该工具没有内网地址
    internalUrl: normalizeToolInternalUrl(els.formInternalUrl.value),
    desc: els.formDesc.value.trim(),
    logo: els.formLogo.value.trim(),
    sort: resolveSort(els.formSort.value),
    hide: els.formHide1.checked,
    default: els.formDefault1.checked,
  };

  // 必填校验（图标与内网网址除外）
  const missing = ['catelog', 'name', 'url', 'desc'].filter((k) => !payload[k]);
  if (missing.length) {
    showToast('除图标与内网网址外均为必填项', 'error');
    return;
  }
  if (!isWebUrl(payload.url)) {
    showToast('网址格式不正确，需以 http(s):// 开头', 'error');
    return;
  }
  if (payload.internalUrl && !isWebUrl(payload.internalUrl)) {
    showToast('内网网址格式不正确，需以 http(s):// 开头', 'error');
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

function renderNetworkStatus() {
  const useIntranet = state.networkState === 'intranet' && !!state.intranetUrl;
  els.networkStateText.textContent = useIntranet ? '内网' : '外网';
  els.networkStateText.classList.toggle('is-intranet', useIntranet);
}

// 让后台重新检测内网是否可用，并返回当前网络状态
function requestNetworkState() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'van-nav:check-network' }, (res) => {
        const err = chrome.runtime.lastError;
        if (!err && res && (res.state === 'intranet' || res.state === 'external')) {
          resolve(res.state);
        } else {
          resolve('external');
        }
      });
    } catch (_) {
      resolve('external');
    }
  });
}

function handleOpenSetting() {
  els.settingBaseUrl.value = state.baseUrl;
  els.settingIntranetUrl.value = state.intranetUrl;
  els.settingToken.value = state.token;
  renderNetworkStatus();
  showPage(els.settingPage);
}

// 将设置表单中的输入临时同步到 state（供“测试连接 / 获取分类”使用）
function applySettingsInputs() {
  const baseUrl = els.settingBaseUrl.value.trim().replace(/\/+$/, '');
  const intranetUrl = normalizeIntranetUrl(els.settingIntranetUrl.value);
  const token = els.settingToken.value.trim();
  if (baseUrl) state.baseUrl = baseUrl;
  if (token) state.token = token;
  state.intranetUrl = intranetUrl;
  if (!intranetUrl) state.networkState = 'external';
}

async function handleSaveSetting() {
  const baseUrl = els.settingBaseUrl.value.trim().replace(/\/+$/, '');
  const intranetUrl = normalizeIntranetUrl(els.settingIntranetUrl.value);
  const token = els.settingToken.value.trim();

  if (!isWebUrl(baseUrl)) {
    showToast('站点地址需以 http(s):// 开头', 'error');
    return;
  }
  if (intranetUrl && !isWebUrl(intranetUrl)) {
    showToast('内网地址需以 http(s):// 开头', 'error');
    return;
  }
  if (!token) {
    showToast('Token 不能为空', 'error');
    return;
  }

  setLoading(true);
  try {
    await setSync({ baseUrl, intranetUrl, token });
    state.baseUrl = baseUrl;
    state.intranetUrl = intranetUrl;
    state.token = token;

    // 保存后立即检测内网可用性，后续请求按检测结果选择地址
    state.networkState = await requestNetworkState();
    renderNetworkStatus();

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

  const prev = {
    baseUrl: state.baseUrl,
    intranetUrl: state.intranetUrl,
    networkState: state.networkState,
    token: state.token,
  };
  applySettingsInputs();

  setLoading(true);
  try {
    await api('/api/admin/all');
    showToast('连接正常 ✓', 'success', 1800);
  } catch (err) {
    showToast('连接失败：' + err.message, 'error', 4000);
  } finally {
    state.baseUrl = prev.baseUrl;
    state.intranetUrl = prev.intranetUrl;
    state.networkState = prev.networkState;
    state.token = prev.token;
    setLoading(false);
  }
}

async function handleRefreshNetwork() {
  setLoading(true);
  try {
    state.networkState = await requestNetworkState();
    renderNetworkStatus();

    let message = '内网不可用，使用外网地址';
    if (state.networkState === 'intranet') {
      message = '内网可用，已切换到内网地址';
    } else if (!state.intranetUrl) {
      message = '未配置内网地址，使用外网地址';
    }
    showToast(message, 'info', 2400);
  } finally {
    setLoading(false);
  }
}

function handleOpenWindow() {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
}

/* ============================ 浏览器设置 ============================ */
function selectedBrowserMode() {
  const checked = els.browserModeInputs.find((input) => input.checked);
  return checked ? checked.value : 'off';
}

function markBrowserModeSelected() {
  const current = selectedBrowserMode();
  els.browserModeInputs.forEach((input) => {
    const card = input.closest('.mode-card');
    if (card) card.classList.toggle('selected', input.value === current);
  });
}

function renderBrowserSettings() {
  const effectiveUrl = activeBaseUrl();
  const siteUrl = isWebUrl(effectiveUrl) ? effectiveUrl : '';
  const link = els.browserSiteUrl;

  if (siteUrl) {
    link.textContent = siteUrl;
    link.href = siteUrl;
    link.target = '_blank';
    link.rel = 'noreferrer';
    els.browserSiteWarning.classList.add('hidden');
  } else {
    link.textContent = '未配置站点地址';
    link.removeAttribute('href');
    link.removeAttribute('target');
    els.browserSiteWarning.classList.remove('hidden');
  }

  const mode = state.browserMode === 'home' || state.browserMode === 'newtab' ? state.browserMode : 'off';
  const input = els.browserModeInputs.find((item) => item.value === mode);
  if (input) input.checked = true;
  markBrowserModeSelected();
}

function handleOpenBrowserSettings() {
  renderBrowserSettings();
  showPage(els.browserSettingPage);
}

async function handleSaveBrowserSettings(event) {
  event.preventDefault();

  const mode = selectedBrowserMode();
  if (mode !== 'off' && !isWebUrl(state.baseUrl)) {
    showToast('请先在「扩展设置」中填写站点地址', 'error', 3200);
    return;
  }

  setLoading(true);
  try {
    await setSync({ browserMode: mode });
    state.browserMode = mode;
    showToast(mode === 'off' ? '已关闭浏览器接管' : '浏览器设置已保存', 'success', 1800);
    showPage(els.mainPage);
  } catch (err) {
    showToast('保存失败：' + err.message, 'error', 3200);
  } finally {
    setLoading(false);
  }
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
    `<img class="tab-favicon" src="${escapeHtml(tab.favIconUrl || '')}" alt="" />` +
    '<span class="tab-meta">' +
    `<strong class="tab-title">${escapeHtml(tab.title || '未知页面')}</strong>` +
    `<small class="tab-url">${escapeHtml(tab.url)}</small>` +
    '</span>' +
    '<span class="tab-badge ok">可添加</span>';

  // 内联 onerror 会被 MV3 的 CSP 拦截，改为脚本绑定
  const fav = box.querySelector('.tab-favicon');
  if (fav) {
    const hideFav = () => { fav.style.visibility = 'hidden'; };
    fav.addEventListener('error', hideFav);
    // 监听前若已加载失败（无图标或加载错误），立即隐藏
    if (!tab.favIconUrl || (fav.complete && fav.naturalWidth === 0)) hideFav();
  }
}

/* ============================ 初始化 ============================ */
async function init() {
  // 1. 读取配置与缓存
  let sync = {};
  let local = {};
  try { sync = await getSync(['baseUrl', 'intranetUrl', 'token', 'lastOption', 'browserMode']); } catch (_) {}
  try { local = await getLocal(['options', 'networkState']); } catch (_) {}

  state.baseUrl = String(sync.baseUrl || '').trim();
  state.intranetUrl = normalizeIntranetUrl(sync.intranetUrl);
  state.networkState = state.intranetUrl && local.networkState === 'intranet' ? 'intranet' : 'external';
  state.token = String(sync.token || '').trim();
  state.lastCatalog = String(sync.lastOption || '').trim();
  state.browserMode = sync.browserMode === 'home' || sync.browserMode === 'newtab' ? sync.browserMode : 'off';

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
  els.browserSettingForm.addEventListener('submit', handleSaveBrowserSettings);

  els.btnAddTool.addEventListener('click', handleAddTool);
  els.btnOpenSetting.addEventListener('click', handleOpenSetting);
  els.btnOpenBrowserSettings.addEventListener('click', handleOpenBrowserSettings);
  els.btnOpenWindow.addEventListener('click', handleOpenWindow);
  els.btnRefresh.addEventListener('click', () => loadCatalog(true));

  els.btnCancelAdd.addEventListener('click', () => showPage(els.mainPage));
  els.btnCancelSetting.addEventListener('click', () => showPage(els.mainPage));
  els.btnCancelBrowserSetting.addEventListener('click', () => showPage(els.mainPage));
  els.btnTestConn.addEventListener('click', handleTestConn);
  els.btnFetchCatalog.addEventListener('click', () => { applySettingsInputs(); loadCatalog(true); });
  els.btnToggleToken.addEventListener('click', handleToggleToken);
  els.btnRefreshNetwork.addEventListener('click', handleRefreshNetwork);

  els.browserModeInputs.forEach((input) => {
    input.addEventListener('change', markBrowserModeSelected);
  });

  // Esc 返回主页面
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (
      els.confirmPage.classList.contains('active') ||
      els.settingPage.classList.contains('active') ||
      els.browserSettingPage.classList.contains('active')
    ) {
      showPage(els.mainPage);
    }
  });
}

bindEvents();
init();

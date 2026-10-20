/*!
 * Van Nav 管理扩展 - background.js
 *
 * 浏览器启动页 / 新标签页接管：
 *  - home   （主页模式）：新标签页自动切回已打开的站点标签页，没有则打开站点
 *  - newtab （新建标签页模式）：新标签页直接打开站点
 *
 * 说明：浏览器不允许扩展直接修改「启动时」设置，因此通过监听
 * 新标签页 / 浏览器启动事件来实现等效效果。
 */
'use strict';

const SITE_KEY = 'baseUrl';
const INTRANET_KEY = 'intranetUrl';
const MODE_KEY = 'browserMode';
const NETWORK_KEY = 'networkState';
const NETWORK_CHECK_TIMEOUT = 2000;

// chrome://newtab、edge://newtab、about:newtab 等各浏览器的新标签页地址
const NEW_TAB_RE =
  /^(?:(?:chrome|edge|brave|opera|vivaldi|chromium):\/\/(?:newtab|startpage)\/?|chrome-search:\/\/local-ntp\/?|about:(?:newtab|home)\/?)(?:[?#].*)?$/i;

// 已处理过的标签页，避免 onCreated / onUpdated 重复处理
const handledTabs = new Map();

/* ============================ 工具函数 ============================ */
function isNewTabUrl(url) {
  return !!url && NEW_TAB_RE.test(String(url));
}

function normalizeSiteUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(value)) return '';
  try {
    new URL(value); // 仅校验格式
    return value;
  } catch (_) {
    return '';
  }
}

function siteHost(siteUrl) {
  try {
    return new URL(siteUrl).host;
  } catch (_) {
    return '';
  }
}

// 同一 host（忽略 http/https 与路径差异）即视为站点标签页
function isSiteUrl(url, host) {
  if (!url || !host) return false;
  try {
    return new URL(url).host === host;
  } catch (_) {
    return false;
  }
}

function tabUrl(tab) {
  return (tab && (tab.url || tab.pendingUrl)) || '';
}

function pruneHandledTabs() {
  const now = Date.now();
  handledTabs.forEach((time, id) => {
    if (now - time > 10000) handledTabs.delete(id);
  });
}

/* ============================ 存储 ============================ */
function getSync(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(keys, (res) => {
      void chrome.runtime.lastError; // 读取失败时使用默认值
      resolve(res || {});
    });
  });
}

function getLocal(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (res) => {
      void chrome.runtime.lastError;
      resolve(res || {});
    });
  });
}

function setLocal(values) {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

/* ============================ 网络环境检测 ============================ */
async function isUrlReachable(url) {
  if (!url) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_CHECK_TIMEOUT);
  try {
    // no-cors 只关心是否可达，不要求内网站点允许跨域
    await fetch(url, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    });
    return true;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function detectNetworkState() {
  const res = await getSync([INTRANET_KEY]);
  const intranetUrl = normalizeSiteUrl(res[INTRANET_KEY]);
  if (!intranetUrl) return 'external';
  return (await isUrlReachable(intranetUrl)) ? 'intranet' : 'external';
}

let pendingNetworkCheck = null;

function refreshNetworkState(force = false) {
  if (pendingNetworkCheck) {
    if (!force) return pendingNetworkCheck;
    // 强制重新检测：等当前检测结束后，再按最新设置检测一次
    return pendingNetworkCheck
      .catch(() => {})
      .then(() => refreshNetworkState());
  }

  const task = detectNetworkState().then(async (networkState) => {
    await setLocal({ networkState, networkCheckedAt: Date.now() });
    return networkState;
  });
  pendingNetworkCheck = task.finally(() => {
    pendingNetworkCheck = null;
  });
  return pendingNetworkCheck;
}

async function getConfig() {
  const [sync, local] = await Promise.all([
    getSync([SITE_KEY, INTRANET_KEY, MODE_KEY]),
    getLocal([NETWORK_KEY]),
  ]);

  const externalUrl = normalizeSiteUrl(sync[SITE_KEY]);
  const intranetUrl = normalizeSiteUrl(sync[INTRANET_KEY]);
  const networkState = intranetUrl && local[NETWORK_KEY] === 'intranet' ? 'intranet' : 'external';
  const siteUrl = networkState === 'intranet' ? intranetUrl : externalUrl;
  const mode = sync[MODE_KEY] === 'home' || sync[MODE_KEY] === 'newtab' ? sync[MODE_KEY] : 'off';

  return { siteUrl, externalUrl, intranetUrl, networkState, mode, host: siteHost(siteUrl) };
}

/* ============================ 标签页操作 ============================ */
async function findSiteTab(host, excludeTabId, windowId) {
  const tabs = await chrome.tabs.query({});
  const hits = tabs.filter((tab) => tab.id !== excludeTabId && isSiteUrl(tabUrl(tab), host));
  if (!hits.length) return null;
  // 优先当前窗口，其次任意窗口
  return hits.find((tab) => tab.windowId === windowId) || hits[0];
}

async function focusTab(tab) {
  try {
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) {}
  try {
    await chrome.tabs.update(tab.id, { active: true });
  } catch (_) {}
}

async function processNewTab(tab) {
  if (!tab || typeof tab.id !== 'number' || tab.id < 0) return;
  if (![tab.url, tab.pendingUrl].some(isNewTabUrl)) return;

  pruneHandledTabs();
  const last = handledTabs.get(tab.id) || 0;
  if (Date.now() - last < 2000) return;
  handledTabs.set(tab.id, Date.now());

  // 浏览器启动时先等待网络检测完成，避免用错内网 / 外网地址
  const check = pendingNetworkCheck;
  if (check) {
    try { await check; } catch (_) {}
  }

  const { siteUrl, mode, host } = await getConfig();
  if (!siteUrl || mode === 'off') return;

  try {
    if (mode === 'home') {
      const target = await findSiteTab(host, tab.id, tab.windowId);
      if (target) {
        // 用户可能已在标签页里输入了其它网址，这时不再拦截
        const current = await chrome.tabs.get(tab.id).catch(() => null);
        if (!current || !isNewTabUrl(tabUrl(current))) return;

        await chrome.tabs.remove(tab.id);
        await focusTab(target);
        return;
      }
    }

    // 新建标签页模式，或主页模式下尚未打开站点：在当前标签页打开站点
    await chrome.tabs.update(tab.id, { url: siteUrl });
  } catch (_) {
    // 标签页可能已被用户关闭，忽略即可
  }
}

// 浏览器启动时确保站点已打开（等效于「启动页为站点网址」）
async function ensureStartupSite() {
  const { siteUrl, mode, host } = await getConfig();
  if (!siteUrl || mode === 'off') return;

  const tabs = await chrome.tabs.query({});
  const hasSiteTab = tabs.some((tab) => isSiteUrl(tabUrl(tab), host));
  const hasNewTab = tabs.some((tab) => isNewTabUrl(tabUrl(tab)));
  if (hasSiteTab || hasNewTab) return; // 新标签页会被 onCreated 接管

  try {
    await chrome.tabs.create({ url: siteUrl, active: true });
  } catch (_) {}
}

/* ============================ 事件监听 ============================ */
chrome.tabs.onCreated.addListener((tab) => {
  void processNewTab(tab);
});

// 兜底：部分浏览器创建标签页时 url 稍后才更新
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && isNewTabUrl(changeInfo.url)) {
    void processNewTab(tab);
  }
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    try {
      await refreshNetworkState();
    } catch (_) {}

    // 等浏览器恢复会话 / 打开启动页后再确保站点已打开
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await ensureStartupSite();
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  void refreshNetworkState();
});

// 设置页保存或手动重新检测时调用
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'van-nav:check-network') return;

  const respond = (state) => {
    try { sendResponse({ state }); } catch (_) {}
  };
  refreshNetworkState(true)
    .then((state) => respond(state))
    .catch(() => respond('external'));
  return true;
});

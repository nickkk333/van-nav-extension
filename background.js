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
// 内外网状态的有效期：超过该时间需重新检测，避免网络环境变化后仍使用旧结果
const NETWORK_STATE_MAX_AGE = 15000;

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
let startupNetworkCheck = null;

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

// 浏览器刚启动时 Wi-Fi / VPN 可能尚未连接，检测失败时短暂重试，
// 避免把可用的内网误判为外网并缓存下来。
function refreshNetworkStateAtStartup() {
  if (startupNetworkCheck) return startupNetworkCheck;

  startupNetworkCheck = (async () => {
    const res = await getSync([INTRANET_KEY]);
    if (!normalizeSiteUrl(res[INTRANET_KEY])) {
      // 未配置内网地址，无需重试
      try {
        return await refreshNetworkState(true);
      } catch (_) {
        return 'external';
      }
    }

    let state = 'external';
    for (const delay of [0, 800, 2000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        state = await refreshNetworkState(true);
      } catch (_) {
        state = 'external';
      }
      if (state === 'intranet') break;
    }
    return state;
  })().finally(() => {
    startupNetworkCheck = null;
  });

  return startupNetworkCheck;
}

// 获取足够新鲜的内外网状态；缓存过期或尚未检测过时重新检测
async function ensureFreshNetworkState(maxAge = NETWORK_STATE_MAX_AGE) {
  // 启动阶段的重试尚未结束：等待它给出最终结果，避免用中途失败的缓存
  if (startupNetworkCheck) {
    try {
      return await startupNetworkCheck;
    } catch (_) {
      return 'external';
    }
  }

  if (pendingNetworkCheck) {
    try {
      return await pendingNetworkCheck;
    } catch (_) {
      return 'external';
    }
  }

  const local = await getLocal([NETWORK_KEY, 'networkCheckedAt']);
  const known = local[NETWORK_KEY] === 'intranet' || local[NETWORK_KEY] === 'external';
  const age = Date.now() - (Number(local.networkCheckedAt) || 0);
  if (known && age >= 0 && age < maxAge) return local[NETWORK_KEY];

  try {
    return await refreshNetworkState();
  } catch (_) {
    return 'external';
  }
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
function siteHosts(urls) {
  const hosts = [];
  urls.forEach((url) => {
    const host = siteHost(url);
    if (host && !hosts.includes(host)) hosts.push(host);
  });
  return hosts;
}

// hosts 按优先级排列（内网在前）：优先当前窗口、内网地址的站点标签页
async function findSiteTab(hosts, excludeTabId, windowId) {
  if (!hosts.length) return null;
  const tabs = await chrome.tabs.query({});
  const matches = (tab) => hosts.some((host) => isSiteUrl(tabUrl(tab), host));
  const hits = tabs.filter((tab) => tab.id !== excludeTabId && matches(tab));
  if (!hits.length) return null;

  const preferredHost = hosts[0];
  return (
    hits.find((tab) => tab.windowId === windowId && isSiteUrl(tabUrl(tab), preferredHost)) ||
    hits.find((tab) => tab.windowId === windowId) ||
    hits.find((tab) => isSiteUrl(tabUrl(tab), preferredHost)) ||
    hits[0]
  );
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

  let config;
  try {
    config = await getConfig();
  } catch (_) {
    return;
  }
  if (config.mode === 'off') return;

  // 主页模式：优先切回已打开的站点标签页，内网 / 外网地址都算。
  // 这样即使本地缓存的内外网状态已过期，也不会错误地新开外网页面。
  if (config.mode === 'home') {
    const target = await findSiteTab(
      siteHosts([config.intranetUrl, config.externalUrl]),
      tab.id,
      tab.windowId
    );
    if (target) {
      // 用户可能已在标签页里输入了其它网址，这时不再拦截
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      if (!current || !isNewTabUrl(tabUrl(current))) return;

      try {
        await chrome.tabs.remove(tab.id);
        await focusTab(target);
      } catch (_) {}
      // 后台刷新状态，供下一次打开新标签页使用
      void ensureFreshNetworkState().catch(() => {});
      return;
    }
  }

  // 需要在该标签页打开站点：打开前必须确保内外网判断是最新的。
  // onStartup 与 onCreated 的触发顺序没有保证；浏览器启动时的检测也可能
  // 早于网络就绪（Wi-Fi / VPN 尚未连接），直接使用缓存会误用外网地址。
  await ensureFreshNetworkState();
  config = await getConfig();
  if (!config.siteUrl || config.mode === 'off') return;

  // 检测期间用户可能已在该标签页输入了其它网址，这时不再拦截
  const current = await chrome.tabs.get(tab.id).catch(() => null);
  if (!current || !isNewTabUrl(tabUrl(current))) return;

  try {
    // 新建标签页模式，或主页模式下尚未打开站点：在当前标签页打开站点
    await chrome.tabs.update(tab.id, { url: config.siteUrl });
  } catch (_) {
    // 标签页可能已被用户关闭，忽略即可
  }
}

// 浏览器启动时确保站点已打开（等效于「启动页为站点网址」）
async function ensureStartupSite() {
  await ensureFreshNetworkState();
  const { siteUrl, mode, host, externalUrl } = await getConfig();
  if (!siteUrl || mode === 'off') return;

  const hosts = siteHosts([host, siteHost(externalUrl)]);
  const tabs = await chrome.tabs.query({});
  const hasSiteTab = tabs.some((tab) => hosts.some((h) => isSiteUrl(tabUrl(tab), h)));
  if (hasSiteTab) return;

  // 会话恢复出来的新标签页可能不会触发 onCreated，这里补处理
  const newTabs = tabs.filter((tab) => isNewTabUrl(tabUrl(tab)));
  if (newTabs.length) {
    for (const tab of newTabs) {
      await processNewTab(tab);
    }
    return;
  }

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
      await refreshNetworkStateAtStartup();
    } catch (_) {}

    // 等浏览器恢复会话 / 打开启动页后再确保站点已打开
    await new Promise((resolve) => setTimeout(resolve, 1200));
    try {
      await ensureStartupSite();
    } catch (_) {}
  })();
});

// Wi-Fi / VPN 重新连接后立即刷新内外网状态，避免后续新标签页继续使用旧的外网地址
self.addEventListener('online', () => {
  void refreshNetworkState(true);
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

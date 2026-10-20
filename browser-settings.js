/*!
 * Van Nav 管理扩展 - browser-settings.js
 * 浏览器设置页：选择启动页与新标签页的打开方式
 */
'use strict';

const $ = (sel) => document.querySelector(sel);

const els = {
  siteUrlText: $('#siteUrlText'),
  siteWarning: $('#siteWarning'),
  form: $('#browserForm'),
  modes: [...document.querySelectorAll('input[name="browserMode"]')],
  openExtensionSetting: $('#openExtensionSetting'),
  saveBtn: $('#saveBrowserSetting'),
  toast: $('#toast'),
  toastContent: $('#toastContent'),
};

/* ============================ 存储 ============================ */
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

/* ============================ 通用工具 ============================ */
const normalizeSiteUrl = (raw) => String(raw || '').trim().replace(/\/+$/, '');
const isWebUrl = (raw) => /^https?:\/\/.+/i.test(String(raw || ''));

let toastTimer = null;
function showToast(message, type = 'info', duration = 2600) {
  els.toast.className = `toast ${type} show`;
  els.toastContent.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), duration);
}

function selectedMode() {
  const checked = els.modes.find((input) => input.checked);
  return checked ? checked.value : 'off';
}

function markSelected() {
  const current = selectedMode();
  els.modes.forEach((input) => {
    const card = input.closest('.mode-card');
    if (card) card.classList.toggle('selected', input.value === current);
  });
}

/* ============================ 渲染 ============================ */
function renderSite(siteUrl) {
  if (isWebUrl(siteUrl)) {
    els.siteUrlText.textContent = siteUrl;
    els.siteUrlText.href = siteUrl;
    els.siteUrlText.target = '_blank';
    els.siteUrlText.rel = 'noreferrer';
    els.siteWarning.classList.add('hidden');
  } else {
    els.siteUrlText.textContent = '未配置站点地址';
    els.siteUrlText.removeAttribute('href');
    els.siteUrlText.removeAttribute('target');
    els.siteWarning.classList.remove('hidden');
  }
}

async function loadSettings() {
  let sync = {};
  try {
    sync = await getSync(['baseUrl', 'browserMode']);
  } catch (_) {}

  const siteUrl = normalizeSiteUrl(sync.baseUrl);
  renderSite(siteUrl);

  const mode = sync.browserMode === 'home' || sync.browserMode === 'newtab'
    ? sync.browserMode
    : 'off';
  const input = els.modes.find((item) => item.value === mode);
  if (input) input.checked = true;
  markSelected();

  return { siteUrl, mode };
}

/* ============================ 动作 ============================ */
async function handleSave(event) {
  event.preventDefault();

  const mode = selectedMode();
  let siteUrl = '';
  try {
    const sync = await getSync(['baseUrl']);
    siteUrl = normalizeSiteUrl(sync.baseUrl);
  } catch (_) {}

  if (mode !== 'off' && !isWebUrl(siteUrl)) {
    showToast('请先在「扩展设置」中填写站点地址', 'error', 3200);
    return;
  }

  els.saveBtn.disabled = true;
  try {
    await setSync({ browserMode: mode });
    showToast(mode === 'off' ? '已关闭浏览器接管' : '浏览器设置已保存', 'success', 1800);
  } catch (err) {
    showToast('保存失败：' + err.message, 'error', 3200);
  } finally {
    els.saveBtn.disabled = false;
  }
}

function handleOpenExtensionSetting() {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html#setting') });
}

/* ============================ 事件绑定 ============================ */
els.modes.forEach((input) => {
  input.addEventListener('change', markSelected);
});
els.form.addEventListener('submit', handleSave);
els.openExtensionSetting.addEventListener('click', handleOpenExtensionSetting);

// 其它页面修改站点地址后，本页自动刷新展示
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.baseUrl) {
    renderSite(normalizeSiteUrl(changes.baseUrl.newValue));
  }
});

loadSettings();

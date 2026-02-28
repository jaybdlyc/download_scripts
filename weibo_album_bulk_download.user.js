// ==UserScript==
// @name         Weibo Album Bulk Downloader
// @namespace    local.weibo.album.bulk.downloader
// @version      1.1.0
// @description  一键批量下载微博相册中的全部图片与 LivePhoto 视频（文件夹模式）
// @match        https://weibo.com/u/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      weibo.com
// @connect      wx1.sinaimg.cn
// @connect      wx2.sinaimg.cn
// @connect      wx3.sinaimg.cn
// @connect      video.weibo.com
// @connect      us.sinaimg.cn
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_MIN_INTERVAL = 1000;
  const DEFAULT_MAX_INTERVAL = 3000;
  const DOWNLOAD_CONCURRENCY = 4;
  const KEY_MIN_INTERVAL = 'weibo_album_min_interval_ms';
  const KEY_MAX_INTERVAL = 'weibo_album_max_interval_ms';
  const KEY_DOWNLOAD_ORDER = 'weibo_album_download_order';
  const DIR_DB_NAME = 'weibo_album_downloader_db';
  const DIR_STORE_NAME = 'kv';
  const DIR_KEY = 'download_dir_handle';

  let currentPageInfo = parsePageInfo();

  let isRunning = false;
  let stopFlag = false;
  let isPaused = false;
  let producerDone = false;
  let discoveredCount = 0;
  let downloadedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let activeDownloads = 0;
  const queue = [];
  const seen = new Set();
  let finishResolver = null;
  let finishPromise = null;
  let currentDirHandle = null;
  let currentTargetDirHandle = null;
  let lastHref = window.location.href;
  let fetchInFlight = false;
  const inFlightSinceIds = new Set();
  let lastTimelineYear = '';
  let lastTimelineMonth = '';
  let headTimelineProbeActive = true;
  let isProgressCollapsed = false;
  let resumedFromPause = false;

  const ui = injectUI();
  registerMenu();
  setupRouteWatcher();
  refreshUiByLocation();
  refreshControlButtons();
  hideProgressPanel();

  function resetRunState() {
    isRunning = false;
    stopFlag = false;
    isPaused = false;
    producerDone = false;
    discoveredCount = 0;
    downloadedCount = 0;
    failedCount = 0;
    skippedCount = 0;
    activeDownloads = 0;
    queue.length = 0;
    seen.clear();
    currentTargetDirHandle = null;
    fetchInFlight = false;
    inFlightSinceIds.clear();
    lastTimelineYear = '';
    lastTimelineMonth = '';
    headTimelineProbeActive = true;
    resumedFromPause = false;
    finishPromise = new Promise((resolve) => {
      finishResolver = resolve;
    });
    setStatus('就绪');
    updateProgress();
    refreshControlButtons();
  }

  function refreshControlButtons() {
    if (!ui.mainBtn || !ui.pauseBtn) return;
    ui.mainBtn.textContent = isRunning ? '停止下载' : '开始下载';
    ui.mainBtn.style.background = isRunning ? '#d14343' : '#1677ff';
    ui.pauseBtn.disabled = !isRunning;
    ui.pauseBtn.textContent = isPaused ? '继续' : '暂停';
    ui.pauseBtn.style.opacity = ui.pauseBtn.disabled ? '0.6' : '1';
    ui.pauseBtn.style.cursor = ui.pauseBtn.disabled ? 'not-allowed' : 'pointer';
  }

  function showProgressPanel() {
    if (isProgressCollapsed) {
      ui.progressWrap.style.display = 'none';
      ui.expandWrap.style.display = 'flex';
      return;
    }
    ui.progressWrap.style.display = 'flex';
    ui.expandWrap.style.display = 'none';
  }

  function hideProgressPanel() {
    ui.progressWrap.style.display = 'none';
    ui.expandWrap.style.display = 'none';
  }

  function setProgressCollapsed(collapsed) {
    isProgressCollapsed = !!collapsed;
    if (!isRunning) {
      hideProgressPanel();
      return;
    }
    showProgressPanel();
  }

  function toggleProgressCollapsed() {
    setProgressCollapsed(!isProgressCollapsed);
  }

  function expandProgressPanel() {
    setProgressCollapsed(false);
  }

  function setStatus(text) {
    const raw = String(text || '');
    const rendered = ellipsizeMiddle(raw, 50);
    ui.status.textContent = rendered;
    ui.status.title = raw;
  }

  function ellipsizeMiddle(text, maxLen) {
    const s = String(text || '');
    const limit = Math.max(10, Number(maxLen) || 72);
    if (s.length <= limit) return s;
    const keep = limit - 1;
    const left = Math.ceil(keep / 2);
    const right = Math.floor(keep / 2);
    return `${s.slice(0, left)}…${s.slice(s.length - right)}`;
  }

  function setProgress(done, total) {
    const safeTotal = Math.max(0, Number(total) || 0);
    const safeDone = Math.min(Math.max(0, Number(done) || 0), safeTotal || 0);
    const pct = safeTotal > 0 ? Math.floor((safeDone * 100) / safeTotal) : 0;
    ui.progressBar.style.width = `${pct}%`;
    ui.progressText.textContent = `${safeDone} / ${safeTotal} (${pct}%)`;
  }

  async function waitIfPaused() {
    let wasPaused = false;
    while (isRunning && isPaused && !stopFlag) {
      wasPaused = true;
      await sleep(200);
    }
    return wasPaused;
  }

  async function run() {
    if (isRunning) return;
    const pageInfo = currentPageInfo || parsePageInfo();
    if (!isAlbumPage(pageInfo)) {
      setStatus('请进入相册页后再下载');
      showProgressPanel();
      return;
    }

    resetRunState();
    isRunning = true;
    stopFlag = false;
    isPaused = false;
    setProgressCollapsed(false);
    showProgressPanel();
    refreshControlButtons();
    setStatus('准备开始...');

    let stoppedByUser = false;
    try {
      const dirHandle = await ensureDownloadDirHandle(true);
      if (!dirHandle) {
        setStatus('未设置下载文件夹');
        return;
      }
      if (stopFlag) {
        stoppedByUser = true;
        return;
      }
      currentDirHandle = dirHandle;
      currentTargetDirHandle = await prepareUserSubDirectory(currentDirHandle, pageInfo.uid);
      if (!currentTargetDirHandle) {
        setStatus('无法创建用户子目录');
        return;
      }

      setStatus('开始抓取媒体列表...');
      await produceMediaList(pageInfo.uid);
      if (stopFlag) {
        stoppedByUser = true;
        return;
      }
      if (queue.length <= 0) {
        setStatus('完成：未收集到可下载媒体');
        setProgress(0, 0);
        return;
      }
      if (getDownloadOrder() === 'reverse') {
        queue.reverse();
      }
      discoveredCount = queue.length;
      setStatus(`收集完成，共 ${discoveredCount} 个，开始${getDownloadOrder() === 'reverse' ? '倒序' : '顺序'}下载...`);
      setProgress(0, discoveredCount);
      producerDone = true;
      for (let i = 0; i < DOWNLOAD_CONCURRENCY; i += 1) {
        runWorker().catch((err) => {
          console.error('[weibo-bulk] worker error:', err);
        });
      }
      maybeResolveFinish();
      await finishPromise;

      if (stopFlag) {
        stoppedByUser = true;
        setStatus(`已停止：成功${downloadedCount} 失败${failedCount} 跳过${skippedCount}`);
      } else {
        setStatus(`下载完成：成功${downloadedCount} 失败${failedCount} 跳过${skippedCount}`);
      }
    } catch (err) {
      console.error('[weibo-bulk] run failed:', err);
      setStatus(`执行失败: ${String(err && err.message ? err.message : err)}`);
    } finally {
      isRunning = false;
      isPaused = false;
      stopFlag = false;
      producerDone = true;
      refreshControlButtons();
      updateProgress();
      if (stoppedByUser) {
        hideProgressPanel();
      } else {
        showProgressPanel();
      }
    }
  }

  function stop() {
    if (!isRunning) return;
    stopFlag = true;
    isPaused = false;
    producerDone = true;
    queue.length = 0;
    maybeResolveFinish();
    hideProgressPanel();
    setStatus('正在停止，完成当前步骤后退出...');
    refreshControlButtons();
  }

  function togglePause() {
    if (!isRunning) return;
    isPaused = !isPaused;
    if (!isPaused) resumedFromPause = true;
    setStatus(isPaused ? '已暂停' : '继续运行...');
    refreshControlButtons();
  }

  function onMainButtonClick() {
    if (isRunning) {
      stop();
    } else {
      run();
    }
  }

  function parsePageInfo() {
    let u;
    try {
      u = new URL(window.location.href);
    } catch (_) {
      return null;
    }
    const m = u.pathname.match(/^\/u\/(\d+)\/?$/);
    if (!m) return null;
    return {
      uid: m[1],
      tabtype: u.searchParams.get('tabtype') || ''
    };
  }

  function isAlbumPage(info) {
    return !!(info && info.uid && info.tabtype === 'album');
  }

  function setUiVisible(visible) {
    if (!ui || !ui.ctrlWrap || !ui.progressWrap || !ui.expandWrap) return;
    ui.ctrlWrap.style.display = visible ? 'flex' : 'none';
    if (!visible) {
      ui.progressWrap.style.display = 'none';
      ui.expandWrap.style.display = 'none';
      return;
    }
    if (isRunning) {
      showProgressPanel();
    } else {
      hideProgressPanel();
    }
  }

  function refreshUiByLocation() {
    currentPageInfo = parsePageInfo();
    setUiVisible(isAlbumPage(currentPageInfo));
  }

  function setupRouteWatcher() {
    const handleChange = () => {
      if (window.location.href === lastHref) return;
      lastHref = window.location.href;
      refreshUiByLocation();
    };

    patchHistoryMethod('pushState');
    patchHistoryMethod('replaceState');
    window.addEventListener('popstate', handleChange, true);
    window.addEventListener('hashchange', handleChange, true);
    window.addEventListener('weibo_bulk_urlchange', handleChange, true);
    setInterval(handleChange, 500);
  }

  function patchHistoryMethod(methodName) {
    const fn = window.history && window.history[methodName];
    if (typeof fn !== 'function') return;
    window.history[methodName] = function (...args) {
      const ret = fn.apply(this, args);
      window.dispatchEvent(new Event('weibo_bulk_urlchange'));
      return ret;
    };
  }

  function injectUI() {
    const ctrlWrap = document.createElement('div');
    ctrlWrap.style.cssText = [
      'position: fixed',
      'right: 16px',
      'bottom: 16px',
      'z-index: 999999',
      'display: flex',
      'gap: 8px',
      'background: rgba(0,0,0,0)',
      'color: #fff',
      'padding: 10px',
      'border-radius: 10px',
      'font-size: 12px'
    ].join(';');

    const mainBtn = document.createElement('button');
    mainBtn.textContent = '开始下载';
    mainBtn.style.cssText = 'border:0;border-radius:8px;padding:8px 12px;background:#1677ff;color:#fff;cursor:pointer;';
    mainBtn.addEventListener('click', onMainButtonClick);

    const pauseBtn = document.createElement('button');
    pauseBtn.textContent = '暂停';
    pauseBtn.disabled = true;
    pauseBtn.style.cssText = 'border:0;border-radius:8px;padding:8px 12px;background:#444;color:#fff;cursor:pointer;';
    pauseBtn.addEventListener('click', togglePause);

    ctrlWrap.appendChild(mainBtn);
    ctrlWrap.appendChild(pauseBtn);
    document.body.appendChild(ctrlWrap);

    const progressWrap = document.createElement('div');
    progressWrap.style.cssText = [
      'position: fixed',
      'right: 16px',
      'bottom: 74px',
      'z-index: 999999',
      'display: flex',
      'align-items: stretch',
      'gap: 10px',
      'background: rgba(0,0,0,.78)',
      'color: #fff',
      'padding: 10px',
      'border-radius: 10px',
      'font-size: 12px',
      'min-width: 300px'
    ].join(';');

    const status = document.createElement('div');
    status.textContent = '就绪';
    status.style.cssText = [
      'padding-right:4px',
      'max-width:320px',
      'white-space:nowrap',
      'overflow:hidden',
      'word-break:keep-all'
    ].join(';');

    const progressTrack = document.createElement('div');
    progressTrack.style.cssText = 'width:100%;height:8px;background:#2f2f2f;border-radius:999px;overflow:hidden;';

    const progressBar = document.createElement('div');
    progressBar.style.cssText = 'width:0%;height:100%;background:#22c55e;transition:width .2s ease;';
    progressTrack.appendChild(progressBar);

    const progressText = document.createElement('div');
    progressText.textContent = '0 / 0 (0%)';

    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:8px;min-width:300px;';
    body.appendChild(status);
    body.appendChild(progressTrack);
    body.appendChild(progressText);
    progressWrap.appendChild(body);
    const foldWrap = document.createElement('div');
    foldWrap.style.cssText = 'position:absolute;top:50%;right:0;transform:translateY(-50%);width:16px;height:56px;display:flex;align-items:center;justify-content:center;border-radius:10px;overflow:hidden;';
    const foldBtn = document.createElement('button');
    foldBtn.textContent = '>';
    foldBtn.style.cssText = 'width:100%;height:100%;border:0;background:rgba(0,0,0,0);color:#fff;cursor:pointer;font-size:14px;line-height:1;padding:0;border-radius:10px;display:flex;align-items:center;justify-content:center;';
    foldBtn.addEventListener('click', toggleProgressCollapsed);
    foldWrap.appendChild(foldBtn);
    progressWrap.style.position = 'fixed';
    progressWrap.appendChild(foldWrap);
    document.body.appendChild(progressWrap);

    const expandWrap = document.createElement('div');
    expandWrap.style.cssText = [
      'position: fixed',
      'right: 16px',
      'bottom: 74px',
      'z-index: 999999',
      'display: none',
      'align-items: center',
      'justify-content: center',
      'background: rgba(0,0,0,.78)',
      'padding-block: 10px',
      'border-radius: 10px',
      'overflow: hidden'
    ].join(';');
    const expandBtn = document.createElement('button');
    expandBtn.textContent = '<';
    expandBtn.style.cssText = 'width:16px;height:60px;border:0;background:rgba(0,0,0,0);color:#fff;cursor:pointer;font-size:14px;line-height:1;padding:0;border-radius:10px;display:flex;align-items:center;justify-content:center;';
    expandBtn.addEventListener('click', expandProgressPanel);
    expandWrap.appendChild(expandBtn);
    document.body.appendChild(expandWrap);

    return { ctrlWrap, mainBtn, pauseBtn, progressWrap, expandWrap, status, progressBar, progressText };
  }

  function getNumberSetting(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') {
        const v = Number(GM_getValue(key, fallback));
        return Number.isFinite(v) ? v : fallback;
      }
    } catch (_) {}
    const fromLs = Number(localStorage.getItem(key));
    return Number.isFinite(fromLs) ? fromLs : fallback;
  }

  function setNumberSetting(key, value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, n);
        return;
      }
    } catch (_) {}
    localStorage.setItem(key, String(n));
  }

  function getStringSetting(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') {
        const v = GM_getValue(key, fallback);
        return typeof v === 'string' ? v : String(v || fallback);
      }
    } catch (_) {}
    const fromLs = localStorage.getItem(key);
    return fromLs == null ? fallback : String(fromLs);
  }

  function setStringSetting(key, value) {
    const v = String(value || '');
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, v);
        return;
      }
    } catch (_) {}
    localStorage.setItem(key, v);
  }

  function getIntervals() {
    const min = Math.max(100, Math.floor(getNumberSetting(KEY_MIN_INTERVAL, DEFAULT_MIN_INTERVAL)));
    const max = Math.max(100, Math.floor(getNumberSetting(KEY_MAX_INTERVAL, DEFAULT_MAX_INTERVAL)));
    if (!isValidIntervalRange(min, max)) {
      return { min: DEFAULT_MIN_INTERVAL, max: DEFAULT_MAX_INTERVAL };
    }
    return { min, max };
  }

  function isValidIntervalRange(min, max) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
    if (min < 100 || max < 100) return false;
    if (max <= min) return false;
    return (max - min) > 3000;
  }

  function getDownloadOrder() {
    const v = getStringSetting(KEY_DOWNLOAD_ORDER, 'reverse');
    return v === 'asc' ? 'asc' : 'reverse';
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('设置', () => {
      showSettingsDialog();
    });
  }

  async function showSettingsDialog() {
    const now = getIntervals();
    const order = getDownloadOrder();
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0, 0, 0, 0.45)';
    overlay.style.zIndex = '1000000';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';

    const panel = document.createElement('div');
    panel.style.width = '420px';
    panel.style.background = '#fff';
    panel.style.borderRadius = '12px';
    panel.style.padding = '14px';
    panel.style.boxShadow = '0 10px 28px rgba(0,0,0,0.25)';
    panel.style.fontSize = '14px';
    panel.style.color = '#222';

    const title = document.createElement('div');
    title.textContent = '下载设置';
    title.style.fontWeight = '700';
    title.style.marginBottom = '10px';

    const folderLabel = document.createElement('div');
    folderLabel.textContent = '下载文件夹';
    folderLabel.style.fontWeight = '600';
    folderLabel.style.marginBottom = '6px';

    const folderValue = document.createElement('div');
    folderValue.textContent = '读取中...';
    folderValue.style.fontSize = '12px';
    folderValue.style.color = '#444';
    folderValue.style.marginBottom = '8px';
    folderValue.style.wordBreak = 'break-all';

    const folderActions = document.createElement('div');
    folderActions.style.display = 'flex';
    folderActions.style.gap = '8px';
    folderActions.style.marginBottom = '12px';

    const pickFolderBtn = document.createElement('button');
    pickFolderBtn.textContent = '选择文件夹';
    pickFolderBtn.style.padding = '6px 10px';
    pickFolderBtn.style.border = '1px solid #ccc';
    pickFolderBtn.style.borderRadius = '8px';
    pickFolderBtn.style.background = '#fff';
    pickFolderBtn.style.cursor = 'pointer';

    const clearFolderBtn = document.createElement('button');
    clearFolderBtn.textContent = '清除文件夹';
    clearFolderBtn.style.padding = '6px 10px';
    clearFolderBtn.style.border = '1px solid #ccc';
    clearFolderBtn.style.borderRadius = '8px';
    clearFolderBtn.style.background = '#fff';
    clearFolderBtn.style.cursor = 'pointer';

    folderActions.appendChild(pickFolderBtn);
    folderActions.appendChild(clearFolderBtn);

    const intervalTitleWrap = document.createElement('div');
    intervalTitleWrap.style.display = 'flex';
    intervalTitleWrap.style.alignItems = 'center';
    intervalTitleWrap.style.gap = '6px';
    intervalTitleWrap.style.marginBottom = '6px';

    const intervalTitle = document.createElement('div');
    intervalTitle.textContent = '调用间隔范围 (ms)';
    intervalTitle.style.fontWeight = '600';

    const intervalTip = document.createElement('span');
    intervalTip.textContent = '?';
    intervalTip.title = '调用api时的间隔，请保持相对较长的时间，以免被微博封号';
    intervalTip.style.display = 'inline-flex';
    intervalTip.style.alignItems = 'center';
    intervalTip.style.justifyContent = 'center';
    intervalTip.style.width = '16px';
    intervalTip.style.height = '16px';
    intervalTip.style.borderRadius = '50%';
    intervalTip.style.background = '#f0f0f0';
    intervalTip.style.color = '#333';
    intervalTip.style.fontSize = '12px';
    intervalTip.style.cursor = 'help';

    intervalTitleWrap.appendChild(intervalTitle);
    intervalTitleWrap.appendChild(intervalTip);

    const line = document.createElement('div');
    line.style.display = 'flex';
    line.style.gap = '10px';
    line.style.marginBottom = '8px';

    const minInput = document.createElement('input');
    minInput.type = 'number';
    minInput.min = '100';
    minInput.step = '100';
    minInput.value = String(now.min);
    minInput.style.width = '120px';
    minInput.style.flex = '0 0 auto';
    minInput.style.padding = '6px';
    minInput.style.border = '1px solid #ccc';
    minInput.style.borderRadius = '8px';

    const maxInput = document.createElement('input');
    maxInput.type = 'number';
    maxInput.min = '100';
    maxInput.step = '100';
    maxInput.value = String(now.max);
    maxInput.style.width = '120px';
    maxInput.style.flex = '0 0 auto';
    maxInput.style.padding = '6px';
    maxInput.style.border = '1px solid #ccc';
    maxInput.style.borderRadius = '8px';

    line.appendChild(minInput);
    line.appendChild(maxInput);

    const orderTitle = document.createElement('div');
    orderTitle.textContent = '下载顺序';
    orderTitle.style.fontWeight = '600';
    orderTitle.style.marginBottom = '6px';

    const orderSelect = document.createElement('select');
    orderSelect.style.width = '100%';
    orderSelect.style.padding = '7px 8px';
    orderSelect.style.border = '1px solid #ccc';
    orderSelect.style.borderRadius = '8px';
    const optReverse = document.createElement('option');
    optReverse.value = 'reverse';
    optReverse.textContent = '倒序';
    const optAsc = document.createElement('option');
    optAsc.value = 'asc';
    optAsc.textContent = '顺序';
    orderSelect.appendChild(optReverse);
    orderSelect.appendChild(optAsc);
    orderSelect.value = order;
    orderSelect.style.marginBottom = '10px';

    const error = document.createElement('div');
    error.style.fontSize = '12px';
    error.style.color = '#c62828';
    error.style.minHeight = '18px';
    error.style.marginBottom = '8px';

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.justifyContent = 'flex-end';
    actions.style.gap = '8px';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.style.padding = '6px 10px';
    cancelBtn.style.border = '1px solid #ccc';
    cancelBtn.style.borderRadius = '8px';
    cancelBtn.style.background = '#fff';
    cancelBtn.style.cursor = 'pointer';

    const okBtn = document.createElement('button');
    okBtn.textContent = '保存';
    okBtn.style.padding = '6px 10px';
    okBtn.style.border = 'none';
    okBtn.style.borderRadius = '8px';
    okBtn.style.background = '#d42c2c';
    okBtn.style.color = '#fff';
    okBtn.style.cursor = 'pointer';

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);

    panel.appendChild(title);
    panel.appendChild(folderLabel);
    panel.appendChild(folderValue);
    panel.appendChild(folderActions);
    panel.appendChild(intervalTitleWrap);
    panel.appendChild(line);
    panel.appendChild(orderTitle);
    panel.appendChild(orderSelect);
    panel.appendChild(error);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();

    const refreshFolderValue = async () => {
      const handle = await getStoredDirHandle();
      if (!handle) {
        folderValue.textContent = '未设置';
        return;
      }
      const name = handle.name ? String(handle.name) : '(已设置)';
      folderValue.textContent = `已设置: ${name}`;
    };

    await refreshFolderValue();

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    cancelBtn.addEventListener('click', close);
    pickFolderBtn.addEventListener('click', async () => {
      error.textContent = '';
      const handle = await pickDownloadDir();
      if (!handle) return;
      const ok = await verifyDirPermission(handle, true);
      if (!ok) {
        error.textContent = '未获得文件夹写入权限';
        return;
      }
      await setStoredDirHandle(handle);
      await refreshFolderValue();
    });
    clearFolderBtn.addEventListener('click', async () => {
      error.textContent = '';
      await clearStoredDirHandle();
      await refreshFolderValue();
    });
    okBtn.addEventListener('click', () => {
      const min = Math.floor(Number(minInput.value));
      const max = Math.floor(Number(maxInput.value));
      if (!isValidIntervalRange(min, max)) {
        error.textContent = '输入不合法：需满足 min>=100 且 max-min>3000';
        return;
      }
      setNumberSetting(KEY_MIN_INTERVAL, min);
      setNumberSetting(KEY_MAX_INTERVAL, max);
      setStringSetting(KEY_DOWNLOAD_ORDER, orderSelect.value === 'asc' ? 'asc' : 'reverse');
      close();
      window.alert(`已保存。间隔: ${min}-${max} ms，顺序: ${orderSelect.value === 'asc' ? '顺序' : '倒序'}`);
    });
  }

  function randomInt(min, max) {
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    return Math.floor(Math.random() * (high - low + 1)) + low;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function pickWxHost() {
    return `wx${randomInt(1, 3)}.sinaimg.cn`;
  }

  function buildImageUrl(pid) {
    return `https://${pickWxHost()}/large/${pid}.jpg`;
  }

  function buildImageUrlWithHost(pid, hostNo) {
    return `https://wx${hostNo}.sinaimg.cn/large/${pid}.jpg`;
  }

  function normalizeVideoUrl(videoUrl) {
    if (!videoUrl) return '';
    try {
      const u = new URL(videoUrl, window.location.origin);
      const lp = u.searchParams.get('livephoto');
      if (lp) return decodeURIComponent(lp);
      return u.href;
    } catch (_) {
      return videoUrl;
    }
  }

  async function produceMediaList(uid) {
    let sinceId = '0';
    while (true) {
      await waitIfPaused();
      if (stopFlag) break;
      let data;
      try {
        data = await requestImageWallSafely(uid, sinceId);
      } catch (err) {
        if (!stopFlag) {
          console.error('[weibo-bulk] fetch page failed:', err);
        }
        break;
      }

      const body = data && data.data ? data.data : {};
      const list = Array.isArray(body.list) ? body.list : [];
      await enqueueFromList(list);
      setStatus(`抓取中：已发现 ${discoveredCount} 个文件`);
      updateProgress();

      const nextSinceId = String(body.since_id ?? '0');
      if (!nextSinceId || nextSinceId === '0') break;
      sinceId = nextSinceId;
      await waitBeforeNextFetch();
      if (stopFlag) break;
    }
  }

  async function waitBeforeNextFetch() {
    const { min, max } = getIntervals();
    const total = randomInt(min, max);
    let waited = 0;
    const step = 250;
    while (waited < total) {
      const paused = await waitIfPaused();
      if (stopFlag) return;
      if (paused || resumedFromPause) {
        resumedFromPause = false;
        return;
      }
      if (queue.length === 0 && activeDownloads === 0) {
        return;
      }
      const ms = Math.min(step, total - waited);
      await sleep(ms);
      waited += ms;
    }
  }

  async function requestImageWallSafely(uid, sinceId) {
    while (fetchInFlight && !stopFlag) {
      await sleep(60);
    }
    if (stopFlag) throw new Error('stopped');
    if (inFlightSinceIds.has(sinceId)) {
      while (inFlightSinceIds.has(sinceId) && !stopFlag) {
        await sleep(60);
      }
    }
    if (stopFlag) throw new Error('stopped');

    fetchInFlight = true;
    inFlightSinceIds.add(sinceId);
    try {
      return await requestImageWall(uid, sinceId);
    } finally {
      inFlightSinceIds.delete(sinceId);
      fetchInFlight = false;
    }
  }

  async function requestImageWall(uid, sinceId) {
    const url = `https://weibo.com/ajax/profile/getImageWall?uid=${encodeURIComponent(uid)}&sinceid=${encodeURIComponent(String(sinceId))}`;
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  async function enqueueFromList(list) {
    for (const item of list) {
      if (stopFlag) break;
      if (!item || typeof item !== 'object') continue;
      const pid = item.pid ? String(item.pid) : '';
      if (!pid) continue;
      const mid = item.mid ? String(item.mid) : 'nomid';
      const timeline = await resolveTimeline(item, mid);
      const baseName = buildBaseFileName(mid, timeline.year, timeline.month, pid);

      const imageTaskId = `img:${pid}`;
      if (!seen.has(imageTaskId)) {
        seen.add(imageTaskId);
        queue.push({
          id: imageTaskId,
          kind: 'image',
          pid,
          url: buildImageUrl(pid),
          filename: `${baseName}.jpg`
        });
        discoveredCount += 1;
      }

      if (item.type === 'livephoto' && item.video) {
        const videoUrl = normalizeVideoUrl(String(item.video));
        if (videoUrl) {
          const videoTaskId = `vid:${pid}:${videoUrl}`;
          if (!seen.has(videoTaskId)) {
            seen.add(videoTaskId);
            queue.push({
              id: videoTaskId,
              kind: 'video',
              pid,
              url: videoUrl,
              filename: `${baseName}${guessVideoExt(videoUrl)}`
            });
            discoveredCount += 1;
          }
        }
      }
    }
  }

  async function resolveTimeline(item, mid) {
    const yRaw = item.timeline_year == null ? '' : String(item.timeline_year).trim();
    const mRaw = item.timeline_month == null ? '' : String(item.timeline_month).trim();
    if (yRaw && mRaw) {
      lastTimelineYear = yRaw;
      lastTimelineMonth = mRaw;
      headTimelineProbeActive = false;
      return { year: yRaw, month: mRaw };
    }
    if (yRaw) lastTimelineYear = yRaw;
    if (mRaw) lastTimelineMonth = mRaw;

    const needProbe = headTimelineProbeActive && mid && (!yRaw || !mRaw);
    if (needProbe) {
      const created = await fetchStatusCreatedAt(mid);
      const parsed = parseCreatedAtToYearMonth(created);
      if (parsed) {
        lastTimelineYear = parsed.year;
        lastTimelineMonth = parsed.month;
      }
    }

    if (lastTimelineYear && lastTimelineMonth) {
      return { year: lastTimelineYear, month: lastTimelineMonth };
    }
    return {
      year: lastTimelineYear || 'unknown',
      month: lastTimelineMonth || 'unknown'
    };
  }

  function buildBaseFileName(mid, year, month, pid) {
    return `${mid}_${year}_${month}_${pid}`;
  }

  async function fetchStatusCreatedAt(mid) {
    try {
      const url = `https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(mid)}&locale=zh-CN`;
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json, text/plain, */*' }
      });
      if (!res.ok) return '';
      const json = await res.json();
      return json && json.created_at ? String(json.created_at) : '';
    } catch (_) {
      return '';
    }
  }

  function parseCreatedAtToYearMonth(createdAt) {
    if (!createdAt) return null;
    const m = createdAt.match(/^\w+\s+(\w+)\s+\d+\s+\d+:\d+:\d+\s+[+-]\d+\s+(\d{4})$/);
    if (!m) return null;
    const monthMap = {
      Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
      Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
    };
    const mon = monthMap[m[1]];
    const year = m[2];
    if (!mon || !year) return null;
    return { year, month: mon };
  }

  function guessVideoExt(url) {
    try {
      const u = new URL(url);
      const m = (u.pathname || '').match(/\.([a-z0-9]{2,5})$/i);
      if (m) return `.${m[1].toLowerCase()}`;
    } catch (_) {}
    return '.mp4';
  }

  async function runWorker() {
    while (true) {
      await waitIfPaused();
      if (stopFlag && queue.length === 0) break;
      const task = queue.shift();
      if (!task) {
        if (producerDone || stopFlag) break;
        await sleep(300);
        continue;
      }

      activeDownloads += 1;
      try {
        setStatus(`下载中：${task.filename}`);
        const result = await downloadTask(task);
        if (result === 'skip') {
          skippedCount += 1;
        } else {
          downloadedCount += 1;
        }
      } catch (err) {
        failedCount += 1;
        console.error('[weibo-bulk] download failed:', task.url, err);
      } finally {
        activeDownloads -= 1;
        updateProgress();
        maybeResolveFinish();
      }
    }
    maybeResolveFinish();
  }

  async function downloadTask(task) {
    const candidates = getDownloadCandidates(task);
    let lastErr = null;
    const maxRounds = 2;
    for (let round = 1; round <= maxRounds; round += 1) {
      for (const url of candidates) {
        try {
          const blob = await requestBlob(url);
          const written = await writeBlobToFile(currentTargetDirHandle, sanitizeFileName(task.filename), blob);
          if (!written) {
            return 'skip';
          }
          return 'ok';
        } catch (err) {
          lastErr = err;
          console.warn('[weibo-bulk] download attempt failed:', round, url, err);
          await sleep(250 + randomInt(0, 400));
        }
      }
    }
    throw lastErr || new Error('download failed after retries');
  }

  function getDownloadCandidates(task) {
    if (task && task.kind === 'image' && task.pid) {
      const hosts = [1, 2, 3];
      const preferred = extractWxHostNo(task.url);
      if (preferred >= 1 && preferred <= 3) {
        hosts.splice(hosts.indexOf(preferred), 1);
        hosts.unshift(preferred);
      }
      return hosts.map((n) => buildImageUrlWithHost(task.pid, n));
    }
    return [task.url];
  }

  function extractWxHostNo(url) {
    try {
      const m = new URL(url).hostname.match(/^wx([1-3])\.sinaimg\.cn$/i);
      return m ? Number(m[1]) : 0;
    } catch (_) {
      return 0;
    }
  }

  function requestBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'blob',
        timeout: 45000,
        headers: {
          Referer: 'https://weibo.com/',
          Origin: 'https://weibo.com'
        },
        onload: (resp) => {
          if (!resp || resp.status < 200 || resp.status >= 300 || !resp.response) {
            reject(new Error(`http ${resp ? resp.status : 'unknown'}`));
            return;
          }
          resolve(resp.response);
        },
        onerror: (err) => reject(err),
        ontimeout: () => reject(new Error('timeout')),
        onabort: () => reject(new Error('aborted'))
      });
    });
  }

  async function ensureDownloadDirHandle(interactive) {
    if (!('showDirectoryPicker' in window)) {
      window.alert('当前浏览器不支持文件夹模式，请使用支持 File System Access API 的浏览器');
      return null;
    }

    let handle = await getStoredDirHandle();
    if (handle) {
      const ok = await verifyDirPermission(handle, interactive);
      if (ok) return handle;
      await clearStoredDirHandle();
      handle = null;
    }

    if (!interactive) return null;
    handle = await pickDownloadDir();
    if (!handle) return null;

    const ok = await verifyDirPermission(handle, true);
    if (!ok) return null;
    await setStoredDirHandle(handle);
    return handle;
  }

  async function pickDownloadDir() {
    try {
      return await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (_) {
      return null;
    }
  }

  async function verifyDirPermission(handle, askIfNeeded) {
    if (!handle || typeof handle.queryPermission !== 'function') return false;
    const opts = { mode: 'readwrite' };
    let state = await handle.queryPermission(opts);
    if (state === 'granted') return true;
    if (!askIfNeeded || typeof handle.requestPermission !== 'function') return false;
    state = await handle.requestPermission(opts);
    return state === 'granted';
  }

  async function writeBlobToFile(dirHandle, filename, blob) {
    const exists = await fileExists(dirHandle, filename);
    if (exists) return false;
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  }

  async function fileExists(dirHandle, filename) {
    try {
      await dirHandle.getFileHandle(filename, { create: false });
      return true;
    } catch (err) {
      return false;
    }
  }

  async function prepareUserSubDirectory(baseDirHandle, uid) {
    const profile = await fetchProfileInfo(uid);
    const screenName = profile && profile.screen_name ? String(profile.screen_name) : '';
    const dirName = sanitizeDirName(screenName || uid);
    try {
      return await baseDirHandle.getDirectoryHandle(dirName, { create: true });
    } catch (err) {
      console.error('[weibo-bulk] create user subdir failed:', err);
      return null;
    }
  }

  async function fetchProfileInfo(uid) {
    const url = `https://weibo.com/ajax/profile/info?uid=${encodeURIComponent(uid)}`;
    try {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json, text/plain, */*' }
      });
      if (!res.ok) return null;
      const json = await res.json();
      if (!json || Number(json.ok) !== 1 || !json.data || !json.data.user) return null;
      return json.data.user;
    } catch (err) {
      console.warn('[weibo-bulk] fetch profile info failed:', err);
      return null;
    }
  }

  function sanitizeFileName(name) {
    return String(name || 'file.bin').replace(/[\\/:*?"<>|]/g, '_');
  }

  function sanitizeDirName(name) {
    const cleaned = String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim();
    return cleaned || 'weibo_user';
  }

  function maybeResolveFinish() {
    if (!finishResolver) return;
    if (!producerDone) return;
    if (queue.length > 0) return;
    if (activeDownloads > 0) return;
    const done = finishResolver;
    finishResolver = null;
    done();
  }

  function updateProgress() {
    const done = downloadedCount + failedCount + skippedCount;
    setProgress(done, discoveredCount);
  }

  function openDirDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DIR_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DIR_STORE_NAME)) {
          db.createObjectStore(DIR_STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await openDirDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DIR_STORE_NAME, 'readonly');
      const store = tx.objectStore(DIR_STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    });
  }

  async function idbSet(key, value) {
    const db = await openDirDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DIR_STORE_NAME, 'readwrite');
      tx.objectStore(DIR_STORE_NAME).put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  async function idbDelete(key) {
    const db = await openDirDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DIR_STORE_NAME, 'readwrite');
      tx.objectStore(DIR_STORE_NAME).delete(key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  async function getStoredDirHandle() {
    try {
      return await idbGet(DIR_KEY);
    } catch (err) {
      console.error('[weibo-bulk] read dir handle failed:', err);
      return null;
    }
  }

  async function setStoredDirHandle(handle) {
    await idbSet(DIR_KEY, handle);
  }

  async function clearStoredDirHandle() {
    await idbDelete(DIR_KEY);
  }
})();

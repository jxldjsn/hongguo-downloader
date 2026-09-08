const { contextBridge, ipcRenderer } = require('electron');

// 暴露安全的API给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  // Cookie管理
  openLoginWindow: (platform) => ipcRenderer.invoke('open-login-window', platform),
  getCookies: (platform) => ipcRenderer.invoke('get-cookies', platform),
  clearCookies: (platform) => ipcRenderer.invoke('clear-cookies', platform),
  listBrowsers: () => ipcRenderer.invoke('list-browsers'),
  importBrowserCookies: (browserKey, platform) => ipcRenderer.invoke('import-browser-cookies', browserKey, platform),
  closeBrowser: (browserKey) => ipcRenderer.invoke('close-browser', browserKey),
  setCookieManual: (cookieString, platform) => ipcRenderer.invoke('set-cookie-manual', cookieString, platform),
  diagnoseDouyinLogin: () => ipcRenderer.invoke('diagnose-douyin-login'),

  // Python API调用 (deprecated)
  pythonAPI: (endpoint, data) => ipcRenderer.invoke('python-api', endpoint, data),

  // Native API调用
  nativeAPI: (platform, method, params) => ipcRenderer.invoke('native-api', { platform, method, params }),

  // 主页下载历史记录
  profileHistoryList: () => ipcRenderer.invoke('profile-history-list'),
  profileHistoryAdd: (historyData) => ipcRenderer.invoke('profile-history-add', historyData),
  profileHistoryRemove: (key) => ipcRenderer.invoke('profile-history-remove', key),
  profileHistoryClear: () => ipcRenderer.invoke('profile-history-clear'),

  // 绯荤粺鍔熻兘
  checkPythonStatus: () => ipcRenderer.invoke('check-python-status'),
  checkCookieStatus: (platform) => ipcRenderer.invoke('check-cookie-status', platform),
  getLoginStatusSummary: () => ipcRenderer.invoke('get-login-status-summary'),
  onLoginStatusChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('login-status-changed', handler);
    return () => ipcRenderer.removeListener('login-status-changed', handler);
  },
  minimizeWindow: () => ipcRenderer.invoke('window-control', 'minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window-control', 'toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-control', 'close'),
  getWindowState: () => ipcRenderer.invoke('get-window-state'),
  onWindowStateChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('window-state-changed', handler);
    return () => ipcRenderer.removeListener('window-state-changed', handler);
  },
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  saveTheme: (theme) => ipcRenderer.invoke('save-theme', theme),
  downloadFile: (url, filename, videoInfo, platform, options) => ipcRenderer.invoke('download-file', { url, filename, videoInfo, platform, ...(options || {}) }),
  downloadComments: (awemeId, videoTitle) => ipcRenderer.invoke('download-comments', { awemeId, videoTitle }),

  // 鍝斿摡鍝斿摡鐩存挱
  biliGetLiveStream: (input) => ipcRenderer.invoke('bili-get-live-stream', input),

  // 灏忕孩涔︿富椤垫壒閲忎笅杞?
  xhsProfileList: (profileUrl, maxPages = 999) => ipcRenderer.invoke('xhs-profile-list', profileUrl, maxPages),
  xhsProfileDetail: (noteId) => ipcRenderer.invoke('xhs-profile-detail', noteId),
  // 鎵归噺涓嬭浇锛氫竴娆℃€ф彁浜ら€変腑绗旇锛屼富杩涚▼鍏ラ槦涓?parsing 浠诲姟 + 鍚庡彴骞跺彂瑙ｆ瀽杞笅杞?
  xhsProfileDownloadBatch: (notes) => ipcRenderer.invoke('xhs-profile-download-batch', notes),

  // 蹇墜涓婚〉浣滃搧鍒楄〃鎶撳彇锛堢函 HTTP 閫嗗悜 GraphQL锛岄渶鍏堢櫥褰曞揩鎵嬶級
  // 杩斿洖 { success, user, videos, error? }锛寁ideos 涓庢姈闊?aweme 鍏煎锛屽彲鐩存帴澶嶇敤涓嬭浇閫昏緫
  ksProfileList: (profileUrl, maxPages = 20) => ipcRenderer.invoke('ks-profile-list', profileUrl, maxPages),

  // B 绔欎富椤垫姇绋夸綔鍝佸垪琛ㄦ姄鍙栵紙绾?HTTP + Wbi 绛惧悕锛屾棤闇€鐧诲綍锛?
  // 杩斿洖 { success, user, videos, error? }锛寁ideos 鍚?bvid/title/watch_url锛屼笅杞借蛋 yt-dlp
  biliProfileList: (profileUrl, maxPages = 20) => ipcRenderer.invoke('bili-profile-list', profileUrl, maxPages),
  // B 绔欒棰戝畬鏁?DASH 娴佽В鏋愶紙鐚姄鏂规锛氱函 HTTP 鎷垮叏閮ㄦ竻鏅板害闊宠棰戞祦锛屼笉渚濊禆鎾斁鍣級
  biliPlayStreams: (urlOrBvid) => ipcRenderer.invoke('bili-play-streams', urlOrBvid),

  // 閫氱敤缃戦〉鍡呮帰锛堥€氱敤涓嬭浇鍣級锛氭墦寮€鍙绐楀彛鎹曡幏椤甸潰濯掍綋璧勬簮
  sniffStart: (winUrl) => ipcRenderer.invoke('sniff-start', winUrl),
  sniffStop: () => ipcRenderer.invoke('sniff-stop'),
  sniffStatus: () => ipcRenderer.invoke('sniff-status'),
  // 鍡呮帰鍒版柊璧勬簮锛堝疄鏃舵帹閫?{ url, type, contentType, size, pageUrl }锛?
  onSniffResource: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('sniff-resource', handler);
    return () => ipcRenderer.removeListener('sniff-resource', handler);
  },
  // 鍡呮帰鐘舵€佹彁绀?/ 绐楀彛鍏抽棴
  onSniffStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('sniff-status', handler);
    return () => ipcRenderer.removeListener('sniff-status', handler);
  },
  onSniffStopped: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('sniff-stopped', handler);
    return () => ipcRenderer.removeListener('sniff-stopped', handler);
  },

  // 澶氬钩鍙拌棰戣В鏋愪笌涓嬭浇
  parseVideoLink: (text) => ipcRenderer.invoke('parse-video-link', text),
  downloadAlbum: (items, videoInfo, platform, options) => ipcRenderer.invoke('download-album', { items, videoInfo, platform, ...(options || {}) }),
  onSniffResource: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('sniff-resource', handler);
    return () => ipcRenderer.removeListener('sniff-resource', handler);
  },
  // 鍡呮帰鐘舵€佹彁绀?/ 绐楀彛鍏抽棴
  onSniffStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('sniff-status', handler);
    return () => ipcRenderer.removeListener('sniff-status', handler);
  },
  onSniffStopped: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('sniff-stopped', handler);
    return () => ipcRenderer.removeListener('sniff-stopped', handler);
  },

  // 澶氬钩鍙拌棰戣В鏋愪笌涓嬭浇
  parseVideoLink: (text) => ipcRenderer.invoke('parse-video-link', text),
  downloadAlbum: (items, videoInfo, platform, options) => ipcRenderer.invoke('download-album', { items, videoInfo, platform, ...(options || {}) }),
  downloadDash: (videoUrl, audioUrl, videoInfo, platform, options) => ipcRenderer.invoke('download-dash', { videoUrl, audioUrl, videoInfo, platform, ...(options || {}) }),
  downloadM3u8: (m3u8Url, videoInfo, platform, options) => ipcRenderer.invoke('download-m3u8', { m3u8Url, videoInfo, platform, ...(options || {}) }),
  downloadMpd: (mpdUrl, videoInfo, platform, options) => ipcRenderer.invoke('download-mpd', { mpdUrl, videoInfo, platform, ...(options || {}) }),
  recordLiveStream: (streamUrl, filename, videoInfo, platform, options) => ipcRenderer.invoke('record-live-stream', { streamUrl, filename, videoInfo, platform, ...(options || {}) }),
  downloadYtdl: (url, videoInfo, platform, formatId, options) => ipcRenderer.invoke('download-ytdl', { url, videoInfo, platform, formatId, ...(options || {}) }),

  // 绾㈡灉鐭墽鎵归噺涓嬭浇
  hongguoResolve: (input) => ipcRenderer.invoke('hongguo-resolve', input),
  hongguoDownloadBatch: (payload) => ipcRenderer.invoke('hongguo-download-batch', payload),

  getDownloadTasks: () => ipcRenderer.invoke('get-download-tasks'),
  openFolder: (taskId) => ipcRenderer.invoke('open-folder', taskId),
  openDownloadFolder: () => ipcRenderer.invoke('open-folder', { scope: 'download-root' }),
  deleteTask: (taskId) => ipcRenderer.invoke('delete-task', taskId),
  deleteTasks: (taskIds) => ipcRenderer.invoke('delete-tasks', taskIds),
  stopDownload: (taskId) => ipcRenderer.invoke('stop-download', taskId),
  retryTask: (taskId) => ipcRenderer.invoke('retry-task', taskId),
  retryTasks: (taskIds) => ipcRenderer.invoke('retry-tasks', taskIds),

  // 鎺у埗绔疉PI
  getControlPanelConfig: () => ipcRenderer.invoke('get-control-panel-config'),
  setControlPanelUrl: (url) => ipcRenderer.invoke('set-control-panel-url', url),
  getControlPanelAds: () => ipcRenderer.invoke('get-control-panel-ads'),
  getControlPanelPromo: () => ipcRenderer.invoke('get-control-panel-promo'),
  getClientConfig: () => ipcRenderer.invoke('get-client-config'),
  checkControlPanelVersion: () => ipcRenderer.invoke('check-control-panel-version'),
  getControlPanelPopup: () => ipcRenderer.invoke('get-control-panel-popup'),
  reportIPToControlPanel: () => ipcRenderer.invoke('report-ip-to-control-panel'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  douyinSearch: (keyword, maxPages) => ipcRenderer.invoke('douyin-search', keyword, maxPages),
  youtubeShorts: (url, maxPages = 20) => ipcRenderer.invoke('youtube-shorts', url, maxPages),
  // 鎶栭煶鐢ㄦ埛鍠滄鍒楄〃锛堢函閫嗗悜锛氭粴鍔ㄦ崟鑾风鍚?+ net.fetch 閲嶆斁锛?
  douyinLiked: (url, maxPages = 20) => ipcRenderer.invoke('douyin-liked', url, maxPages),
  onLikedProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('douyin-liked-progress', handler);
    return () => ipcRenderer.removeListener('douyin-liked-progress', handler);
  },
  // 鎴戠殑璐﹀彿锛歴elf 椤靛悇 tab锛堝彂甯?鎺ㄨ崘/鍠滄/鏀惰棌/瑙傜湅鍘嗗彶/绋嶅悗鍐嶇湅锛夋暟鎹笅杞斤紙绾€嗗悜锛?
  douyinSelfFetch: (tab, maxPages = 10) => ipcRenderer.invoke('douyin-self-fetch', tab, maxPages),
  onSelfProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('douyin-self-progress', handler);
    return () => ipcRenderer.removeListener('douyin-self-progress', handler);
  },
  // YouTube Shorts 鎶撳彇杩涘害鎺ㄩ€侊紙涓昏繘绋嬮€愰〉鍙戦€侊級锛岃繑鍥炲彇娑堣闃呭嚱鏁?
  onYoutubeShortsProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('youtube-shorts-progress', handler);
    return () => ipcRenderer.removeListener('youtube-shorts-progress', handler);
  },
  // 鎶栭煶鎼滅储杩涘害鎺ㄩ€侊紙涓昏繘绋嬮€愰〉鍙戦€侊級锛岃繑鍥炲彇娑堣闃呭嚱鏁?
  onSearchProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('douyin-search-progress', handler);
    return () => ipcRenderer.removeListener('douyin-search-progress', handler);
  },

  // 鍏虫敞鐩戞帶
  monitorAddUser: (input) => ipcRenderer.invoke('monitor-add-user', input),
  monitorRemoveUser: (secUserId) => ipcRenderer.invoke('monitor-remove-user', secUserId),
  monitorUpdateUser: (opts) => ipcRenderer.invoke('monitor-update-user', opts),
  monitorListUsers: () => ipcRenderer.invoke('monitor-list-users'),
  monitorAddVideo: (input) => ipcRenderer.invoke('monitor-add-video', input),
  monitorRemoveVideo: (awemeId) => ipcRenderer.invoke('monitor-remove-video', awemeId),
  monitorListVideos: () => ipcRenderer.invoke('monitor-list-videos'),
  monitorGetEvents: () => ipcRenderer.invoke('monitor-get-events'),
  monitorClearEvents: () => ipcRenderer.invoke('monitor-clear-events'),
  monitorMarkEventsRead: () => ipcRenderer.invoke('monitor-mark-events-read'),
  monitorGetConfig: () => ipcRenderer.invoke('monitor-get-config'),
  monitorSetConfig: (config) => ipcRenderer.invoke('monitor-set-config', config),
  monitorCheckNow: () => ipcRenderer.invoke('monitor-check-now'),
  testServerChan: (payload) => ipcRenderer.invoke('test-server-chan', payload),

  // 璐﹀彿绠＄悊
  accountList: () => ipcRenderer.invoke('account-list'),
  accountAdd: (accountData) => ipcRenderer.invoke('account-add', accountData),
  accountAddBatch: (items, groupId) => ipcRenderer.invoke('account-add-batch', { items, groupId }),
  accountRemove: (secUserId) => ipcRenderer.invoke('account-remove', secUserId),
  accountUpdateMeta: (secUserId, patch) => ipcRenderer.invoke('account-update-meta', { secUserId, patch }),
  accountRefresh: (secUserId, patch) => ipcRenderer.invoke('account-refresh', { secUserId, patch }),
  accountMigrateLocalStorage: (accounts) => ipcRenderer.invoke('account-migrate-localStorage', accounts),
  accountGetHistory: (secUserId) => ipcRenderer.invoke('account-get-history', secUserId),
  accountGetWorks: (secUserId) => ipcRenderer.invoke('account-get-works', secUserId),
  accountGetWorkStats: (awemeId) => ipcRenderer.invoke('account-get-work-stats', awemeId),
  accountCheckNow: () => ipcRenderer.invoke('account-check-now'),

  // 鎴戠殑璐﹀彿锛堣繍钀ヤ笓鍖猴細缁戝畾鑷繁鐨勬姈闊宠处鍙凤紝鐢ㄥ悇鑷?cookie 鐪嬫挱鏀鹃噺锛?
  myAccountList: () => ipcRenderer.invoke('my-account-list'),
  myAccountBindLogin: () => ipcRenderer.invoke('my-account-bind-login'),
  myAccountBindCurrent: () => ipcRenderer.invoke('my-account-bind-current'),
  myAccountRemove: (uid) => ipcRenderer.invoke('my-account-remove', uid),
  myAccountRefresh: (uid) => ipcRenderer.invoke('my-account-refresh', uid),
  myAccountWorks: (uid, cursor = 0, count = 30) => ipcRenderer.invoke('my-account-works', uid, cursor, count),

  // 鍒嗙粍锛坅ccount / monitor_user / monitor_video 鍏辩敤锛岀敤 scope 鍖哄垎锛?
  groupList: (scope) => ipcRenderer.invoke('group-list', scope),
  groupAdd: (arg) => ipcRenderer.invoke('group-add', arg),
  groupRename: (id, name) => ipcRenderer.invoke('group-rename', { id, name }),
  groupUpdateColor: (id, color) => ipcRenderer.invoke('group-update-color', { id, color }),
  groupRemove: (id) => ipcRenderer.invoke('group-remove', id),
  groupMoveAccount: (secUserId, groupId) => ipcRenderer.invoke('group-move-account', { secUserId, groupId }),
  groupMoveMonitorUser: (secUserId, groupId) => ipcRenderer.invoke('group-move-monitor-user', { secUserId, groupId }),
  groupMoveMonitorVideo: (awemeId, groupId) => ipcRenderer.invoke('group-move-monitor-video', { awemeId, groupId }),
  monitorUpdateUserMeta: (secUserId, patch) => ipcRenderer.invoke('monitor-update-user-meta', { secUserId, patch }),
  monitorUpdateVideoMeta: (awemeId, patch) => ipcRenderer.invoke('monitor-update-video-meta', { awemeId, patch }),

  // 浜嬩欢鐩戝惉锛氱粺涓€杩斿洖鍙栨秷璁㈤槄鍑芥暟锛岃皟鐢ㄥ悗绉婚櫎璇ョ洃鍚櫒
  onMonitorEvent: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('monitor-event', handler);
    return () => ipcRenderer.removeListener('monitor-event', handler);
  },
  onMonitorUpdated: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('monitor-updated', handler);
    return () => ipcRenderer.removeListener('monitor-updated', handler);
  },
  onAccountUpdated: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('account-updated', handler);
    return () => ipcRenderer.removeListener('account-updated', handler);
  },

  // 浜嬩欢鐩戝惉
  onDownloadProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('download-progress', handler);
    return () => ipcRenderer.removeListener('download-progress', handler);
  },
  onDownloadTaskAdded: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('download-task-added', handler);
    return () => ipcRenderer.removeListener('download-task-added', handler);
  },
  onDownloadCompleted: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('download-completed', handler);
    return () => ipcRenderer.removeListener('download-completed', handler);
  },
  onDownloadFailed: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('download-failed', handler);
    return () => ipcRenderer.removeListener('download-failed', handler);
  },
  onDownloadStopped: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('download-stopped', handler);
    return () => ipcRenderer.removeListener('download-stopped', handler);
  },
  onDownloadPartial: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('download-partial', handler);
    return () => ipcRenderer.removeListener('download-partial', handler);
  },
  // 灏忕孩涔︿富椤垫姄鍙栬繘搴︼紙闃舵 + 宸茬疮璁℃潯鏁帮級
  onXhsProfileProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('xhs-profile-progress', handler);
    return () => ipcRenderer.removeListener('xhs-profile-progress', handler);
  },
  // 蹇墜涓婚〉鎶撳彇杩涘害锛堥€愰〉鎺ㄩ€?{page, total, fetched}锛?
  onKsProfileProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('ks-profile-progress', handler);
    return () => ipcRenderer.removeListener('ks-profile-progress', handler);
  },
  // B 绔欎富椤垫姄鍙栬繘搴︼紙閫愰〉鎺ㄩ€?{page, total, fetched, totalCount}锛?
  onBiliProfileProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('bili-profile-progress', handler);
    return () => ipcRenderer.removeListener('bili-profile-progress', handler);
  }
});


# Login Trust and XHS Entry Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow only the active project's local React fallback page to use IPC and remove the duplicate Xiaohongshu login tab without removing Xiaohongshu login capability.

**Architecture:** Extend the existing renderer URL predicate with one exact local-entry comparison that applies in both source and packaged modes. Keep the existing development-origin rule and all remote-page denials. Treat the Xiaohongshu profile page as the sole UI owner of Xiaohongshu login while preserving the shared main-process login service.

**Tech Stack:** Electron, Node.js CommonJS, React, Node test runner, Vite, electron-builder.

---

### Task 1: Reproduce both regressions with tests

**Files:**
- Modify: `tests/ipc-guards.test.js`
- Modify: `tests/renderer-integration.test.js`

- [x] **Step 1: Add a local-fallback trust assertion**

Add a case using `pathToFileURL(path.join(appRoot, 'dist-react', 'index.html'))` with `{ packaged: false, appRoot }` and assert it is trusted. Assert a sibling HTML file remains untrusted.

- [x] **Step 2: Add an ownership assertion for Xiaohongshu login**

Read `CookieManager.jsx` in the renderer integration test. Assert it has no `xiaohongshu` platform config, and assert `XhsProfileDownload.jsx` still contains `openLoginWindow('xiaohongshu')`.

- [x] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-concurrency=1 tests/ipc-guards.test.js tests/renderer-integration.test.js
```

Expected: the local fallback assertion fails because source mode currently accepts only the Vite origin; the CookieManager assertion fails because it still contains the Xiaohongshu tab.

### Task 2: Correct the trust boundary

**Files:**
- Modify: `src/native/security/ipcGuards.js`
- Test: `tests/ipc-guards.test.js`

- [x] **Step 1: Handle exact local entry URLs before the mode-specific origin rule**

For a `file:` URL, reject credentials, query strings, and fragments; convert it with `fileURLToPath`; then compare it to `path.join(policy.appRoot, 'dist-react', 'index.html')`. Without `appRoot`, retain the existing packaged-only suffix check.

- [x] **Step 2: Keep packaged mode closed to all non-file URLs**

After handling `file:`, return false when `policy.packaged === true`. Only non-packaged mode may continue to the exact development-origin comparison.

- [x] **Step 3: Run the IPC guard tests and verify GREEN**

Run:

```powershell
node --test --test-concurrency=1 tests/ipc-guards.test.js
```

Expected: all IPC guard tests pass, including exact local fallback acceptance and rejection of unrelated files.

### Task 3: Make the profile page the only Xiaohongshu login entry

**Files:**
- Modify: `src/components/CookieManager.jsx`
- Modify: `main.js`
- Modify: `src/native/xhsProfile.js`
- Test: `tests/renderer-integration.test.js`

- [x] **Step 1: Remove only the Xiaohongshu platform tab configuration**

Delete the `xiaohongshu` member from `CookieManager`'s `platformConfig`. Do not remove `open-login-window`, `check-cookie-status`, main-process platform configuration, or the XHS profile page login handler.

- [x] **Step 2: Update Xiaohongshu recovery guidance**

Replace guidance that sends users to “登录平台账号” with guidance that sends them to “小红书主页提取” for the XHS retry and profile paths.

- [x] **Step 3: Run the renderer contract test and verify GREEN**

Run:

```powershell
node --test --test-concurrency=1 tests/renderer-integration.test.js
```

Expected: the unified login page has no Xiaohongshu entry and the profile page still owns the login call.

### Task 4: Verify runtime behavior and Windows x64 delivery

**Files:**
- Generated: `dist-react/**`
- Generated: `release/win-unpacked/**`
- Generated: `release/*Setup-1.0.1.exe`

- [x] **Step 1: Run syntax and full regression tests**

Run Node syntax checks for `main.js`, `preload.js`, and `preload-login.js`, followed by `tests/all.test.js`.

Expected: zero syntax errors and all tests pass.

- [x] **Step 2: Build the React production bundle**

Run `npm run build:react` with Node 22.12 or newer.

Expected: Vite build succeeds.

- [x] **Step 3: Exercise source fallback IPC**

Start Electron without the Vite server in an isolated user-data directory, wait for `dist-react/index.html`, and evaluate a harmless IPC call such as `checkCookieStatus('douyin')`.

Expected: the response is not `UNTRUSTED_RENDERER`.

- [x] **Step 4: Build Windows x64 artifacts**

Run the x64 tool verifier and electron-builder with `--win --x64`.

Expected: Electron, yt-dlp, and FFmpeg are verified as x64 and the installer is regenerated.

- [x] **Step 5: Confirm the excluded legacy directory is unchanged**

Recalculate the established 205-file SHA-256 aggregate for `抖音下载器源码/` and compare it to `7EBB9455F81ED9E3C509DA349EE2AD5B536AA606DE9AE5C8335D40B4538B1825`.

Expected: count and aggregate are unchanged.

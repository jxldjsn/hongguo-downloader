# 抖音 / TikTok 多平台批量下载器（Windows 版）

<div align="center">

[![官网](https://img.shields.io/badge/官方网站-111330.com-blue?style=for-the-badge&logo=googlechrome)](https://111330.com)
[![成品软件下载](https://img.shields.io/badge/成品软件下载-111330.com-brightgreen?style=for-the-badge&logo=windows)](https://111330.com)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%2F%2011%20x64-blue?style=for-the-badge&logo=windows)](https://111330.com)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-orange?style=for-the-badge)](LICENSE)

<p>
  <b>🌐 官方网站：</b> <a href="https://111330.com"><b>111330.com</b></a> &nbsp;|&nbsp;
  <b>📥 成品软件下载：</b> <a href="https://111330.com"><b>点击前往 111330.com 获取最新安装包</b></a>
</p>

</div>

---

## 📌 软件简介

本软件是一款基于 **Electron + React + Node.js** 构建的高性能多平台桌面下载工具，专为 Windows 10/11 x64 设计。

* **官方网址**：[https://111330.com](https://111330.com)
* **成品下载**：无需繁琐配置 Node 开发环境，直接访问 [111330.com](https://111330.com) 即可下载最新打包好的 Windows 安装版。

应用的解析、队列管理、多线程下载、本地数据库和平台登录逻辑均已深度集成在客户端内，完全独立运行，无需配置外部复杂的 Python 后端服务。

---

## 🚀 核心功能

- **多平台高清无水印下载**：支持抖音、TikTok 等平台的视频、图集、音频、原画实况、直播流嗅探与单条/批量解析下载。
- **完善的下载编排与队列**：支持并发控制、暂停、继续、任务停止、失败重试及软件重启后的断点记忆恢复。
- **账号作品与主页监控**：支持主页批量采集、账号作品增量监控、收藏夹嗅探及作品评论导出（Excel/JSON）。
- **安全隔离登录**：内置沙盒登录窗口，平台登录凭据由 Windows 本地安全加密存储，保障账号凭证安全性。
- **可靠的文件完整性保证**：采用临时分片 `.part` 写入机制，完整校验无误后发布为最终媒体文件，防止残损文件入库。

---

## 💻 成品软件快速使用

如果您是普通用户，无需克隆代码或编译：

1. 打开官网：[111330.com](https://111330.com)
2. 获取最新发布的 **Windows x64 安装包（Setup.exe）**
3. 下载后双击安装，即可在桌面和开始菜单直接打开使用。

> 💡 **提示**：程序采用单实例机制，重复双击启动会自动唤醒已有窗口。

---

## 🛠️ 源码开发与构建

如果您是开发者并希望自行编译或二次开发，请按照以下步骤操作：

### 环境要求
- Windows 10 / 11 x64
- Node.js >= 22.12.0 (x64)
- npm >= 10.0.0

### 本地开发

```powershell
# 1. 克隆代码仓库
git clone https://github.com/327044572/douyin-downloader.git
cd douyin-downloader

# 2. 安装依赖
npm install

# 3. 启动开发模式（同时运行 Vite 前端和 Electron 客户端）
npm run dev
```

也可以分别运行两个终端：
```powershell
# 终端 1：运行前端 Vite 服务
npm run dev:react

# 终端 2：运行 Electron 客户端
npm start
```

### 离线检查与打包

```powershell
# 执行离线语法、测试与 React 构建检查
npm run check

# 打包生成 Windows x64 NSIS 安装包
npm run build:win
```

> 打包输出位于 `release/` 目录。

---

## 📂 项目结构说明

```text
├── main.js                  # Electron 主进程、IPC 消息总线与下载编排
├── preload.js               # 安全渲染进程 IPC 桥接
├── preload-login.js         # 内置登录窗口隔离预加载脚本
├── src/
│   ├── components/          # React 页面 UI 组件库
│   ├── native/              # Node.js 本地解析引擎、SQLite 数据库及下载模块
│   └── utils/               # 工具函数与格式化模块
├── assets/                  # 运行辅助资源与 yt-dlp.exe 工具
├── build/                   # 打包构建配置、应用图标与校验脚本
├── tests/                   # 本地离线回归测试集
├── dist-react/              # React 前端生产打包输出
└── release/                 # 客户端安装包输出目录
```

---

## ⚠️ 使用须知与免责声明

1. 本项目仅供学习、技术研究以及个人备份自己合法拥有的内容使用，严禁用于任何商业侵权或非法用途。
2. 平台页面与加密签名算法可能会随时间调整升级，请以官网 [111330.com](https://111330.com) 发布的最新更新为准。
3. TikTok 等海外平台功能需在本机网络具备对应访问条件下使用。

---

## 📄 开源许可证

本项目基于 [GPL-3.0](LICENSE) 开源协议发布。

**官网支持与更新**：[111330.com](https://111330.com)

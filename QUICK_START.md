# 快速开始

- **官方网站**：[111330.com](https://111330.com)
- **成品软件下载**：[111330.com](https://111330.com)

本项目是 Electron + Node.js 客户端，只支持 Windows 10/11 x64。如需直接使用成品软件，请前往官网 [111330.com](https://111330.com) 下载；如需本地开发或自行编译，请参考下方说明。


## 开发运行

先安装 Node.js 22.12 或更高 x64 版本，在本项目目录打开 PowerShell：

```powershell
npm install
npm run dev
```

如果希望分别查看两个进程，可打开两个终端：

```powershell
npm run dev:react
```

```powershell
npm start
```

## 本地检查

```powershell
npm run check
```

该命令会检查主进程和预加载脚本、运行离线测试，并构建 React 生产页面。

## 生成安装包

```powershell
npm run build:win
```

这个命令只生成 Windows x64 NSIS 安装包，并在打包前检查 Electron、yt-dlp、ffmpeg 的架构。结果位于 `release/`。

## 常见问题

- 页面未加载：确认 Vite 终端仍在运行，开发地址应为 `http://localhost:3000`。
- 第二次启动没有新窗口：这是单实例设计，已有窗口会被唤醒。
- 登录失效：在应用内清除对应平台状态后重新登录。
- 下载失败：检查链接、网络、代理和平台登录状态；平台接口变化也可能需要更新解析器。
- 构建提示工具不是 x64：重新安装 Node.js x64 依赖，并替换为 Windows x64 版本的外部工具。

支持范围仅为 Windows 10/11 x64；`抖音下载器源码/` 不参与启动、测试或打包。

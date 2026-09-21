# VanNav 管理扩展（Chrome）

为 [VanNav](https://github.com/Mereithhh/van-nav) 导航站的 Chrome 管理扩展：一键收录当前页面，快捷访问前台 / 后台。

## 功能特性

- 🚀 一键添加：自动读取当前标签页的标题、URL 与图标，预填添加表单
- ⚙️ 分类同步：从后台拉取分类列表并缓存，可一键刷新
- 🔐 安全设置：Token 密码输入 + 显示切换，支持“测试连接”
- 💬 友好反馈：Toast 通知代替系统弹窗，加载态防重复提交
- 📦 离线可用：样式库本地化（vendor/pico.min.css），不依赖外部 CDN
- ⌨️ 键盘支持：Esc 快速返回主页面

## 安装

1. 下载并解压本仓库
2. 打开 Chrome `chrome://extensions/`
3. 开启右上角“开发者模式”
4. 点击“加载已解压的扩展程序”，选择本目录

## 使用

1. 点击工具栏的扩展图标
2. 首次使用会引导进入“扩展设置”，填写站点地址与 Token（在 VanNav 后台可获取）
3. 点击右上角刷新按钮同步分类
4. 在任意网页点击“添加当前页面”即可快速收录

## 截图

<div align=center ><img  src="assets/main.png" alt="主页"/></div>

<div align=center ><img  src="assets/setting.png" alt="设置"/></div>

<div align=center ><img  src="assets/addTool.png" alt="添加工具"/></div>

## 目录结构

| 文件 | 说明 |
| --- | --- |
| manifest.json | 扩展清单（MV3） |
| popup.html | 弹窗界面 |
| action.js | 弹窗逻辑 |
| styles.css | 自定义样式 |
| vendor/pico.min.css | 本地化的 Pico CSS |
| images/logo.png | 扩展图标 |

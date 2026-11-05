# MusicTap · 星海共振

> 把听歌时不自觉的抖腿，变成看得见的音画宇宙 —— Mikutap 式点击演奏 × 网易云在线曲库 & Folia 歌词演出，每次触碰都是一个音符与一片星海。

MusicTap 是一个纯前端、无构建的网页音画作品：点击或拖拽画布即兴演奏，粒子、波纹与频谱随声音生长；接入网易云后，它又变成一个可以扫码登录、搜索歌曲、加载逐字歌词的播放器，并把这套歌词演出投射到整个星海背景里。

全部依赖已本地化，断网也能运行合成器部分。

## 预览

| 点击演奏 | 网易云播放器 |
| --- | --- |
| ![点击演奏](docs/preview-canvas.png) | ![网易云播放器](docs/preview-player.png) |

| 设置 · 歌词演出 | 欢迎页 |
| --- | --- |
| ![设置](docs/preview-settings.png) | ![欢迎页](docs/preview-home.png) |

## 功能特性

**演奏与视觉**

- 鼠标点击 / 拖拽连续发声，Y 轴映射音高、X 轴映射声像
- QWERTY / ASDF 键盘演奏，全键盘随机触发
- 6 种实时合成音色：泛音叠加、正弦波、方波、三角波、锯齿波、白噪声（纯 Web Audio API，零音频素材）
- 粒子物理（密度 / 寿命 / 初速 / 引力）、波纹、连线星座、环形频谱
- 背景模式 6 种：通用、隐现、莫奈、漫游、空、穿梭
- 中心特效 5 种：流体核心、曼陀罗、粒子星环、音频多面体、关闭
- 重力场、鼠标斥力、FlowField 流场、Mesh 重组、Metaball、Bloom 等 13 个可独立开关的特效

**网易云音乐**

- 扫码登录，Cookie 本地保存
- 搜索歌曲、读取我的歌单、播放本地音频文件
- LRC / 增强 LRC / YRC 逐字歌词、翻译字幕、下一句提示、关键词着色
- 队列模式：顺序 / 随机 / 单曲循环
- AI 主题：根据封面主色与歌词情绪生成配色与粒子参数
- 正在播放的歌曲在曲库列表中高亮，并带呼吸灯提示

**歌词演出**

- 14 种演出模式：关闭、经典单行、逐字点亮，以及从 Folia 移植的 11 种场景
- 其中 7 种为沉浸式（浮名、莫奈、回环、镜台、时计、商籁、凝彩），会覆盖画布只保留歌词与氛围
- 通用参数（字体 / 字号 / 透明度）与逐模式参数，实时生效
- 模组系统：`mods/<id>/mod.js` 即插即用，内置 `sample-glow`（声光歌词）与 `wave-light`（动感波光）

**界面与可访问性**

- 玻璃质感双卡片：网易云播放器（舞台 + 340px 控制轨 + 传输台）与设置（7 项左导航）
- 两窗互斥打开、播放不中断；播放器头部可直接进入设置
- 打开窗口时用兄弟节点 `inert` 隔离焦点，关闭后焦点归还触发按钮
- 设置导航支持 ↑↓ / ←→ / Home / End，队列与抽屉用 `aria-expanded` 表达状态
- 尊重 `prefers-reduced-motion`，小屏时右侧栏变为底部抽屉

## 快速开始

### 方式一：直接打开

用浏览器打开 `index.html` 即可体验点击演奏（无需联网，无需构建）。

### 方式二：本地服务器（推荐）

```bash
python -m http.server 8080
# 浏览器访问 http://localhost:8080/
```

### 可选：启用网易云在线曲库

播放器通过本地 [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) 访问网易云接口，默认地址 `http://localhost:3000`：

```bash
git clone https://github.com/Binaryify/NeteaseCloudMusicApi.git
cd NeteaseCloudMusicApi
npm install
node app.js
```

启动后在页面打开「网易云播放器 → 扫码登录」，即可搜索、加载歌单与歌词。

- 若后端端口不是 3000，修改 `js/netease.js` 顶部的 `API_BASE`
- 播放器需要浏览器允许自动播放（首次点击页面后才会有声音）
- 未启动后端时，点击演奏、背景与歌词演出等离线功能不受影响

## 操作说明

| 操作 | 效果 |
| --- | --- |
| 鼠标点击画布 | 触发音效 + 粒子爆发 + 波纹 |
| 鼠标拖拽 | 连续发声，持续喷射粒子 |
| 键盘 QWERTY / ASDF | 模拟钢琴演奏 |
| Y 轴位置 | 映射音高（上高下低） |
| X 轴位置 | 映射声像（左右声道） |
| 工具栏 ♪ | 打开网易云播放器 |
| 工具栏 ⚙ | 打开设置 |
| 工具栏 ? | 关于 |
| ESC | 关闭当前窗口 |

## 目录结构

```
MusicTap/
├── index.html            # 单页入口（欢迎页 / 画布 / 设置 / 播放器 / 关于）
├── css/
│   └── utatap.css        # 全部样式（含玻璃卡片与响应式）
├── js/
│   ├── main.js           # 主控制器：场景、事件、设置、窗口焦点
│   ├── audioEngine.js    # Web Audio 合成音色
│   ├── djFxEngine.js     # BGM 音序器与 FX 总线
│   ├── particleSystem.js # 粒子物理
│   ├── rippleEffect.js   # 波纹
│   ├── spectrumVisualizer.js
│   ├── parallaxStarfield.js
│   ├── bgLayer.js        # 背景模式系统
│   ├── coreLayer.js      # 中心特效
│   ├── flowField.js / meshReformer.js / metaballRenderer.js
│   ├── lyrics.js         # LRC / 增强 LRC / YRC 解析
│   ├── lyricTiming.js    # 行结束时间与逐字时序
│   ├── lyricStage.js     # 歌词演出渲染层
│   ├── visualizerRegistry.js
│   ├── builtinLyricModes.js  # 11 种 Folia 演出场景
│   ├── lyricTunings.js   # 通用 / 逐模式参数
│   ├── modHost.js        # 模组宿主
│   ├── netease.js        # 网易云 API 封装
│   ├── player.js         # 播放队列与歌词同步
│   ├── player-ui.js      # 播放器 UI 绑定
│   └── themes.js
├── mods/
│   ├── sample-glow/      # 示例模组：声光歌词
│   └── wave-light/       # 动感波光模组
├── vendor/               # jQuery / PIXI / pixi-filters（本地化）
├── docs/                 # README 预览图
├── LICENSE
└── README.md
```

## 技术栈

| 层 | 选择 |
| --- | --- |
| 渲染 | PIXI.js v6（WebGL），自研插值动画 |
| 音频 | Web Audio API 实时合成 + AudioBufferSourceNode / MediaElementSource |
| 后处理 | pixi-filters（Bloom） |
| DOM | jQuery 3.6，无框架、无构建、经典 `<script>` |
| 歌词 | LRC / 增强 LRC / YRC 解析 + 自研时序与演出注册表 |

## 部署

仓库根目录即静态站点，可直接启用 GitHub Pages：

1. Settings → Pages → Source 选择 `Deploy from a branch`
2. Branch 选 `main`，目录选 `/ (root)`
3. 打开 Pages 给出的地址即可

网易云功能需要自行部署后端并把 `js/netease.js` 中的 `API_BASE` 指向它（或使用同源反向代理）。

## 已知限制

- 网易云接口依赖第三方后端，部分网络环境下登录态会被风控，需要重试或调整 `realIP` 参数
- 在线播放要求后端能返回可用的 `song/url`，VIP / 版权受限歌曲可能无法播放
- 移动端横向空间有限，播放器右侧控制栏会改为底部抽屉
- 歌词演出对性能敏感，低端设备建议在设置中开启「性能模式」

## 致谢

本项目站在这些作品与项目的肩膀上：

- [uta-tap](https://github.com/MrXiaoM/uta-tap) —— 点击演奏与 UI 框架的原型，本项目在其基础上重构了视觉系统与歌曲播放能力
- [Mikutap](https://aidn.jp/mikutap/)（daniwell / Aidn）—— 点击即演奏的交互范式
- [folia-major](https://github.com/Masterq8/folia-major) —— 歌词演出与模组系统的设计参考
- visualizer52hz、wave-light —— 歌词演出模组来源
- [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) —— 网易云接口服务

README 中的播放器截图使用演示数据，非真实账号内容。

## 许可证

本项目基于 uta-tap 改造，沿用 [AGPL-3.0](LICENSE) 许可证。你可以自由使用、修改与分发，但衍生作品与网络服务也需要以相同许可证开源。

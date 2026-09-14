# 码间摸鱼 · Moyu Code Reader

面向 VS Code 的番茄小说阅读扩展，以**原生阅读、代码伪装与 Codex 上下文交互**为核心功能。正文采用只读文本编辑器，支持原生主题、行号、缩略图、选区与查找，并提供多章合并和阅读进度恢复。

[下载安装](https://github.com/Xinyue-QwQc/moyu-code-reader/releases/latest) · [完整使用指南](docs/reading-guide.md) · [改动记录](CHANGELOG.md) · [上游项目](https://github.com/zwb8926/fanqie-novel-vscode)

> 本项目基于 [zwb8926/fanqie-novel-vscode](https://github.com/zwb8926/fanqie-novel-vscode) 开发，保留 Fork 关系与 MIT 许可，由维护者独立发布。代码实现、测试与文档编写使用 **OpenAI Codex 辅助**。

## 核心功能

### 原生阅读

- 使用 **VS Code 原生只读文本编辑器**展示正文，翻章、目录和阅读设置集中在底部状态栏。
- 每页可合并 **1–50 章**，默认自动折行、原段落之间空一行。重新打开阅读页或调整每页章节数时，保留章节与章内位置。
- 提供**已安装字体选择器**，点击即可应用。列表按正文区分中文与非中文，中文字体依据实际字形覆盖筛选。
- 提供**隐藏文本光标**选项，同时关闭光标所在行的背景、边框和行号区高亮。点击正文、方向键移动及切章后保持该设置，鼠标指针与选区高亮保留。
- 侧边栏采用响应式布局，适配较窄的显示区域。切换侧边栏后保留当前页面、搜索草稿和滚动状态。

### 代码伪装

代码伪装依据固定规则，将叙述、对白、数字和词组映射为当前代码主题中的语法配色。**正文与原生缩略图同步显示多种颜色**，形成接近代码文件的视觉结构。

| 模式 | 配色方式 | 适用场景 |
| --- | --- | --- |
| 关闭（默认） | 常规正文配色与柔和对白高亮 | 常规阅读 |
| 平衡 | 叙述按词组分色，保留整段对白配色 | 兼顾可读性与代码风格 |
| 强伪装 | 提高分色密度，对白参与词组分色 | 强化代码风格的视觉呈现 |

在阅读页 **设置 → 实验性代码伪装配色** 中选择模式。该功能仅调整显示颜色，保留小说原文以及复制、查找和 AI 读取所使用的文本；关闭后恢复原有阅读配色。

![代码伪装配色与原生彩色缩略图](docs/images/code-camouflage.png)

*维护者提供的实际阅读界面，展示代码伪装配色、自动折行、段间空行与原生彩色缩略图。*

代码伪装的功能范围为编辑器外观调整。书名、章节名和正文仍可辨认，截屏与录屏会记录实际显示内容。使用时应遵守所在环境的相关规定。

### Codex 上下文交互

- **选区附件**　在正文中选中文字，右键选择 **发送选中文字到 Codex**。扩展将选区保存为本地快照并加入 Codex 会话附件，快照内容在后续选择操作中保持固定。
- **阅读上下文**　点击状态栏 **AI → 提供当前上下文给 Codex**。附件包含当前书籍、章节、可见正文及本地读取入口。Codex 可根据用户问题按需读取其他章节或检索其他书籍，当前阅读页及其进度保持原状。

扩展会预先检测 Codex 的安装情况与附件能力，并在条件满足时显示对应的右键入口。点击操作仅添加上下文附件，**聊天提交和模型调用由用户另行发起**。上下文交接使用现有附件命令与插件提供的本地读取入口；模型的读取时机和回答由 Codex 自身控制。

上下文添加后，可提交以下分析任务。

- 分析选中对话中人物的动机，并引用原文说明依据。
- 比较前后两章对同一人物的描写，将分析范围限定在已读章节。
- 根据目录定位指定事件相关的章节，按需读取并整理事件经过。

![Codex 选区附件入口](docs/images/codex-selection.png)

*隔离测试环境中的选区附件入口。Codex 的登录与模型服务按其自身配置使用。*

支持本地文件与终端访问的其他 AI 工具，可通过状态栏 **打开上下文文件**获取材料。对接 VS Code Language Model Tools API 的客户端还可调用插件提供的原生阅读工具。具体用法见[完整使用指南](docs/reading-guide.md#让-codex--其他-agent-读取小说)。

## 分支改动

本分支保留上游提供的书城、搜索、扫码登录、书架、历史记录与书评能力，重点增强阅读载体、代码风格配色和 AI 上下文交接。

| 方向 | 主要改动 |
| --- | --- |
| 阅读载体 | 将 Webview 正文改为原生只读文本编辑器，支持原生查找、复制、分屏、滚动与缩略图 |
| 代码伪装 | 新增平衡与强伪装语义分色，正文和缩略图同步显示，保留原文 |
| Codex 交互 | 新增选区附件、当前阅读上下文及本地只读访问入口，支持按需读取其他章节 |
| 长篇续读 | 支持多章合并、原生目录、章内光标与视口恢复，以及布局调整后的位置保留 |
| 阅读排版 | 默认折行与段间空行，新增语言筛选字体选择器及独立行高、段距与配色 |
| 右键操作 | 新增字体选择、阅读页刷新、文本光标显示切换，以及按条件展示的 Codex 入口 |
| 侧边栏稳定性 | 新增窄栏响应式布局与视图状态保留，合并重复请求，按条目更新阅读进度 |
| 测试覆盖 | 增加单元测试、真实 VS Code 集成测试、重启续读验证及 Codex 附件交接测试 |

界面示例包括[窄侧边栏](docs/images/narrow-sidebar.png)与[字体选择器](docs/images/font-picker.png)。

## 安装与使用

1. 从[本仓库 Releases](https://github.com/Xinyue-QwQc/moyu-code-reader/releases/latest)下载 `.vsix` 文件。
2. 在 VS Code 扩展视图右上角选择 **… → 从 VSIX 安装**，选取安装包并按提示重载窗口。
3. 打开活动栏 **番茄小说**，通过书城、搜索、书架或历史记录选择书籍。
4. 根据阅读需求设置字体、每页章节数和代码伪装模式；使用 AI 分析时，通过正文右键或状态栏交接上下文。

### 版本兼容性

本分支保留原扩展标识 `zwb8926.fanqie-novel`，用于延续已有书架、设置和阅读进度。安装本仓库的 VSIX 会替换同标识版本，同一扩展标识仅保留一个已安装版本。本分支通过个人 Fork 的 GitHub Release 发布，与上游 Marketplace 发行分别管理。

原生阅读和代码伪装可独立使用。使用 Codex 交互功能时，需另行安装并配置 [Codex IDE 扩展](https://developers.openai.com/codex/ide)。

## 分支管理

| 分支 | 用途 |
| --- | --- |
| [`moyu-codex`](https://github.com/Xinyue-QwQc/moyu-code-reader/tree/moyu-codex) | 默认增强分支，包含原生阅读、代码伪装与 Codex 交互改动 |
| [`main`](https://github.com/Xinyue-QwQc/moyu-code-reader/tree/main) | 创建 Fork 时保留的上游主分支基线，用于版本对照与后续同步 |

本地开发以 `upstream` 指向原仓库、`origin` 指向个人 Fork。增强改动推送至 `origin/moyu-codex`，上游更新按需手动合并。

## AI 辅助开发

本分支由 **[Xinyue-QwQc](https://github.com/Xinyue-QwQc)** 发起维护，使用 **OpenAI Codex** 辅助需求整理、代码实现、问题排查、测试和 README 编写。提交记录中的 `Codex <codex@local.invalid>` 用于标识本地 AI 辅助提交。

功能说明以实际实现和可复现测试为依据，维护者负责功能取舍、结果复核与后续维护。本项目为个人维护的第三方扩展，非 OpenAI、番茄小说或上游作者的官方发行。上游代码及依赖项目保留各自的作者署名与许可。

## 构建与验证

```sh
git clone --branch moyu-codex https://github.com/Xinyue-QwQc/moyu-code-reader.git
cd moyu-code-reader
npm ci
npm test
npm run test:integration
npm run package
```

- `npm test` 运行文本保留、语义配色、字体筛选、权限边界和状态写入等单元测试。
- `npm run test:integration` 在独立用户数据目录下启动真实 VS Code，使用原创离线样章验证界面、右键操作、200–480 px 窄栏、文本光标与当前行高亮控制、切章及重启续读。
- Codex 附件测试需将环境变量 `FANQIE_CODEX_EXTENSION` 设置为已安装 Codex 的目录，再运行集成测试。测试范围限定为附件交接。
- 字体枚举分别提供 Windows、macOS 和 Linux 实现。当前发布主要在 **Windows 与 VS Code** 环境验证，其他系统的兼容性仍需进一步验证。Linux 字体列表依赖 `fontconfig` 提供的 `fc-list`。

## 隐私与权限

- 正文快照与上下文文件在本地生成，经用户主动操作交接给 AI 客户端。对话提交、模型选择及后续使用由用户控制。
- 登录 Cookie 独立保存在认证层，AI 附件仅包含阅读材料与上下文信息。实时读取入口限定为本机回环地址，并使用会话令牌进行访问校验；关闭 AI 阅读访问可停用该入口。
- 阅读材料来自番茄平台，访问范围以官方允许读取的内容及用户已取得的权限为准。
- 使用范围以个人阅读和学习研究为主，遵守内容平台条款与所在环境的使用规则。

## 致谢与许可

- 上游项目为 [zwb8926/fanqie-novel-vscode](https://github.com/zwb8926/fanqie-novel-vscode)，保留原始版权声明。
- 字体字符表参考 [ying-ck/fanqienovel-downloader](https://github.com/ying-ck/fanqienovel-downloader) 与 [fysh1010/mcp-server-fanqie](https://github.com/fysh1010/mcp-server-fanqie)。
- 接口研究参考 [naiyQAQ/fanqie-assistant](https://github.com/naiyQAQ/fanqie-assistant)。

项目代码采用 [MIT License](LICENSE)。小说内容的版权归属与使用条件遵循其权利人的授权。

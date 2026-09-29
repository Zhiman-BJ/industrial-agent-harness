# 通用文件 Viewer

CSV/TSV、JSON、JSON Lines、Markdown 与 TXT/LOG 通过 `packages/viewer-builtin/src/documents` 的只读插件接入。它们不声明 Domain、Capability、Skill 或 MCP 工具，在各领域项目里都可从普通文件树打开。专用 Viewer 优先：Yosys 网表继续进入网表视图，`.sprite.json` 继续进入图集；普通配置文件中的 `modules` 字段不会单独触发网表。

## 当前范围

| Viewer | 输入 | 当前交互 |
| --- | --- | --- |
| Table | `.csv`、`.tsv` | 表格显示、首行表头开关、全文单元格筛选、每页 100 行、原文入口；保留引号内分隔符、换行、双引号、空字段、前导零和大数 ID |
| JSON | `.json` | 按对象/数组折叠，节点显示类型与数量，每个分支分页 50 项，原文入口；支持顶层标量 |
| JSON Lines | `.jsonl`、`.ndjson` | 按源行号查看记录，每页 20 条，沿用 JSON 结构视图和原文入口；忽略空行，解析失败指出真实行号 |
| Markdown | `.md`、`.markdown` | 标题、列表、引用、代码块、GFM 表格与任务列表，原文入口；HTML 不执行，链接显示为文本，图片显示说明，不加载本地或远程嵌入资源 |
| Text | `.txt`、`.log` | 行号、换行开关、全文行筛选、每页 200 行 |

源码、配置文件和其他格式继续使用已有源码预览。此批不解析 YAML/TOML/XML、不预览任意 HTML/SVG、不加载 PDF/Office/音视频文件，也不引入编辑和保存动作。

CSV/TSV 第一行默认作为表头，可取消该选项查看无表头数据。列数不一致会提示，缺失单元格显示为 `—`；不推断数据类型、不执行公式。JSON 结构视图采用 JavaScript 数值表示；发现无法精确表示的数字时提示并默认显示原文。结构视图中超过 500 字符的单个值缩略展示，完整值保留在原文中。无效 CSV/JSON/JSONL 不展示部分解析结果，明确报错并提供完整原文；Markdown 解析树超限或渲染器加载失败也会提示并切回原文。

## 统一导航

五种通用 Viewer 复用 `ViewNavigation`，支持工作区的放大、缩小、Fit、全屏和 Esc 退出。文档缩放为 50%–300% 阅读比例；Fit 恢复 100% 并回到左上角。画布内滚轮或触控板捏合缩放，Shift+滚轮及滚动条用于滚动。全屏不卸载 Viewer，保留筛选、分页、折叠、模式和缩放状态。切换文件或项目后清理旧导航；加载和读取失败时不提供有效缩放控制器。

## 文件与性能边界

文件必须位于当前 Project 的真实目录内，通过 Artifact ID 读取并校验 SHA-256；打开时再次确认文件身份与完整快照，拒绝越界或被替换的符号链接。输入为 UTF-8，支持 BOM；二进制和其他编码明确拒绝，不替换乱码或静默截断。全部通用输入上限 4 MiB、100,000 行；Markdown 进一步限制为 256 KiB，解析树上限 20,000 节点、64 层。CSV/TSV 上限 100,000 行、256 列、250,000 个单元格；JSON/JSONL 累计上限 100,000 节点、64 层。超过限制提示使用外部编辑器。

大表、长文本和 JSON 记录按页渲染；JSON 子节点仅在展开后挂载。筛选扫描受限文件中的全部数据，并重置不适用的页码。Markdown 渲染器只在打开 Markdown 时加载，缩放不重复解析。界面只产生临时显示状态；内容展示、Artifact 观察和来源哈希都不构成工业验证。

Markdown 使用固定版本 `react-markdown` 10.1.0 与 `remark-gfm` 4.0.1，保留包许可证；通过 React 文本节点渲染，不使用 `dangerouslySetInnerHTML`。接口与 GFM 支持参考上游 [react-markdown](https://github.com/remarkjs/react-markdown) 和 [remark-gfm](https://github.com/remarkjs/remark-gfm)。

## 验证入口

```bash
pnpm --filter @industrial-agent-harness/viewer-builtin test
pnpm test:architecture
pnpm --filter @industrial-agent-harness/desktop build
pnpm --filter @industrial-agent-harness/desktop test:documents
```

模块测试覆盖真实文件快照、CSV 转义、JSON/JSONL 错误与资源上限、编码、哈希变化、项目和符号链接边界，以及专用 JSON 优先级。桌面自测使用隔离应用数据和临时项目，经生产文件树、IPC、Registry 与实际 DOM 验证五种 Viewer 的导航、筛选分页、全屏状态、Markdown 隔离和超限原文回退、错误原文与项目切换；测试不调用模型、不修改用户项目或配置。2026-09-28 已完成 macOS Electron 实测：按钮和实际内容尺寸、滚轮/捏合、Fit、全屏及 Esc、JSON 折叠状态和精度提示、CSV 表头与筛选、文本换行与分页、JSONL 记录、Markdown 的 BOM/GFM 和零外部请求均通过。完整模块测试为 88 通过、4 项可选环境跳过，10 项架构检查及桌面构建通过；Linux、Windows 与打包发行流程尚未验证。

可直接绑定的原创示例见 [通用文件 Viewer 示例](../examples/document-viewers/README.md)。

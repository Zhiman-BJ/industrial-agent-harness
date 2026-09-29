# Built-in Viewers

这里是正式的内置 Viewer 实现路径。首批直接迁入并使用三种 EDA Viewer：

| 模块 | 渲染能力 |
| --- | --- |
| `src/layout` | KLayout Python `LayoutView` 按视口渲染 GDS |
| `src/netlist` | netlistsvg 在独立 worker 中渲染 Yosys JSON 网表 |
| `src/waveform` | 本地 Surfer WASM 通过受限页面查看 VCD 等波形 |
| `src/assets` | 图片、Sprite 图集与动作动画；有界只读资源解析与 Canvas 预览 |
| `src/kicad` | 本地 KiCanvas 隔离 iframe、KiCad 板图/原理图和多页配套文件校验 |
| `src/godot` | Godot Web Export 隔离 iframe、会话资源管理和 Viewer Bridge |
| `src/documents` | 不依赖 Domain 的 CSV/TSV、JSON、JSONL/NDJSON、Markdown、TXT/LOG；只读、原文入口、有界解析与分页 |

`src/api.ts` 定义桌面 Viewer Host 当前需要的接口，`src/viewer-styles.css` 保留 demo 工作台及 Viewer 样式。`fixtures/` 是明确标识的参考数据；`tests/` 检查渲染和文件访问边界。运行：

```bash
pnpm --filter @industrial-agent-harness/viewer-builtin test
```

生产调用必须先由桌面端把用户选定的项目与 Artifact ID 解析、校验为本地只读文件，再交给这些模块。Viewer 只产生显示数据和临时视图状态，不修改工程资产或验收结果。Godot V1 运行 Web Export 预览，不提供工程编辑；完整编辑仍由 Godot 承担。

接入说明见 [EDA Viewer 参考](../../doc/viewer-eda-reference.md)，通用约束见 [Viewer 层设计](../../doc/viewer-layer.md)。
Godot 导出和桥接说明见 [Godot Viewer V1](../../doc/godot-viewer.md)。
仓库内 [Godot Playground](../../examples/godot-viewer/README.md) 提供源项目和导出脚本；真实 Web 运行时与 Viewer 控制已在 macOS Electron 实测。

图片、图集和动作预览说明见 [素材 Viewer](../../doc/godot-assets-viewers.md)。

PCB 项目内 KiCad 文件的使用、限制与本地运行时来源见 [KiCad Viewer V1](../../doc/kicad-viewer.md)。

八种领域与素材 Viewer（版图、网表、波形、Godot、图片、图集、动画、KiCad）及五种通用文件 Viewer 通过 `src/navigation.tsx` 的 `ViewNavigation` 注册缩放与 Fit。工作区统一呈现缩小、放大、适配和全屏入口；加载期间禁用缩放，切换文件时移除旧控制器。新接入的 Viewer 应实现同一接口，并在真实渲染路径验证按钮、滚轮/捏合和全屏。百分比以当前 Fit 为 100%，波形使用时间轴语义。Godot 放大已挂载的预览，不修改场景相机。通用文档的 Fit 恢复 100% 阅读比例；格式、上限与来源边界见 [通用文件 Viewer](../../doc/document-viewers.md)。

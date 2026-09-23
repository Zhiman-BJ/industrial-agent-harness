# Built-in Viewers

这里是正式的内置 Viewer 实现路径。首批直接迁入并使用三种 EDA Viewer：

| 模块 | 渲染能力 |
| --- | --- |
| `src/layout` | KLayout Python `LayoutView` 按视口渲染 GDS |
| `src/netlist` | netlistsvg 在独立 worker 中渲染 Yosys JSON 网表 |
| `src/waveform` | 本地 Surfer WASM 通过受限页面查看 VCD 等波形 |

`src/api.ts` 定义桌面 Viewer Host 当前需要的接口，`src/viewer-styles.css` 保留 demo 工作台及 Viewer 样式。`fixtures/` 是明确标识的参考数据；`tests/` 检查渲染和文件访问边界。运行：

```bash
pnpm --filter @industrial-agent-harness/viewer-builtin test
```

生产调用必须先由桌面端把用户选定的项目与 Artifact ID 解析、校验为本地只读文件，再交给这些模块。Viewer 只产生显示数据和临时视图状态，不修改工程资产或验收结果。CAD 和 Godot 等复杂软件将只预览关键产物，完整编辑仍由专业软件承担。

接入说明见 [EDA Viewer 参考](../../doc/viewer-eda-reference.md)，通用约束见 [Viewer 层设计](../../doc/viewer-layer.md)。

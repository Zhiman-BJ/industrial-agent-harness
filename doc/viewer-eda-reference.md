# EDA Viewer 参考实现

版图、网表和波形 Viewer 是 `packages/viewer-builtin/src/` 中的正式产品模块。本页把它们作为后续领域 Viewer 接入时的参考，不将源码放在 `examples/` 目录。桌面端直接调用这些模块，并通过已登记的 Artifact 身份控制输入。

| Viewer | 当前代码 | 渲染接口 | 核心输入 |
| --- | --- | --- | --- |
| 版图 | `src/layout` | KLayout Python `LayoutView`、`zoom_box`、`get_pixels_with_options` | GDS 与视口、图层 |
| 网表 | `src/netlist` | `netlistsvg.render` | Yosys `write_json` |
| 波形 | `src/waveform` | 本地 Surfer WASM 与受限消息桥 | VCD 等波形 |

这些实现来自先前 Silicon Lens / EDA Harness demo 的 Viewer 链路。保留了按视口渲染、独立 worker、iframe 隔离、输入界限和明确加载状态等做法。源代码迁移说明见 [来源记录](viewer-provenance.md)。

`fixtures/counter.json` 与 `counter.vcd` 用于网表和波形检查；版图检查使用 KLayout 临时生成的小 GDS。另有一份真实 FIFO GDS 随桌面端提供演示预览。它与 counter 网表、波形是不同设计，界面必须分开标识，不能建立虚假的跨视图映射。

```bash
pnpm --filter @industrial-agent-harness/viewer-builtin test
```

设置 `KLAYOUT_PYTHON` 为安装了 KLayout 的 Python 路径后，上述检查也会验证真实 GDS 的视口渲染。Surfer 的 JS/WASM 资源保留在 `src/waveform/surfer`，许可证、来源和哈希见该目录的 NOTICE 与资产清单。上游将部分消息命令标为可能变化，升级 Surfer 时须验证桥接行为。

后续 Viewer 接入应先声明产物类型与配套输入，再实现受限解析/渲染，最后接入 Viewer Host 的来源显示和失败状态。完整边界见 [Viewer 层设计](viewer-layer.md)。

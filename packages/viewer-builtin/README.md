# Built-in Viewers

在 Harness 桌面端内部展示适合直接查看的工程产物。候选包括波形、网表、GDS/DEF 局部版图、PCB 关键视图、报告和图像。大型产物按视口、层级或时间范围读取，不整文件注入 UI。

已迁入三组 [EDA Viewer 示例](examples/eda/README.md)：KLayout 版图、netlistsvg 网表和 Surfer 波形。它们保留原有 React 视图、解析/渲染适配以及必要的第三方资源，作为后续 Viewer 接入的参考；尚未连接新桌面端的 Artifact registry。运行示例检查：

```bash
pnpm --filter @industrial-agent-harness/viewer-builtin test:examples
```

CAD 和 Godot 等复杂软件只预览关键产物，例如模型快照、场景截图、导出几何、检查报告与运行捕获；完整编辑和复杂交互仍由专业软件承担。

内置渲染器只产生显示数据和临时视图状态，不修改原始工程资产或验收结果。设计与约束见 [Viewer 层设计](../../doc/viewer-layer.md)。

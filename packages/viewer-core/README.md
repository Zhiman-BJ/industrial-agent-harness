# Viewer Core

Viewer 层的领域无关契约与选择机制。它接收已登记的 Artifact 引用、类型、所属 Run/State、内容哈希和必要的配套产物，选择可用的内置预览或受控的外部查看方式。Viewer Core 不读取任意项目路径，不执行工业 Action，也不写入 Verification 或原始 Artifact。

`src/index.ts` 定义初始契约：产物引用、Viewer 描述、打开请求、显示状态和派生显示来源。`src/registry.cjs` 现提供最小的 Viewer Plugin 注册、匹配和查找；具体格式判断和打开行为由桌面端注册的插件实现。持久化 Artifact Registry、可用性探测与完整 Viewer Core 仍未实现。

计划提供能力发现、查看器选择、项目/状态绑定、派生缓存身份及跨视图对象引用。显示缓存的键需要覆盖源产物与配套产物哈希、转换器版本和参数；映射缺失时不猜测连通关系。

具体契约和安全边界见 [Viewer 层设计](../../doc/viewer-layer.md)。正式内置 EDA Viewer 在 [viewer-builtin](../viewer-builtin/README.md)。

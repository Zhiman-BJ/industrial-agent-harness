# VR：Viewer 与任务成果

依据：[Viewer 层](../viewer-layer.md)、[通用文件](../document-viewers.md)、[工程文件](../engineering-file-viewers.md)、[任务成果](../task-results.md)。Viewer 是只读展示，不更新 DomainState/Verification；成果选择是展示元数据。先走[协议](protocol.md)，从专用项目文件树和真实生产输出进入，不能只挂一个孤立组件。

## 自动命令

```sh
pnpm --filter @industrial-agent-harness/viewer-core test
pnpm --filter @industrial-agent-harness/viewer-builtin test
node --test packages/harness-application/tests/results.test.cjs apps/desktop/electron/result-layout.test.cjs
pnpm --filter @industrial-agent-harness/desktop build
pnpm --filter @industrial-agent-harness/desktop test:kicad
pnpm --filter @industrial-agent-harness/desktop test:godot
pnpm --filter @industrial-agent-harness/desktop test:engineering
pnpm --filter @industrial-agent-harness/desktop test:documents
```

CAD 与成果 UI 需要先完成 T4 FreeCAD 准备并导出 `INDUSTRIAL_HARNESS_FREECAD_CMD`，否则 blocked，不能把启动失败算环境 skip：

```sh
pnpm test:results
pnpm --filter @industrial-agent-harness/desktop test:cad
pnpm --filter @industrial-agent-harness/desktop test:cad-resize
pnpm --filter @industrial-agent-harness/desktop test:results
```

T4 native 包含 task-results-freecad/kimi；UI 的 test:results 当前不在 workflow 循环，cad-resize 在 industrial-core。kicad/engineering/documents 进 full 原生 UI 路径，godot 脚本不自动表示进入 CI。GDS/网表/波形导航由 ui/main 中的既有 selftest 路径及包测试覆盖；具体格式资格仍看对应 Viewer 文档。

## 手工矩阵

| ID | 步骤与预期 | 边界／失败恢复 | 必留证据 |
| --- | --- | --- | --- |
| VR-01 文件路由 | 活跃项目树依次打开已声明的 EDA、CAD、KiCad、Godot、素材及通用文件；未注册格式走源码/明确提示 | 不显示测试 fixtures 菜单；由 Registry 选 Viewer，不绕过路径与 provenance；只声明实际测过格式 | 格式/项目路径、Registry 选择、渲染截图 |
| VR-02 导航全屏 | 每类 Viewer 测 toolbar ±、wheel、pinch、Fit、比例/就绪状态、全屏进入/按钮或 Esc 退出；切换布局 | loading/error 禁用 zoom；全屏保留 mounted 视图/运行态；Godot 缩放不改 scene camera/播放；波形按时间区间 | 前后比例/视图、恢复布局、全屏截图 |
| VR-03 失败与文件边界 | 打开损坏/超限输入，跨项目路径、symlink、失效 companion/source hash；快速切项目/文件 | 明确 error/loading；旧 controller/listener/runtime 不留存；不执行脚本或修改源文件；有界读取 | 错误码、文件 hash 前后、残留会话检查 |
| VR-04 成果自动登记 | 一轮产生模型/报告，失败后部分输出，再生成多方案；不调用 select_result 仍显示成果 | 成功 Action、文件可用、Verification 分别呈现；无工程检查不能升级 passed；同名结果不合并 | request/Action/group/Artifact IDs、检查摘要与部分输出 |
| VR-05 版本/附件 | 明确修改输入后查看旧版折叠、新版、辅助报告；选历史/并列方案；文件列表打开实际附件，定位原生文件 | 只有内容绑定的 supersedes 才替代；changed/missing/unchecked 显式显示；主文件能定位但缺 companion 不可预览 | 旧新 digest、组关系、附件与错误截图 |
| VR-06 自动预览 | 前台仅一个支持预览的成功候选，结束最多开一次；分别手动换文件/项目、取消、后台完成、历史回放、多候选 | 这些情形不抢焦点或自动开外部应用；CAD/doc 插件显式 opt-in，其他不暗中加入 | 预览次数、当前 tab、抑制原因 |
| VR-07 历史与 CLI | 重启读历史，远程未配置时读缓存成果；同次读取重用校验，改 bytes 后再次读取/打开拒绝；比较 CLI JSONL | 历史读取不初始化 Runtime/Packs；CLI 同 group/Artifact/revision，无 Electron 依赖；旧工程通过不认证新 bytes | 历史/CLI IDs、变化检测、Runtime 未启动证据 |

## 自动覆盖缺口

UI fixture 不能替代目标系统的图形后端、外部依赖或打包路径；Godot Web Export 不等于完整编辑器。既有成果原生验收主要 macOS arm64 FreeCAD，其他域是否声明 presentation 看实际 owner 发布物，不按计划文档推断。大于 64 MiB 的 freshness 可显示 unchecked，打开仍须完整摘要校验；不要把未检查误读为有效。

[返回矩阵](modules.md)

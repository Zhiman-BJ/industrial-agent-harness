# VR：Viewer 与任务成果

依据：[Viewer 层](../viewer-layer.md)、[通用文件](../document-viewers.md)、[工程文件](../engineering-file-viewers.md)、[任务成果](../task-results.md)。Viewer 是只读展示，不更新 DomainState/Verification；成果选择是展示元数据。先走[协议](protocol.md)，从专用项目文件树和真实生产输出进入，不能只挂一个孤立组件。

## 自动命令

```sh
pnpm --filter @industrial-agent-harness/viewer-core test
pnpm --filter @industrial-agent-harness/viewer-builtin test
pnpm --filter @industrial-agent-harness/pack-manager test
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

| ID                   | 步骤与预期                                                                                          | 边界／失败恢复                                                                                             | 必留证据                                              |
| -------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| VR-01 文件路由       | 活跃项目树依次打开已声明的 EDA、CAD、KiCad、Godot、素材及通用文件；未注册格式走源码/明确提示        | 不显示测试 fixtures 菜单；由 Registry 选 Viewer，不绕过路径与 provenance；只声明实际测过格式               | 格式/项目路径、Registry 选择、渲染截图                |
| VR-02 导航全屏       | 每类 Viewer 测 toolbar ±、wheel、pinch、Fit、比例/就绪状态、全屏进入/按钮或 Esc 退出；切换布局      | loading/error 禁用 zoom；全屏保留 mounted 视图/运行态；Godot 缩放不改 scene camera/播放；波形按时间区间    | 前后比例/视图、恢复布局、全屏截图                     |
| VR-03 失败与文件边界 | 打开损坏/超限输入，跨项目路径、symlink、失效 companion/source hash；快速切项目/文件                 | 明确 error/loading；旧 controller/listener/runtime 不留存；不执行脚本或修改源文件；有界读取                | 错误码、文件 hash 前后、残留会话检查                  |
| VR-04 成果自动登记   | 一轮产生模型/报告，失败后部分输出，再生成多方案；不调用 select_result 仍显示成果                    | 成功 Action、文件可用、Verification 分别呈现；无工程检查不能升级 passed；同名结果不合并                    | request/Action/group/Artifact IDs、检查摘要与部分输出 |
| VR-05 版本/附件      | 明确修改输入后查看旧版折叠、新版、辅助报告；选历史/并列方案；文件列表打开实际附件，定位原生文件     | 只有内容绑定的 supersedes 才替代；changed/missing/unchecked 显式显示；主文件能定位但缺 companion 不可预览  | 旧新 digest、组关系、附件与错误截图                   |
| VR-06 自动预览       | 前台仅一个支持预览的成功候选，结束最多开一次；分别手动换文件/项目、取消、后台完成、历史回放、多候选 | 这些情形不抢焦点或自动开外部应用；CAD/doc 插件显式 opt-in，其他不暗中加入                                  | 预览次数、当前 tab、抑制原因                          |
| VR-07 历史与共享事件     | 重启读历史，远程未配置时读缓存成果；同次读取重用校验，改 bytes 后再次读取/打开拒绝；比较共享应用层事件  | 历史读取不初始化 Runtime/Packs；应用层事件同 group/Artifact/revision，无 Electron 依赖；旧工程通过不认证新 bytes | 历史/事件 IDs、变化检测、Runtime 未启动证据            |

## PCB 官方模型按需下载：本轮待验收

本矩阵是本轮接入的验证计划，不表示已有 GPU 或下载路径通过。测试使用独立项目与依赖 store；保留 Core/PCB Pack owner 发布身份、官方目录 revision、源板 SHA-256、模型引用清单、每个实际下载的原始字节 SHA-256/大小/许可、缓存身份、操作时间线和图像。目录固定为 KiCad `10.0.7` / `8d4070daa0fa3f7a7f3c176f4ca7bffc4df392be` 的 7,252 STEP、105 family；禁止把目录条目数量写成已下载或已测模型数。

| ID                     | 步骤与预期                                                                                                    | 边界／失败恢复                                                                                                   | 必留证据                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| VR-08 下载必须显式触发 | 清空专用缓存，打开源中准确引用官方 STEP 的项目，切 2D/3D、检查缺失计划；只有明确点击下载后才获取所需条目      | 打开/计划不发模型请求；不下载整库，不准备原生 KiCad 或 Docker；本地模型优先                                      | 点击前后模型网络请求清单、来源与字节数、计划/实际资源路径集合                       |
| VR-09 缓存与源身份     | 冷下载后离线重开；本地同引用文件与缓存同时存在时仍选本地；正/背面器件点选回源封装，检查颜色、旋转、显隐与展开 | 只有 host 批准的精确 sourceRef/root/path/hash/size 可读；不按名称猜模型，不改源引用、DomainState 或 Verification | 原始/缓存/model manifest 摘要、顶底截图、source UUID/footprint ID、源板前后 SHA-256 |
| VR-10 取消与失效会话   | 下载中取消、关闭 Viewer、切项目、修改源文件后等待旧下载完成；再明确重试                                       | 临时或超预算内容不 ready，不污染其他视图；旧 token/迟到结果不能附到新项目；保留既有有效缓存                      | 取消时间、会话/项目/源身份、缓存清单、错误与恢复截图                                |
| VR-11 数据与授权负例   | 专用服务返回错误 hash/size、未声明路径、越界/符号链接、损坏暖缓存；源 WRL 缺失但有同名官方 STEP               | 校验失败不显示假模型、不把 WRL 换 STEP；renderer 不能指定任意 URL/根目录；缓存损坏不在只读阶段暗中发网修复       | 失败类型、实际网络与文件访问范围、拒绝后的二维可用、一次显式恢复结果                |

保留标签另测 A→B→A 的下载准备与独立 token：关闭 B 后 A 仍能准备/查看；关闭 A 后其迟到下载不能复活。达到 16 会话或源/模型快照合计 256 MiB 上限时，新打开明确失败，已有标签继续可用；项目切换才释放全部会话。

原始模型 SHA-256 与字节数必须针对实际 STEP 内容，不能以 Git blob 身份、LFS 指针或 HTML 错误页代替；这些错误响应也须进入校验负例。目录 revision、许可及实际字节来源应可逐项追溯。

真实 video 板的 175 处引用均为旧 WRL，现有 27 个本地模型可验证兼容与真实装配，但不能替代 VR-08 的明确 STEP 引用项目。LED 示例本身无模型引用，不能靠占位形状提供实体通过证据。完整模型与图形预算仍按 [PCB 三维 Viewer](../pcb-3d-viewer.md)；网络、缓存、解析、GPU 分别记录，不能以一种 fixture 的通过覆盖其他阶段。

## GDS/OASIS 托管 Python

KLayout 依赖已通过共享管理器接入；[固定版本与接口边界](../managed-viewer-python.md)独立于 PCB 模型下载。

| ID | 步骤与预期 | 边界／必留证据 |
| --- | --- | --- |
| VR-12 独立准备 | 干净 store、无宿主 Python/Docker，点击 Install viewer support；固定解释器/wheel 校验后显示 Viewer ready | native/EDA 状态保持未准备；记录 owner commit、URL、大小/SHA、阶段与 PNG probe |
| VR-13 重开与缓存 | 真实 Sobel GDS 从项目树打开，22层、缩放/平移/图层/全屏；离线检查再重开 | 不修改源、不触网；连续 render 不重扫所有 Pack/Python 文件；记录 PNG、source SHA、解析次数 |
| VR-14 损坏与取消 | 删除专用环境模块，检查转 needs-preparation；修复中断、错误 hash/最终 probe失败，再重试 | 不误报ready；旧文件可保留但已证实损坏的runtime不可解析；staging/锁释放，暖缓存复用 |
| VR-15 路径切换 | 显式正确/错误 KLAYOUT_PYTHON、repair同路径替换、项目切换 | 无效override不回退；新open重验，旧worker关闭；缺失依赖入口能打开领域包设置，中英文一致 |
| VR-16 打包脚本 | 对本次安装包检查 ASAR 内模块与两份解包 Python 脚本；用有效 Python 从包内 RasterService 实际 load/render GDS | Python argv 必须指向 app.asar.unpacked；PNG有效，缺脚本/子进程退出有明确诊断；源码渲染不替代本项 |

离线 fixture 回归见 PythonEnvironmentManager、PackManager 集成及 Desktop dependency/selftest；真实网络诊断仅显式执行 `node scripts/verify-managed-layout.cjs /absolute/fresh/output`，不替代目标平台的文件树与 GUI 验收。

## 自动覆盖缺口

UI fixture 不能替代目标系统的图形后端、外部依赖或打包路径；Godot Web Export 不等于完整编辑器。既有成果原生验收主要 macOS arm64 FreeCAD，其他域是否声明 presentation 看实际 owner 发布物，不按计划文档推断。大于 64 MiB 的 freshness 可显示 unchecked，打开仍须完整摘要校验；不要把未检查误读为有效。

[返回矩阵](modules.md)

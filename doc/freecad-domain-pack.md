# FreeCAD CAD Pack V1

2026-10-19 远程接入：共享 Harness Runtime 已发现 `freecad-linux-cpu` 的 build/inspect/export/edit 四个工具，并通过真实远程 `cad.freecad.build` 的几何验证、产物下载和 macOS Desktop FCStd/STEP 显示。远程执行与本机安装资格分开；本轮没有模型推理，也未实际执行远程 inspect/export/edit。详情见[远程 CAD 验收](evidence/remote-cad-20261019/README.md)。

2026-10-04：首批面向 3D 零件建模。实际执行依赖官方 **FreeCAD 1.1.4 macOS arm64**；Windows/Linux 原生 CAD 执行尚未验收。Pack 包含 Harness 自有桥接代码、Skill 和固定依赖声明，不捆绑 FreeCAD 二进制。2026-10-06 起，Apple Silicon 桌面安装包内置可选 CAD Pack，选择后自动下载官方 DMG 并准备用户私有运行时；设置内可检查／修复，无需手动配置命令路径。开发源代码模式仍支持显式命令环境变量。见[分发说明](macos-cad-distribution.md)。上游来源和许可证见 [FreeCAD 1.1.4](https://github.com/FreeCAD/FreeCAD/releases/tag/1.1.4) 与 [FreeCAD license](https://github.com/FreeCAD/FreeCAD/blob/1.1.4/LICENSE)。

## 工具与执行

| 工具 | 首批能力 |
| --- | --- |
| `cad.freecad.build` | 参数配方、矩形/圆形全约束 Sketcher 草图、PartDesign Pad、长方体、圆柱、圆柱打孔、并集/差集/交集；保留原生特征树 |
| `cad.freecad.edit` | 读取经哈希绑定的原配方，修改已知命名参数或特征尺寸/草图轮廓/位置，保存新版本并验证；保留原模型 |
| `cad.freecad.inspect` | 回读受支持的 FCStd/STEP，生成几何报告和预览产物；不修改输入文件 |
| `cad.freecad.export` | 受支持的 FCStd/STEP 转换为 FCStd、STEP、STL、BREP，并通过第二个 FreeCAD 进程回读检查 |

Desktop 和 CLI 均通过 `createProjectRuntime` 加载 `freecad-local` Pack。Broker 披露规范 Tool ID；Kimi 先调用 `industrial_tool_describe` 获取选中工具的输入说明，再通过 `industrial_action_call`、当前 State ID 和审批进入持久 Runtime。它是宿主 Runtime 工具提供方，不启动独立的 CAD MCP 进程；新增 CAD 操作没有绕过 Runtime 的直连执行路径。

所有尝试保留 Run/Action/Verification；成功产物位于工程 `cad-output/<action-id>/`，失败保留已经产生的诊断与明确产物集合。原文件始终作为输入快照，输出采用新的 Action 目录。用户应将需要修改并作为新输入的模型放在工程普通目录；`cad-output` 是历史输出区，不作为源文件清单。输入源文件改变后 State 会失效，必须重新披露 Scope。

通过原生 Sketcher/PartDesign/Part 的固定操作构建模型，不提供任意 Python、宏或 Shell 执行。命名参数属于可重建配方；重新提交参数会产生新版本。原生 FCStd 保留草图约束、Pad 长度及布尔特征，可在 FreeCAD 中编辑；配方参数组是参数记录，不是自动关联的 Spreadsheet 表达式。

## 使用

安装官方 FreeCAD 1.1.4，默认发现 `/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd`；其他安装位置显式设置 `INDUSTRIAL_HARNESS_FREECAD_CMD`。受保护 Agent 当前仍只验证 macOS Apple Silicon。

在 CAD 工程中描述任务，例如「用 FreeCAD 创建 40×20×5 mm 的板，在 (10,10) 处打半径 2 mm 的通孔，并验证体积和边界尺寸」。工具输入示例：

```json
{
  "recipe": {
    "parameters": {"L": 40, "W": 20, "T": 5, "R": 2},
    "features": [
      {"id": "Plate", "op": "sketch_pad", "profile": "rectangle", "length": "L", "width": "W", "height": "T"},
      {"id": "Drilled", "op": "hole", "base": "Plate", "radius": "R", "height": "T", "origin": [10, 10, 0]}
    ],
    "result": "Drilled"
  },
  "expect": {"volume": 3937.168146928204, "bounds": [40, 20, 5], "solids": 1}
}
```

长度单位 mm，体积 mm³。配方最多 50 个特征、100 个参数；尺寸为有限正数且不超过 10000 mm。布尔操作只能引用先前特征，原点坐标受限，不接收表达式。几何预期支持体积、边界三轴尺寸、实体数和绝对容差（默认 0.00001）。不提供预期时，仅验收几何与格式一致性，报告明确指出未做设计尺寸验收。

## 回读、限制与证据

保存后启动独立 FreeCAD 进程重开 FCStd，并重新读入 STEP、STL 和 BREP。Verifier 读取收集并保存的报告，检查实体有效性、正体积、Sketcher 全约束、原模型与 FCStd/STEP/BREP 的体积/尺寸/实体数一致性、网格存在，以及用户提供的尺寸预期。进程退出成功不等于通过；尺寸错误保留输出并返回 `failed`。这些检查不证明机械强度、装配正确性、公差设计或可制造性。

输入限 16 MiB，源目录清单限 100 文件/64 MiB，FCStd 解压限 64 MiB/2000 项。FCStd 只允许本批原生特征及其基准对象，拒绝 Python 代理、Python 属性和表达式；任意插件、装配工作台及复杂既有 FCStd 不在首批范围。STEP 走 Part 原生导入。原生进程固定超时 90 秒，限制输出，取消后终止所拥有的进程组；运行目录之外禁止原生写入和网络访问。输入模型不在 Viewer 中执行。

## CAD Viewer

远程下载保留服务回执中的原始字节，以通用文件名保存。邻接的 `artifact-bundle.json` 只索引已校验产物的名称、kind、大小和 SHA-256；Viewer 先匹配模型摘要，再校验原 preview manifest 与同目录 BREP/STL/草图摘要，恢复只读预览关联。拒绝重复索引、路径穿越、跨目录符号链接和摘要不符，不改写 manifest 或伪造工程验证。

项目文件树经 Viewer Registry 选择 CAD Viewer。直接打开二进制/ASCII STL；Pack 输出的 FCStd/STEP 使用同名 BREP/STL 与 `*.cad-preview.json`，同时校验模型、曲面和网格 SHA-256。不含配套预览的 FCStd 会明确要求先运行 inspect/export；不含配套预览的 STEP 保留现有受限 STEP 预览。

只读实体显示、拖动旋转、Shift/右键拖动平移、滚轮/触控板缩放、共享缩放/Fit、全屏和 Esc；全屏保留旋转和缩放，窗口/工作区宽度与全屏变化保持模型比例；Fit 恢复初始视角。工作区分隔线可拖动或键盘调整、双击恢复默认。使用官方开源 **OCCT 7.9.2 AIS/V3d/TKOpenGles**，按上游 WebGL 示例路径编译本地 WebAssembly，以 WebGL2 显示 BREP 曲面、CAD 轮廓、深度遮挡与 4x MSAA。STL 和旧产物使用 OCCT AIS_Triangulation。文件上限 16 MiB、100000 三角形、5000 BREP 面，WASM 内存上限 512 MiB；加载失败禁用导航，切换文件释放 GPU 对象，无外部网络请求。需 WebGL2；固定来源、完整源码、许可证和重编译说明见 [OCCT renderer](../packages/viewer-builtin/src/cad/occt/README.md)。Viewer 不能编辑模型、验证装配或替代 FreeCAD。实际 Desktop 路径在 macOS arm64 Electron 验证，其他 Viewer 平台尚未实测。

## 剖切、选择、测量与草图约束

三维模型页提供 X/Y/Z 封口剖切、位置滑块和反向。切面着色只是临时显示，不创建或修改工程几何。三维页有带标尺图标的“测量”按钮；点击后默认进入“单对象尺寸”的边测量，仅在工具栏展开“测量类型”“测量对象”和“清除测量”，也可切换为面；不弹出右侧面板，尺寸直接标在模型上，开启测量不压缩模型视图区。单对象尺寸每次只保留当前对象，点击其他对象会替换旧选择；蓝色标注写明边长、直径或面积。只有显式切换为“两对象最短距离”才累计两次选择，并显示绿色最近点连线及“最短距离”数值。切换测量类型或对象模式会清空旧选择；“清除测量”恢复空状态，退出测量会清除对象和标注。网格预览禁用按钮，并明确说明无法精确测量。尺寸按选中对象显示，尚不提供整体尺寸和孔距的自动常驻标注。OCCT BREP 几何直接计算边长、圆边/圆柱面的半径和直径、面面积，以及两个选中对象之间的**最短距离**；距离端点和数值叠加在模型上，随旋转、平移和缩放更新。它不是中心距或公差验收。STL 可剖切，但没有精确拓扑选择和测量。

`model.cad-sketches.json` 由独立回读进程重开保存后的 FCStd 导出，包含原生几何、局部坐标、世界放置、真实约束索引、尺寸及完全约束状态，声明源 FCStd SHA-256。Runtime 收集为 `display.cad.sketches`；预览 manifest 同时绑定配套文件哈希，Viewer 在当前项目边界内复核来源和内容，不从配方推测草图。草图页支持矩形/圆轮廓、尺寸标注、约束列表与几何联动高亮；拖动平移、滚轮/捏合、共享缩放/Fit、全屏均保持只读。STEP 导入没有原始草图，旧预览缺少配套时禁用草图页并提示运行 inspect/export。

草图 JSON 限 1 MiB、50 张草图、每张 2000 个几何/4000 个约束、合计 10000 项；坐标/尺寸与引用均有界校验。不支持的曲线类型明确标识，不执行源文件或表达式。尺寸显示四位小数，读取模型名义几何，不处理加工公差，不替代持久 Verifier 的结果。模型页与草图页共用工具栏；切换到草图时保留三维剖切、选中对象和相机，切回时继续查看。

## 回归与 CI

`tests/integration/freecad-runtime.test.cjs` 用真实 FreeCAD 测试草图/拉伸/孔/布尔、FCStd/STEP/BREP 回读、尺寸不通过、拒绝输入与审批、State 失效、取消和历史证据，还覆盖原模型→改宽度/孔径→改圆形轮廓，以及同一 Kimi chat 中的两轮实际原生执行。CI 的模型响应固定以保证可重复，不能据此宣称真实模型推理通过。`apps/desktop/electron/cad-selftest.cjs` 从真实建模产物检查文件树→Registry→OCCT BREP 显示→旋转/平移/缩放/Fit/全屏/Esc/失败状态，并提交「修改零件的形状」验证缺少 API 配置时显示原因、保留输入、恢复发送按钮。扩展的 `cad-inspection-selftest.cjs` 通过生产指针处理器和实际 OCCT 屏幕坐标选择，核对 40 mm 边、Ø4 mm 孔、解析最短距离、剖切像素、约束高亮、草图导航、全屏/Esc 状态保留以及查看前后模型哈希不变。解析器与配方边界加入四平台 Portable 回归；CAD 独立 CLI 包加入四平台打包和 Scope 检查。

`scripts/qualify-cad-tasks.cjs` 是另行运行的真实模型验收：真实 API、固定 Kimi、真实 FreeCAD 和独立读回。三轮同一 chat 先提交「修改零件的形状」检查澄清且不执行，再改宽度/孔径，接着把上一版本改成圆板。结果必须具有正确体积、边界、BREP 产物，原件及所有历史模型的哈希保持不变；保存 report.json 和逐轮诊断。提供当前模型 profile、API key 和原生可执行路径，在新目录运行 `node scripts/qualify-cad-tasks.cjs /absolute/new-output-directory`；配置从 `HARNESS_CAD_EVAL_PROFILE` 与 `HARNESS_CAD_EVAL_KEY` 读取，不写入仓库。实际验收记录见 [真实 CAD 任务验收](cad-task-qualification-20261004.md)。

后续「继续」「刚刚的新版本」仅在同一工程、领域和 State 阶段内沿用上轮已选能力，且受当前资源策略再过滤；明确的新任务优先重新匹配。输入事实仍来自当前 State 和产物。模糊修改先澄清，不猜尺寸；没有 API 配置时在发送前提示，避免生成只有 scoped 状态的空任务。工业结果与任务完成后，Desktop 自动刷新当前工程文件树，新产物可以从 Registry 打开；正在查看的原件不被覆盖。

macOS 15 与 26 arm64 native CI 通过 `scripts/setup-freecad.cjs` 下载官方 arm64 DMG，校验固定 SHA-256 `071343b4abb70492b75c973f41eaf1d2528f9b9c7ea018d22a4f46ae14d27ac0`，只读挂载并把可执行路径提供给测试。原生测试缺少依赖直接失败，不以 skip 代替成功；CI 下载二进制不会进入 Pack 发行档案。

FreeCAD 的 macOS 配置路径不只依赖 `HOME`。桥接器在启动前创建 Action 内独立配置、数据与临时目录，通过上游 `FREECAD_USER_HOME`、`FREECAD_USER_DATA`、`FREECAD_USER_TEMP` 指定路径，并使用官方 `--keep-deprecated-paths`，避免 FreeCAD 1.1 在采用自定义缓存前创建 Qt 全局版本目录；系统沙箱仍只允许写入本次 Action。建模和独立回读均记录并检查 FreeCAD 实际采用的配置、数据、缓存、宏与临时路径，避免依赖用户已有的全局目录或加载其宏。初次全新 CI 环境曾在初始化阶段 SIGSEGV；崩溃栈位于初始化异常报告中的 Python 路径读取，不能据此判定操作系统不兼容。失败保留退出信号、系统诊断与未验收状态，CI 同时保留真实 Viewer 截图与日志。


2026-10-07 增加 `test:cad-resize`：沿用原生检查，另用真实 OCCT 渲染像素验证拖动分隔线、280 px 最小聊天宽度、键盘调整、复位、小窗口和全屏前后的比例变化。发布整改与本地安装验收见[整改记录](release-readiness-20261007.md)。

## 自动成果呈现（#66）

owner Pack `1.1.4-pack.7` 声明 FCStd 模型组、对应 manifest/BREP 预览与 STEP/STL 导出，以及独立诊断报告组。连续 edit 只按确切源文件 hash 显式替代；inspect 将真实检查附到受检模型版本，不挤掉主模型。失败只暴露实际文件。Harness 固定消费 owner commit `b9759342cace66df0be0c4559b7c24fb28ea07d9`；FreeCAD Skill 在 owner 提供按需比较／诊断选择指导。默认卡片不依赖选择工具。源码原生／Electron 受控回归和独立真实模型连续修改记录见[任务成果](task-results.md)。

# Built-in Viewers

The `./domain-icon` export provides read-only domain identity artwork for desktop
labels and Pack cards. It uses theme-inherited inline SVG, preserves adjacent
accessible labels, and falls back to a generic icon for unknown domains. The
seven designs and their presentation-only scope are documented in
[Domain icons](../../doc/domain-icons.md).

Harness 自有控件消费 `./text` 导出的只读展示 `DisplayTextProvider`。Desktop 提供中英文翻译及语言，切换保留 Viewer 状态；其他宿主可提供自己的回调，默认沿用原标签。Desktop 和 Viewer 的语言声明及译文统一维护在 [`apps/desktop/i18n.config.json`](../../apps/desktop/i18n.config.json)，Viewer 包不依赖宿主配置。源文件、工程数值、Runtime 命令、上游嵌入控件和验证证据不翻译。见[桌面语言切换](../../doc/desktop-languages.md)。

这里是正式的内置 Viewer 实现路径。首批直接迁入并使用三种 EDA Viewer：

| 模块 | 渲染能力 |
| --- | --- |
| `src/layout` | KLayout Python `LayoutView` 按视口渲染 GDS |
| `src/netlist` | netlistsvg 在独立 worker 中渲染 Yosys JSON 网表 |
| `src/waveform` | 本地 Surfer WASM 通过受限页面查看 VCD 等波形 |
| `src/assets` | 图片、Sprite 图集与动作动画；有界只读资源解析与 Canvas 预览 |
| `src/kicad` | 本地 KiCanvas 隔离 iframe、KiCad 板图/原理图和多页配套文件校验 |
| `src/godot` | Godot Web Export 隔离 iframe、会话资源管理和 Viewer Bridge |
| `src/engineering` | Godot 场景/脚本/资源与 PCB 库/制造文件/3D 素材的受限只读预览 |
| `src/cad` | OCCT BREP/STL 实体、封口剖切、面/边选择与名义几何测量；FreeCAD 原生草图/尺寸/约束高亮，共享导航与全屏，macOS arm64 Electron 验证 |
| `src/documents` | 不依赖 Domain 的 CSV/TSV、JSON、JSONL/NDJSON、Markdown、TXT/LOG、HTML/HTM；只读、原文入口、有界解析与分页；HTML 在沙箱隔离源 iframe 中预览，阻断远程加载 |

`src/api.ts` 定义桌面 Viewer Host 当前需要的接口，`src/viewer-styles.css` 保留 demo 工作台及 Viewer 样式。`fixtures/` 是明确标识的参考数据；`tests/` 检查渲染和文件访问边界。运行：

```bash
pnpm --filter @industrial-agent-harness/viewer-builtin test
```

生产调用必须先由桌面端把用户选定的项目与 Artifact ID 解析、校验为本地只读文件，再交给这些模块。Viewer 只产生显示数据和临时视图状态，不修改工程资产或验收结果。Godot V1 运行 Web Export 预览，不提供工程编辑；完整编辑仍由 Godot 承担。

`ViewerCanvas` 按需加载各 Viewport，加载期间显示状态，加载或渲染失败交给原有错误回调。桌面宿主只挂载与当前选中 Artifact ID 一致的 Viewer。导航状态更新直接发布新的控制器，卸载时清理，避免缩放过程中反复清空标题栏状态；进入全屏保留已挂载视图。

接入说明见 [EDA Viewer 参考](../../doc/viewer-eda-reference.md)，通用约束见 [Viewer 层设计](../../doc/viewer-layer.md)。
Godot 导出和桥接说明见 [Godot Viewer V1](../../doc/godot-viewer.md)。
仓库内 [Godot Playground](../../examples/godot-viewer/README.md) 提供源项目和导出脚本；真实 Web 运行时与 Viewer 控制已在 macOS Electron 实测。

图片、图集和动作预览说明见 [素材 Viewer](../../doc/godot-assets-viewers.md)。

PCB 项目内 KiCad 文件的使用、限制与本地运行时来源见 [KiCad Viewer V1](../../doc/kicad-viewer.md)。

领域与素材 Viewer（版图、网表、波形、Godot、图片、图集、动画、KiCad、工程文件）及五种通用文件 Viewer 通过 `src/navigation.tsx` 的 `ViewNavigation` 注册缩放与 Fit。工作区统一呈现缩小、放大、适配和全屏入口；加载期间禁用缩放，切换文件时移除旧控制器。新接入的 Viewer 应实现同一接口，并在真实渲染路径验证按钮、滚轮/捏合和全屏。百分比以当前 Fit 为 100%，波形使用时间轴语义。Godot 放大已挂载的预览，不修改场景相机。通用文档的 Fit 恢复 100% 阅读比例；格式、上限与来源边界见 [通用文件 Viewer](../../doc/document-viewers.md)。

CAD Viewer 使用官方 OCCT 7.9.2 AIS/V3d WebGL2 的本地 WASM，显示 BREP 曲面和 CAD 轮廓；STL 使用 AIS_Triangulation。剖切支持 X/Y/Z、位置和反向；三维页提供带标尺图标的“测量”按钮；点击展开单对象尺寸/两对象最短距离及面/边选项，尺寸直接标在模型上，不弹出测量侧栏；单对象只保留当前选择，距离模式才显示绿色最近点连线和明确的“最短距离”标注，退出会清除选中对象及标注。网格预览禁用按钮并说明原因。BREP 支持面/边选择、高亮、边长、圆边/圆柱面直径、面面积、两个对象的最短距离及标注。草图页读取独立 FreeCAD 进程重开 FCStd 后导出的几何和约束，支持轮廓、尺寸、完全约束状态、约束联动及共享导航。测量不更新工业验收，旧产物缺少草图配套时明确要求生成新预览。16 MiB/100000 三角形/5000 BREP 面、1 MiB 草图配套限制、哈希和原生执行边界见 [FreeCAD CAD Pack](../../doc/freecad-domain-pack.md)。OCCT 相机更新保留当前画布宽高比，窗口和全屏变化不拉伸模型；Fit 恢复初始构图。共享桌面工作区支持可拖动及键盘操作的分隔线。Viewer 本身不启动 FreeCAD；完整对应源码、许可证和重编译说明保存在 src/cad/occt，桌面发行时一同提供。

## Desktop tab lifecycle

Desktop now offers split and tabbed layouts using the same Registry and
ViewerCanvas API. Visited file Viewers remain mounted when hidden or when the
layout changes; closing a file or switching project releases them normally. The
shared navigation toolbar binds only to the active file. No domain dispatch,
engineering edits or verification logic is added to the host. See
[responsive layouts and validation](../../doc/desktop-layouts.md).

任务成果入口复用 Registry、共享工作区和导航。CAD／通用文档显式允许前台唯一候选的一次只读自动预览；其他 Viewer 默认不自动打开。手动成果／导出入口核对记录文件和配套哈希；文件变化明确拒绝，Viewer 不更改历史检查。macOS arm64 源码 Electron 的真实产物卡→OCCT、缩放／滚轮／触控板／Fit／全屏与历史／焦点验收见[任务成果](../../doc/task-results.md)。

远程 CAD 下载文件可使用同目录 `artifact-bundle.json` 定位原预览 manifest，再按哈希匹配 BREP/STL/草图配套。索引不含可执行逻辑，限制 64 KiB / 64 项，文件名只允许安全 basename，配套必须与模型位于同一真实目录；大小、摘要、重复及符号链接越界均校验。它只辅助显示，不新增工程 Artifact 或 Verifier 结论。真实 FCStd/STEP 的文件树→Registry→OCCT、缩放/Fit/全屏证据见[远程 CAD 验收](../../doc/evidence/remote-cad-20261019/README.md)。

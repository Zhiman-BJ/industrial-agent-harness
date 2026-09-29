# 图片、Sprite 图集与动画 Viewer V1

2026-09-28：通过现有 Viewer Registry 注册三个只读插件 `image`、`sprite`、`animation`。项目文件树打开支持的文件后自动选择插件；画布顶部可切换 Image / Sprite sheet / Animation。全屏复用工作区按钮。所有设置都是临时查看状态，不修改素材、场景或工程 Verification。

## 使用

- **Image**：PNG、JPEG、WebP 原图；透明棋盘、深色/浅色背景；Fit 与放大/缩小；拖动平移；像素或平滑采样；显示真实像素尺寸。
- **Sprite sheet**：设置 Columns / Rows，显示网格，点击单元格或输入从零开始的 Frame 编号，右侧预览对应裁剪帧。网格必须整除图片尺寸，最多 4096 格。
- **Animation**：读取已有动作，或选择 Manual range 并设置网格、起止帧和 FPS。支持播放、暂停、重置、前后逐帧、时间轴定位、倍率和循环；播放保留每帧的持续时间，关闭面板或切换模式会清理播放循环。

普通图片默认打开 Image，不自动猜测网格或动作名称。动画资源默认打开 Animation。素材查看不要求 Godot 引擎、Web 导出、Viewer Bridge 或 MCP。

## Godot 格式范围

读取 Godot 4 的文本资源，使用有大小与嵌套上限的受限解析器；不求值脚本、不启动引擎、不实例化场景：

- `.tres` / `.tscn` 中单个 SpriteFrames：支持项目内 Texture2D、AtlasTexture 的整数 region、动作名称、speed、loop 和帧 duration；支持多张图片。
- `.tscn` 中 AnimationPlayer：支持单个 Sprite2D 的 `:frame` 离散值轨道，以及 hframes / vframes、AnimationLibrary 动作名称与关键帧时间。关键帧必须从零开始。
- V1 不模拟骨骼、物理、着色器、场景变换、混合动画、AtlasTexture margin、Sprite2D region clipping、多个 Sprite2D 轨道、ping-pong 轨道、外部 AnimationLibrary 或外部 SpriteFrames 资源引用。被识别但超出范围的资源明确报告错误；普通场景继续显示源码。

官方格式语义参考：[Sprite2D 动画](https://docs.godotengine.org/en/stable/tutorials/2d/2d_sprite_animation.html)、[SpriteFrames](https://docs.godotengine.org/en/4.7/classes/class_spriteframes.html)。

## 可选 Sprite 描述文件

`.sprite.json` 提供项目相对图片路径、网格和动作，无须 Godot 场景。示例：

```json
{
  "version": 1,
  "image": "player/robot.webp",
  "columns": 8,
  "rows": 8,
  "animations": [
    {"name": "idle", "fps": 4, "loop": true, "frames": [30, 31, 32, 33]}
  ]
}
```

`animations` 可以省略。整数帧索引按逐行顺序；需要不同持续时间时使用 `{"index": 30, "duration": 0.25}`，单位为秒。描述文件不由 Viewer 写入。

## 文件边界与限制

源文件和配套图片都必须解析到当前项目目录内，拒绝绝对路径、网络地址、user:// 和越界符号链接。源文件重新核验 Artifact 哈希；图片使用包含 SHA-256 的不可变内存快照，显示时再次核对浏览器解码尺寸。源文件变更需要重新打开。

文本上限 2 MB；单图 16 MB、8192 × 8192 边长以内且最多 32 M 像素；配套图片最多 32 张、压缩数据合计 32 MB、解码像素合计 32 M；最多 128 个动作、合计 4096 帧。只接受指定栅格格式，不执行 SVG 或 HTML。

## 验证

仓库 [Godot Playground](../examples/godot-viewer/README.md) 提供原创 `robot.png`、四列 `.sprite.json` 和含两个 SpriteFrames 动作的 `.tscn`。Godot 桌面 selftest 从普通项目文件树分别打开三种资源并确认 Viewer Ready；无需模型 API。

`packages/viewer-builtin/tests/assets.test.cjs` 覆盖三个插件的数据路径、越界和符号链接、坏帧索引、尺寸上限、源哈希变化、Godot 关键帧、SpriteFrames 权重及播放时序。桌面 TypeScript、Vite build 和架构检查验证接线。

本地测试使用官方 Godot Platformer 的 `player/robot.webp` 和 `player/player.tscn`，来源提交为 `15d4fcd70a429dfd455d6fce9d0cd004abd07373`；示例代码 MIT，素材归属以其 README 与 LICENSE 为准。测试项目位于 `/tmp/harness-godot-platformer`，未作为产品内置示例入口发布。macOS Electron 实测已显示 WebP 原图和透明棋盘，手动切分 8 × 8 图集并预览第 30 帧；打开 player.tscn 自动读取 10 个动作，验证 run 的播放、暂停及逐帧前进。其他操作系统尚未验证。

图片、图集和动画共用工作区的缩小、放大、Fit 与全屏。画布内滚轮或触控板捏合缩放，拖拽平移；Fit 清除平移并恢复适配大小。缩放不改变动作帧、时序或资源文件。

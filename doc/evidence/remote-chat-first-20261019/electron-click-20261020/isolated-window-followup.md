# 独立窗口后续：2026-10-20

用户已运行 `/tmp/pr230-isolated-desktop-launcher.cjs` 并报告新窗口打开。宿主只读核对本轮 `pr230-normal-desktop-lVgjDc` 的公开配置：模型为 `remote-chat-controlled-fixture`，端点为 keyed loopback mock；平台账号配置与此前已授权的真实远端一致。测试密钥仅注入子进程内存，原模型密钥未更改。该启动器只准备配置及合成工程，不发送任务或批准操作。

本轮仍未完成任务点击验收。存在多个同名 Electron 实例；控制接口最初返回上轮 MiniMax 空白聊天。在该旧实例菜单执行正常退出后，接口返回目录选择框；输入本轮合成工程目录、点击“打开”后，窗口状态读取持续超时，重建控制连接仍超时。不能将此判断为应用崩溃或远端服务故障。

只读观察：本轮 mock 对不执行推理的 GET 返回 405，启动器退出状态文件尚不存在，新 profile 尚未写入项目 binding。没有发送任务或点击审批，未执行本轮远端 CAD。当前继续验收需要恢复对目标窗口的可靠控制；此前 `isolated-ui-model-profile-required` 是上一阶段阻塞，独立模型配置现已具备。既有入口子项通过与早期 SIGABRT 历史保留，完整 RE-E01–11 不补记通过。

用户同时指出模型入口与芯片领域共用图标。`f116ef7` 已把模型入口改为 BrainCircuit 图标，并将悬浮提示及无障碍名称改为“模型：{模型名}”；未硬编码测试模型名称。类型检查、7 项语言测试及 Vite 构建通过。该改动尚未在本轮目标窗口重载后完成视觉复验。

## 模型入口外观预览

用户随后要求查看改后的 UI。原生窗口控制再次超时，因此在 Chrome 中展示同一份已构建 renderer，使用独立模拟项目与模型数据。临时服务仅绑定 `127.0.0.1`，只读提供现有 `dist`，通过单独的模拟 host 数据启动界面；未替换产品组件、图标或样式，不连接模型或远端服务。页面标题及项目名标明“外观预览 / 模拟数据”。

实际页面确认模型按钮的 SVG 类为 `lucide-brain-circuit`，title 和无障碍名称为“模型：remote-chat-controlled-fixture”；旁边“芯片”领域仍使用芯片图标。[完整界面](03-model-icon-browser-preview.jpg)与[输入区截图](04-model-icon-composer-preview.jpg)由浏览器直接截图取得，未重绘。构建资源为 `index-DoOwPZ0u.js`，SHA-256 `92549ef37628aaf12c8aa548f89888eb9249c0db86e94c7309252b7fc8e28c50`，源代码改动为 `f116ef7`。

这仅验证模型入口的真实 renderer 外观，不证明 Electron 目标窗口已刷新，也不补记审批、自动同步或远端执行用例通过。

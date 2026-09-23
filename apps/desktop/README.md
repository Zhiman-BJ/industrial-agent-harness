# Desktop

Electron MVP 工作台采用项目树、Agent 对话、Viewer 三列布局。左右栏可收起，左下角 Settings 可切换明暗主题与 Debug 日志。文件树只列出当前项目的文件；点击 GDS/OAS、Yosys JSON、VCD/FST/GHW 文件会自动打开对应 Viewer，并显示内容哈希。对话区输入任务并解析 Capability；Debug 开关展示候选、筛选、Scope 替换和详细信息加载日志。

Kimi Code 会话需要本机 `kimi` CLI。界面会检测其可用性；选择工程目录、解析能力后即可运行任务，并查看文本、工具事件和审批请求。当前 Agent 工具是按 Scope 提供的只读产物元数据工具；完整工业执行与验证链路尚未接入。

运行 `pnpm dev` 或从仓库根目录运行 `pnpm build && pnpm start`。版图渲染可先运行 `pnpm setup:layout`，或设置 `KLAYOUT_PYTHON`。

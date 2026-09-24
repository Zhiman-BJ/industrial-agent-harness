# Headless Release 说明

每个 `headless-v*` 标签必须在同一提交中带有 `releases/<tag>.md`。发布工作流直接使用该文件作为 GitHub Release 正文；缺失文件或缺少“相比原生 Kimi Code 集成了什么”“尚未集成”两节时，发布失败。

每版正文应基于该标签的实际产物列明：

- 相比原生 Kimi Code 新增或连接的 Harness 能力，以及各能力能做什么；
- 哪些组件只是接口或配置机制，尚无可用 provider；
- Kimi CLI、模型密钥、工业软件等外部依赖；
- 尚未打通的工业执行与验证路径；
- 下载、校验和安装说明的链接。

不要把 Kimi SDK、CLI 或原生 Agent 功能列作 Harness 自研能力，也不要将 Scope 烟测描述成工程验证。

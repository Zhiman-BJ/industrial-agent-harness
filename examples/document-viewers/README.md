# 通用文件 Viewer 示例

这个目录提供原创的演示数据，用于查看通用文件格式，不代表工程运行或验证结果。无需模型 API 或领域软件。

点击工作台 Projects 旁的「＋」绑定此目录，选择任意已有 Domain，然后打开右侧文件树。通用 Viewer 在各领域项目中都使用同一行为。

| 文件 | 可以查看什么 |
| --- | --- |
| `records.csv` | 表头、中文、前导零、带逗号与换行的字段；可切换表头、筛选和查看原文 |
| `records.tsv` | 制表符分隔表格与文本数值 |
| `settings.json` | 折叠对象/数组、不同值类型、配置文件中的普通 `modules` 字段 |
| `events.jsonl` | 带源行号的 JSON 记录 |
| `events.ndjson` | 同样支持的 NDJSON 扩展名 |
| `run.log`、`notes.txt` | 行号、文本筛选、自动换行 |
| `README.md` | Markdown 标题、列表、引用、代码块、表格和任务列表；可切回原文 |

所有 Viewer 支持标题栏缩放、Fit 与全屏，Esc 退出。滚轮或触控板捏合缩放，Shift+滚轮和滚动条用于滚动。查看不会保存或修改这些文件。

## 操作记录

- [ ] 查看 CSV 中的多行字段
- [ ] 展开 JSON 的 `window` 和 `views`
- [ ] 使用 Find 筛选日志中的 `complete`
- [ ] 放大后进入全屏，再退出并检查状态保留

> 这些选项只供阅读，Viewer 不保存复选框状态或编辑文档。

```json
{"example": true, "editing": false}
```

格式和上限见 [通用文件 Viewer](../../doc/document-viewers.md)。预览中的链接只显示为文本；需要跟随链接时请在仓库文档中打开。

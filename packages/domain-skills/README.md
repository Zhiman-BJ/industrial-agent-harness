# Domain skills

Registry and on-demand loading for domain guidance. Discovery returns a compact index; detailed skill content is loaded only when relevant to the current task. Skill text does not determine execution success.

当前 `src/capabilities.cjs` 含 Chip 网表、波形、版图与 PCB 板图的首批声明。Broker 先披露摘要，选中能力后才读取详细参考内容。这些声明用于 MVP 的发现与查看流程，PCB 专业工具执行尚未接入。

四个对应的 Kimi `SKILL.md` 位于 `skills/`，由 `src/registry.cjs` 以稳定 ID 注册。Kimi 会话启动时只复制当前 Broker Scope 中未被 Project 禁用的 Skill 到临时 `skillsDir`；Project 不修改仓库文件。新增默认 Skill 时，同时增加仓库文件、注册项和 Capability 引用。

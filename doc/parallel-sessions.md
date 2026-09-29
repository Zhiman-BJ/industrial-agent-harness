# Desktop parallel sessions

Each chat owns one independent native Kimi session, its captured Project directory and Domain, current Broker scope/trace, execution lease, context provider, pending approvals and turn identity. The session manager coordinates these instances; Kimi continues to own each model/tool loop, context and compaction.

The sidebar can create or open another chat while a task runs, including another chat in the same project. Selecting a project or chat changes navigation without cancelling background work. Project rows show running-chat counts; chat rows show a running indicator or an approval indicator. Opening a chat loads its persisted turns and resumes its live event stream. Every event carries Project, chat and turn identities so background replies cannot enter the selected chat.

Only a second submission to the same running chat is rejected. Approve/Reject and Stop target an explicit chat and reject stale selection; identical approval IDs in different native sessions remain independent. Deletion is blocked for the targeted running chat. Changing a Project Domain or resource override requires that project's chats to be idle; global model/resource changes require all affected chats to be idle. Existing Broker permission checks are repeated before execution, and callbacks never use a different selected project's scope or artifacts.

If a restored running turn belongs to another window, its saved approvals and Stop are not actionable in this window. The UI identifies the owner boundary and refreshes until the turn finishes; a new chat can run alongside it. Loading saved events never creates a native actor or resumes an approval.

The same Project directory is shared by its chats. Parallel execution does not create source-file isolation; each task keeps the existing tool approvals and execution permissions. This feature does not add industrial mutation or verification bypasses.

Images use the existing capability-aware multimodal input. Submitted images are retained with their chat turn; errors and cancellation restore only the matching chat's draft. Switching chats clears the visible draft and displays the selected chat's saved inputs. Old diagnostic-only conversations whose native context was removed cannot be converted into resumable sessions by this feature.

Validation on macOS:

- `pnpm --filter @industrial-agent-harness/desktop test:parallel`: two chats in one project plus a third in another project held concurrently, navigation, background approval, colliding approval IDs, forged/stale requests, project resource/model guards, isolated Stop and isolated replies.
- `KIMI_EXECUTABLE=/absolute/path/to/kimi node --test packages/agent-kimi/tests/parallel-wire.test.cjs`: actual pinned SDK/CLI requests overlap before either receives a response; finishing/closing one session leaves the second active, and cancellation affects only the second.
- Existing image, logs, approval/resource, persisted desktop restart and real CLI context-resume checks remain applicable. Linux/Windows packaged flows have not been exercised.

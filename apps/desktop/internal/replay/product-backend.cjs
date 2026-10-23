'use strict';

// Internal, read-only adapter for the unmodified production renderer/preload.
// No task service, model, agent process, Broker or execution backend is created.
const crypto = require('node:crypto');
const { createReplayController } = require('./controller.cjs');
const { createRecordedViewerHost } = require('./native-viewer.cjs');
const { appendDisplayEvents } = require('../../../../packages/harness-replay/src/index.cjs');

const HISTORY_PAGE_SIZE = 10;
const LOG_PAGE_SIZE = 100;
const CONTENT_PAGE_BYTES = 64 * 1024;
const clone = value => structuredClone(value);
const actorOf = record => record.origin?.agentId || record.event.replayAgentId || 'main';
const turnOf = record =>
  record.origin?.turnId || record.event.replayTurnId || record.event.turnId || 'recorded-turn';
const stampOf = record => record.at || record.event.recordedAt || null;
const slug = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
const readOnlyError = channel =>
  Object.assign(new Error(`Read-only recording: ${channel} cannot execute or modify data.`), {
    code: 'REPLAY_READ_ONLY',
  });

function createProductReplayBackend(bundle) {
  if (!bundle || !Array.isArray(bundle.events))
    throw Error('A loaded recording bundle is required.');
  const controller = createReplayController(bundle);
  const records = bundle.events;
  const projectId =
    bundle.manifest.chat?.projectId || `recorded-project-${slug(bundle.manifest.recordingId)}`;
  const viewer = createRecordedViewerHost(bundle, { projectId });
  const listeners = new Set();
  const actors = new Map();
  const firstTurnIndex = new Map();
  const mainActor = records.some(record => actorOf(record) === 'main')
    ? 'main'
    : actorOf(records[0] || { event: {} });
  const primaryChatId =
    bundle.manifest.chat?.chatId || `recorded-chat-${slug(bundle.manifest.recordingId)}`;
  const domain =
    bundle.manifest.chat?.domain ||
    bundle.manifest.project?.domain ||
    bundle.native?.project?.domain ||
    bundle.native?.domain ||
    records
      .map(
        record =>
          record.event.scope?.domain ||
          record.event.broker?.scope?.domain ||
          record.event.action?.domain,
      )
      .find(Boolean) ||
    'general';
  const displayName =
    bundle.manifest.chat?.displayName || bundle.manifest.recordingId || 'Recorded project';
  let activeChatId = primaryChatId;
  let revision = 0;
  let closed = false;
  let lastPosition = 0;
  let activeStageId = null;
  let cachedProjection;

  for (const [index, record] of records.entries()) {
    const actorId = actorOf(record);
    if (!actors.has(actorId)) {
      const native = bundle.native?.agents?.find(actor => actor.id === actorId) || {};
      actors.set(actorId, {
        id: actorId,
        chatId:
          actorId === mainActor ? primaryChatId : `${primaryChatId.slice(0, 80)}-${slug(actorId)}`,
        title:
          actorId === mainActor
            ? displayName
            : native.name || native.label || native.description || actorId,
        indices: [],
        brokerIndices: [],
      });
    }
    actors.get(actorId).indices.push(index);
    if (record.event.broker) actors.get(actorId).brokerIndices.push(index);
    const turnKey = JSON.stringify([actorId, turnOf(record)]);
    if (!firstTurnIndex.has(turnKey)) firstTurnIndex.set(turnKey, index);
  }
  if (!actors.size)
    actors.set(mainActor, {
      id: mainActor,
      chatId: primaryChatId,
      title: displayName,
      indices: [],
      brokerIndices: [],
    });
  const chatsById = new Map([...actors.values()].map(actor => [actor.chatId, actor]));
  function ensureOpen() {
    if (closed) throw Error('Recorded backend is closed.');
  }
  function ensureProject(request) {
    if (request?.projectId && request.projectId !== projectId)
      throw Error('Unknown recorded project.');
  }
  function requireActor(id) {
    const actor = chatsById.get(id);
    if (!actor) throw Error('Unknown recorded chat.');
    return actor;
  }
  function publish(channel, payload) {
    const envelope = { channel, payload };
    for (const listener of listeners) listener(envelope);
  }
  function eventFor(record, actor, eventRevision = revision) {
    return {
      ...record.event,
      recordedAt: stampOf(record),
      projectId,
      chatId: actor.chatId,
      turnId: turnOf(record),
      agentId: actor.id,
      eventRevision,
      recordingSequence: record.seq,
    };
  }
  function reachedIndex(indices, position) {
    let low = 0;
    let high = indices.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (indices[middle] < position) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  function chatSummary(actor, position) {
    const visible = reachedIndex(actor.indices, position);
    const first = records[actor.indices[0]];
    const last = records[actor.indices[visible - 1]];
    return {
      id: actor.chatId,
      approvalMode: 'ask',
      title: actor.title,
      domain,
      createdAt: first ? stampOf(first) : bundle.manifest.createdAt,
      updatedAt: last ? stampOf(last) : first ? stampOf(first) : bundle.manifest.createdAt,
      archived: false,
      running: false,
      awaitingApproval: false,
      awaitingQuestion: false,
      recordedAgentId: actor.id,
    };
  }
  function projection() {
    const position = controller.snapshot().position;
    if (cachedProjection?.position === position && cachedProjection.revision === revision)
      return cachedProjection;
    const byChat = new Map();
    for (const actor of actors.values()) {
      const turns = new Map();
      const visible = actor.indices.filter(index => index < position);
      for (const index of visible) {
        const record = records[index];
        const id = turnOf(record);
        if (!turns.has(id))
          turns.set(id, {
            id,
            task: '',
            broker: null,
            status: 'recorded',
            createdAt: stampOf(record),
            events: [],
            sourceSequences: [],
            sourceCount: 0,
          });
        const turn = turns.get(id);
        // Full raw evidence stays in controller.page / diagnostic APIs. The
        // production renderer never consumes raw sourceRecords, and copying
        // them through IPC can exceed 100 MiB for one real imported chat.
        turn.sourceSequences.push(record.seq);
        turn.sourceCount++;
        if (record.event.type === 'text' && record.event.replayRole === 'user')
          turn.task += record.event.text;
        else turn.events.push(eventFor(record, actor));
        if (record.event.broker) turn.broker = record.event.broker;
        if (record.event.type === 'done') turn.status = record.event.result?.status || 'recorded';
        else if (record.event.type === 'error') turn.status = 'error';
      }
      const initial =
        actor.id === mainActor && bundle.manifest.chat?.initialSnapshot?.included
          ? bundle.manifest.chat.initialSnapshot.turns || []
          : [];
      const list = [
        ...initial,
        ...[...turns.values()].map(turn => ({
          ...turn,
          events: appendDisplayEvents([], turn.events),
        })),
      ];
      const summary = chatSummary(actor, position);
      byChat.set(actor.chatId, { actor, turns: list, summary });
    }
    cachedProjection = { position, revision, byChat };
    return cachedProjection;
  }
  function history(request = {}) {
    const actor = requireActor(request.id);
    const item = projection().byChat.get(actor.chatId);
    const boundary =
      request.before == null
        ? item.turns.length
        : item.turns.findIndex(turn => turn.id === request.before);
    if (boundary < 0) throw Error('History cursor is unavailable for this recorded chat.');
    const start = Math.max(0, boundary - HISTORY_PAGE_SIZE);
    const turns = item.turns.slice(start, boundary);
    return {
      chat: item.summary,
      turns,
      hasMore: start > 0,
      before: turns[0]?.id || null,
      eventRevision: revision,
      agentId: actor.id,
      executing: false,
      recorded: true,
    };
  }
  function chatList() {
    return {
      chats: [...actors.values()].map(actor => chatSummary(actor, lastPosition)),
      activeId: activeChatId,
      sessions: [],
    };
  }
  function bindings() {
    const projectPath = viewer.snapshot().projectRoot || bundle.sourceDirectory || '';
    return {
      activeId: projectId,
      projectDir: projectPath,
      projects: [
        { id: projectId, name: displayName, path: projectPath, domain, executionLocation: 'local' },
      ],
    };
  }
  function advance(next, reason) {
    const previous = lastPosition;
    const structural =
      reason === 'seek' ||
      reason === 'reset' ||
      records
        .slice(previous, next.position)
        .some(
          record =>
            firstTurnIndex.get(JSON.stringify([actorOf(record), turnOf(record)])) >= previous ||
            (record.event.type === 'text' && record.event.replayRole === 'user'),
        );
    if (next.position !== previous) {
      revision += Math.max(1, Math.abs(next.position - previous));
      cachedProjection = null;
    }
    if (next.activeStageId !== activeStageId) {
      const stage = bundle.manifest.replayStages?.find(
        candidate => candidate.id === next.activeStageId,
      );
      viewer.activateStage(stage?.provenance?.snapshotId ? stage.id : null);
      activeStageId = next.activeStageId;
      publish('projects:changed', {
        projectId,
        position: next.position,
        stageId: activeStageId,
        recorded: true,
      });
      publish('replay:snapshot-changed', {
        projectId,
        position: next.position,
        stageId: activeStageId,
        recorded: true,
      });
    }
    lastPosition = next.position;
    if (next.position !== previous || reason === 'reset' || reason === 'seek') {
      if (!structural && next.position > previous) {
        for (let index = previous; index < next.position; index++) {
          const record = records[index];
          if (record.event.type === 'text' && record.event.replayRole === 'user') continue;
          publish(
            'agent:event',
            eventFor(record, actors.get(actorOf(record)), revision - (next.position - index - 1)),
          );
        }
      }
      publish('chat:updated', {
        projectId,
        chatId: activeChatId,
        position: next.position,
        eventRevision: revision,
        recorded: true,
      });
      if (structural)
        publish('replay:history-invalidated', {
          reason,
          position: next.position,
          eventRevision: revision,
        });
    }
    return next;
  }
  const gui = { enabled: false, install: 'missing', version: null, permissions: null };
  const emptyResources = {
    catalog: { skills: [], mcpServers: [] },
    global: { skills: [], mcpServers: [] },
    overrides: { skills: {}, mcpServers: {} },
    effective: { skills: [], mcpServers: [] },
  };
  const domainOption = { id: domain, label: domain, emoji: '', builtin: domain === 'general' };
  const remote = {
    status: 'not_configured',
    domains: [],
    reason: 'Read-only recorded session; no remote service is connected.',
  };
  const runId = bundle.manifest.recordingId;
  function selectedRecords(request = {}) {
    ensureProject(request);
    if (request.runId && request.runId !== runId) throw Error('Unknown recorded run.');
    return records.slice(0, controller.snapshot().position);
  }
  function category(record) {
    if (['tool', 'tool-result'].includes(record.event.type)) return 'tools';
    if (record.event.type === 'thinking') return 'thinking';
    if (record.event.type.startsWith('approval') || record.event.type.startsWith('question'))
      return 'approvals';
    if (['context-metrics', 'context-reset', 'compaction'].includes(record.event.type))
      return 'context';
    return 'run';
  }
  function recordSummary(record) {
    return String(
      record.event.name ||
        record.event.message ||
        record.event.text ||
        record.event.result?.summary ||
        record.event.type,
    );
  }
  function content(text, offset = 0) {
    const bytes = Buffer.from(text);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length)
      throw Error('Invalid recorded content offset.');
    let end = Math.min(offset + CONTENT_PAGE_BYTES, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    return {
      text: bytes.subarray(offset, end).toString('utf8'),
      offset,
      nextOffset: end < bytes.length ? end : null,
      totalBytes: bytes.length,
    };
  }
  function diagnosticPage(request = {}) {
    const all = selectedRecords(request);
    const counts = { tools: 0, context: 0, thinking: 0, approvals: 0, run: 0, ui: 0 };
    for (const record of all) counts[category(record)]++;
    const filtered = all.filter(
      record =>
        (!request.category ||
          request.category === 'all' ||
          category(record) === request.category) &&
        (!request.query ||
          JSON.stringify(record).toLowerCase().includes(String(request.query).toLowerCase())),
    );
    const offset = Number.isSafeInteger(request.offset) && request.offset >= 0 ? request.offset : 0;
    return {
      records: filtered.slice(offset, offset + LOG_PAGE_SIZE).map(record => ({
        sequence: record.seq,
        at: stampOf(record),
        type: record.source?.type || record.event.type,
        event: record.event.type,
        category: category(record),
        summary: recordSummary(record),
        bytes: Buffer.byteLength(JSON.stringify(record)),
      })),
      nextOffset: offset + LOG_PAGE_SIZE < filtered.length ? offset + LOG_PAGE_SIZE : null,
      total: filtered.length,
      totalRecords: all.length,
      counts,
      pending: false,
    };
  }
  function diagnosticEntries(request = {}) {
    const all = selectedRecords(request);
    const toolEntries = new Map();
    const contexts = [];
    const timeline = [];
    for (const record of all) {
      const entry = {
        id: `record-${record.seq}`,
        kind: record.event.type,
        title: recordSummary(record),
        at: stampOf(record),
        sequences: [record.seq],
        summary: recordSummary(record),
        fields: [
          {
            key: 'raw',
            label: 'Original source record',
            open: false,
            bytes: Buffer.byteLength(JSON.stringify(record, null, 2)),
          },
        ],
        sourceRecords: [record],
      };
      timeline.push(entry);
      if (category(record) === 'context') contexts.push(entry);
      if (category(record) === 'tools') {
        const key = JSON.stringify([actorOf(record), record.event.id]);
        if (!toolEntries.has(key))
          toolEntries.set(key, {
            ...entry,
            id: `tool-${record.seq}`,
            kind: 'tool',
            callId: record.event.id,
            status: 'recorded',
            fields: [],
            sourceRecords: [],
            sequences: [],
          });
        const tool = toolEntries.get(key);
        tool.sourceRecords.push(record);
        tool.sequences.push(record.seq);
        if (record.event.type === 'tool') tool.title = record.event.name;
        if (record.event.type === 'tool-result')
          tool.status = record.event.error || record.event.isError ? 'error' : 'recorded';
      }
    }
    for (const tool of toolEntries.values())
      tool.fields = [
        {
          key: 'raw',
          label: 'Original source records',
          open: false,
          bytes: Buffer.byteLength(JSON.stringify(tool.sourceRecords, null, 2)),
        },
      ];
    return {
      timeline,
      context: contexts,
      tools: [...toolEntries.values()],
      totalRecords: all.length,
    };
  }
  async function invoke(channel, payload) {
    ensureOpen();
    ensureProject(payload);
    switch (channel) {
      case 'project:bindings':
        return clone(bindings());
      case 'project:select':
        if (payload !== projectId) throw Error('Unknown recorded project.');
        return clone(bindings());
      case 'project:list':
        return viewer.listFiles();
      case 'project:read':
        return viewer.readFile(payload);
      case 'project:open':
        return viewer.openProjectFile(payload);
      case 'viewer:open':
        return viewer.openArtifact(payload);
      case 'viewer:resources-release':
        viewer.release(payload);
        return { released: true };
      case 'viewer:resources-cancel':
        return { cancelled: false };
      case 'chat:list':
        return clone(chatList());
      case 'chat:history':
        return clone(history(payload));
      case 'chat:select': {
        const result = history({ id: payload });
        activeChatId = payload;
        publish('chat:updated', { projectId, chatId: activeChatId, recorded: true });
        return clone(result);
      }
      case 'chat:evidence':
        return [];
      case 'agent:status':
        return {
          available: false,
          configured: false,
          version: bundle.manifest.source?.actor || 'Recorded session',
          projectDir: bindings().projectDir,
          gui,
        };
      case 'model:get':
        return {
          provider: 'openai_legacy',
          endpoint: '',
          model: '',
          contextSize: 0,
          thinking: false,
          imageInput: false,
          imageInputMode: 'disabled',
          hasApiKey: false,
          keyPersisted: false,
        };
      case 'account:get':
        return {
          status: 'not_configured',
          user: null,
          issuer: '',
          persistent: false,
          error: null,
          login: null,
          config: { issuer: '', clientId: '', audience: '', remoteOrigin: '', modelBaseUrl: '' },
          usePlatformModel: false,
        };
      case 'broker:domains':
        return [domainOption];
      case 'domains:status':
        return {
          managed: false,
          installed: [],
          errors: [],
          catalog: { state: 'unconfigured', bundledDomains: 0 },
        };
      case 'domains:available':
        return [];
      case 'domains:runtime-archives':
        return [];
      case 'broker:trace': {
        // The production UI asks after each tool result. It must not rebuild
        // all chat display events just to retrieve an already-recorded trace.
        const indices = requireActor(activeChatId).brokerIndices;
        const count = reachedIndex(indices, lastPosition);
        return clone(records[indices[count - 1]]?.event.broker?.trace || []);
      }
      case 'resource:catalog':
        return clone(emptyResources.catalog);
      case 'resource:get':
        return clone(emptyResources);
      case 'external-mcp:list':
        return [];
      case 'remote:service':
        return clone(remote);
      case 'remote:project':
        return {
          location: 'local',
          files: viewer
            .listFiles()
            .filter(file => !file.directory)
            .map(file => file.path),
          syncedAt: null,
          hasRemoteProject: false,
          service: clone(remote),
          task: null,
        };
      case 'remote:files':
      case 'remote:tools':
      case 'remote:artifacts':
        return [];
      case 'remote:task':
      case 'remote:session':
        return null;
      case 'settings:gui-state':
        return clone(gui);
      case 'settings:browser-automation-state':
        return { enabled: false };
      case 'update:status':
        return { status: 'unconfigured', version: null, progress: null, error: null };
      case 'agent:log-runs': {
        const all = selectedRecords(payload);
        return {
          runs: [
            {
              runId,
              traceId: runId,
              at: bundle.manifest.createdAt,
              sizeBytes: null,
              model: null,
              status: 'recorded',
              metrics: {
                peakContextUsage: null,
                compactions: all.filter(record => record.event.type === 'compaction').length,
                toolResults: all.filter(record => record.event.type === 'tool-result').length,
              },
            },
          ],
          limited: false,
        };
      }
      case 'agent:log-page':
        return diagnosticPage(payload);
      case 'agent:log-view': {
        const views = diagnosticEntries(payload);
        if (!['timeline', 'context', 'tools'].includes(payload?.view))
          throw Error('Unknown recorded diagnostic view.');
        const entries = views[payload.view].filter(
          entry =>
            !payload.query ||
            JSON.stringify(entry).toLowerCase().includes(String(payload.query).toLowerCase()),
        );
        const offset =
          Number.isSafeInteger(payload.offset) && payload.offset >= 0 ? payload.offset : 0;
        return {
          entries: entries.slice(offset, offset + LOG_PAGE_SIZE).map(item => {
            const entry = { ...item };
            delete entry.sourceRecords;
            return entry;
          }),
          nextOffset: offset + LOG_PAGE_SIZE < entries.length ? offset + LOG_PAGE_SIZE : null,
          total: entries.length,
          totalRecords: views.totalRecords,
          counts: {
            timeline: views.timeline.length,
            context: views.context.length,
            tools: views.tools.length,
          },
        };
      }
      case 'agent:log-detail': {
        const views = diagnosticEntries(payload);
        const entry = [...views.timeline, ...views.tools].find(entry => entry.id === payload?.id);
        if (!entry || payload.field !== 'raw') throw Error('Unknown recorded diagnostic field.');
        return content(
          JSON.stringify(
            entry.sourceRecords.length === 1 ? entry.sourceRecords[0] : entry.sourceRecords,
            null,
            2,
          ),
          payload.offset || 0,
        );
      }
      case 'agent:log-record': {
        const record = selectedRecords(payload).find(record => record.seq === payload.sequence);
        if (!record) throw Error('Recorded source record is unavailable at the current position.');
        return content(JSON.stringify(record, null, 2), payload.offset || 0);
      }
      default:
        throw readOnlyError(channel);
    }
  }
  return {
    controller,
    viewer,
    invoke,
    tick(delta) {
      ensureOpen();
      return advance(controller.tick(delta), 'tick');
    },
    control(request) {
      ensureOpen();
      return advance(controller.control(request), request?.action);
    },
    subscribe(listener) {
      ensureOpen();
      if (typeof listener !== 'function') throw Error('A listener is required.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      viewer.close();
    },
  };
}

module.exports = { createProductReplayBackend, HISTORY_PAGE_SIZE };

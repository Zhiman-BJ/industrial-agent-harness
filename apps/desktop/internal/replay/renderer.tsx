/// <reference types="vite/client" />
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentFlow } from '../../src/components/AgentFlow';
import { AgentGlyph } from '../../src/components/SubagentCard';
import { ViewerCanvas, type ViewNavigation } from '@industrial-agent-harness/viewer-builtin/canvas';
import type { AgentEvent, OpenedViewer } from '@industrial-agent-harness/viewer-builtin/api';
import { DisplayTextProvider } from '@industrial-agent-harness/viewer-builtin/text';
import { translate } from '../../src/i18n/core';
import '@industrial-agent-harness/viewer-builtin/styles.css';
import '../../src/style.css';
import './style.css';

type Agent = { id: string; totalEvents: number; reachedEvents: number; turnCount?: number };
type ReplayStage = {
  id: string;
  title: string;
  description?: string;
  atSeq: number;
  assetId: string;
  position: number;
};
type ReplayImage = {
  mime: 'image/png';
  dataUrl: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
};
type ReplayFlow = {
  position: number;
  agentId: string;
  turnOffset: number;
  totalTurns: number;
  turn: null | {
    id: string;
    task: string;
    events: AgentEvent[];
    blockOffset: number;
    blockLimit: number;
    totalBlocks: number;
  };
};
type ReplayState = {
  phase: 'paused' | 'playing';
  speed: number;
  position: number;
  totalEvents: number;
  sourceMs: number;
  displayMs: number;
  durationMs: number;
  atEnd: boolean;
  agents: Agent[];
  terminal?: { status?: string };
  activeStageId?: string | null;
};
type ReplayRecord = {
  seq: number;
  relMs: number;
  origin?: { agentId?: string; turnId?: string };
  source?: {
    eventId?: string;
    sourceFile?: string;
    sourceLine?: number;
    type?: string;
    timestampMs?: number;
  };
  event: {
    type: string;
    replayAgentId?: string;
    replayTurnId?: string;
    replayRole?: string;
    text?: string;
    name?: string;
    arguments?: string;
    output?: string;
    message?: string;
    [key: string]: unknown;
  };
};
type ReplayPage = {
  offset: number;
  total: number;
  pageSize: number;
  rows: { sourceIndex: number; record: ReplayRecord }[];
};
type Metadata = ReplayState & {
  manifest: {
    recordingId?: string;
    status?: string;
    outcome?: unknown;
    source?: { kind?: string };
    demo?: { constructed?: boolean; note?: string };
    chat?: { displayName?: string };
  };
  replayStages: ReplayStage[];
  native?: { artifactSnapshotsIncluded?: boolean };
  warnings: unknown[];
  missingAssets: unknown[];
};
declare global {
  interface Window {
    replayHost: {
      metadata(): Promise<Metadata>;
      page(request: { agentId: string; offset: number }): Promise<ReplayPage>;
      control(request: { action: string; value?: number }): Promise<ReplayState>;
      image(assetId: string): Promise<ReplayImage>;
      flow(request: {
        agentId: string;
        turnOffset?: number;
        blockOffset?: number;
      }): Promise<ReplayFlow>;
      onChanged(callback: (state: ReplayState) => void): () => void;
    };
  }
}

const messages: Record<string, string> = {
  'Recording replay': '录制回放',
  'Internal · Read only': '内部版 · 只读',
  'Historical content and instructions are displayed as recorded data. Playback does not call models, tools, or scripts.':
    '历史内容和指令仅作为录制数据展示。回放不会调用模型、工具或脚本。',
  'Loading recording…': '正在加载录制…',
  'All agents': '全部代理',
  events: '事件',
  turns: '轮次',
  Play: '播放',
  Pause: '暂停',
  Reset: '重置',
  Start: '起点',
  End: '终点',
  'Playback position': '回放位置',
  Speed: '速度',
  'Source time': '原始时间',
  Reached: '已重放',
  'Complete source coverage': '源事件已完整重放',
  'Recording status': '录制状态',
  'Follow playback': '跟随播放',
  'Previous page': '上一页',
  'Next page': '下一页',
  Page: '页',
  of: '/',
  'No events reached for this agent.': '该代理尚无已重放事件。',
  'Full source record': '完整源记录',
  'Recorded user message': '录制的用户消息',
  'Recorded tool call': '录制的工具调用',
  'Recorded tool result': '录制的工具结果',
  Thinking: '思考',
  Text: '文本',
  'Source notes and gaps': '源记录说明与缺口',
  'Original project artifact snapshots are not included; recorded events and tool outputs remain available.':
    '此导出不含原始工程产物快照；录制事件与工具输出仍可完整查看。',
  'Source event': '源事件',
  'Source file': '源文件',
  'Source type': '源类型',
  'Show complete content': '展开完整内容',
  'Show source metadata': '查看源数据',
  'Replay error': '回放错误',
  Theme: '主题',
  Light: '浅色',
  Dark: '深色',
  complete: '完整',
  incomplete: '不完整',
  chars: '字符',
  'Constructed demo': '构造演示',
  'This is a constructed demonstration. Stage images illustrate the sequence; they are not engineering verification results.':
    '这是构造演示。阶段图片用于呈现搭建过程，不代表工程验证结果。',
  'Stage snapshots': '阶段快照',
  'Recorded event ledger': '录制事件明细',
  'Fixed camera · passive image': '固定机位 · 被动图片',
  'Play or select a stage to reveal its recorded snapshot.': '播放或选择阶段，查看对应的录制快照。',
  'Loading stage snapshot…': '正在加载阶段快照…',
  'Stage image unavailable': '阶段图片不可用',
  'Recorded stage snapshot': '录制的阶段快照',
  'Image source': '图片来源',
  'Recorded model conversation': '录制的模型对话',
  'Conversation blocks': '对话块',
  'No recorded artifact snapshots': '此录制未包含产物快照',
  'The event archive contains no project files to display. Select a staged recording to view its recorded artifacts.':
    '该事件归档不含可展示的工程文件。包含阶段快照的录制可在此查看产物。',
  'Read-only replay · input disabled': '只读回放 · 输入已停用',
  'Source diagnostics': '源记录诊断',
  'Recorded context': '录制的上下文',
};

function StagePreview({
  stages,
  activeStageId,
  seek,
  t,
}: {
  stages: ReplayStage[];
  activeStageId?: string | null;
  seek: (position: number) => Promise<void>;
  t: (text: string) => string;
}) {
  const active = stages.find(stage => stage.id === activeStageId);
  const [image, setImage] = useState<ReplayImage & { assetId: string }>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [navigation, setNavigation] = useState<ViewNavigation | null>(null);
  const onReady = useCallback(() => setLoaded(true), []);
  const onError = useCallback((message: string) => setError(message), []);
  const revision = useRef(0);
  useEffect(() => {
    const request = ++revision.current;
    setImage(undefined);
    setLoaded(false);
    setError('');
    if (!active) return;
    void window.replayHost
      .image(active.assetId)
      .then(value => {
        if (request !== revision.current) return;
        if (value.mime !== 'image/png' || !value.dataUrl.startsWith('data:image/png;base64,'))
          throw Error('Replay snapshots require verified PNG image data');
        setImage({ ...value, assetId: active.assetId });
      })
      .catch(reason => {
        if (request === revision.current) setError(String(reason));
      });
    return () => {
      revision.current++;
    };
  }, [active?.assetId]);
  const opened = useMemo<OpenedViewer | undefined>(
    () =>
      image && active && image.assetId === active.assetId
        ? {
            kind: 'image',
            artifact: {
              id: active.assetId,
              kind: 'image',
              name: `${active.assetId}.png`,
              design: 'Recorded snapshot',
              sizeBytes: image.bytes,
              sha256: image.sha256,
              source: 'project file',
            },
            data: {
              name: active.title,
              images: [
                {
                  name: `${active.assetId}.png`,
                  url: image.dataUrl,
                  width: image.width,
                  height: image.height,
                  sha256: image.sha256,
                },
              ],
              columns: 1,
              rows: 1,
              animations: [],
              initialMode: 'image',
            },
          }
        : undefined,
    [image, active],
  );
  return (
    <section className="ia-replay-stage-panel" aria-label={t('Stage snapshots')}>
      <header className="ia-viewer-header ia-replay-stage-heading">
        <div>
          <small>{t('Stage snapshots')}</small>
          <h2>{active?.title || t('Play or select a stage to reveal its recorded snapshot.')}</h2>
          {active?.description && <p>{active.description}</p>}
        </div>
        <span>{t('Fixed camera · passive image')}</span>
        <div className="ia-view-navigation">
          <button
            disabled={!navigation?.ready}
            onClick={() => navigation?.zoomOut()}
            aria-label={t('Zoom out')}
          >
            −
          </button>
          <output>{navigation?.percent ?? 100}%</output>
          <button
            disabled={!navigation?.ready}
            onClick={() => navigation?.zoomIn()}
            aria-label={t('Zoom in')}
          >
            +
          </button>
          <button disabled={!navigation?.ready} onClick={() => navigation?.fit()}>
            {t('Fit')}
          </button>
        </div>
      </header>
      <div
        className="ia-replay-stage-canvas"
        data-stage-id={active?.id || ''}
        data-image-loaded={loaded ? 'true' : 'false'}
      >
        {opened && !error && (
          <ViewerCanvas
            key={opened.artifact.id}
            opened={opened}
            onReady={onReady}
            onError={onError}
            onNavigation={setNavigation}
          />
        )}
        {!active && <p>{t('Play or select a stage to reveal its recorded snapshot.')}</p>}
        {active && !loaded && !error && (
          <p className="ia-replay-image-loading" role="status">
            {t('Loading stage snapshot…')}
          </p>
        )}
        {error && (
          <p className="ia-replay-image-error" role="alert">
            {t('Stage image unavailable')}: {error}
          </p>
        )}
      </div>
      <nav className="ia-replay-stage-strip" aria-label={t('Stage snapshots')}>
        {stages.map((stage, index) => (
          <button
            key={stage.id}
            className={stage.id === active?.id ? 'active' : ''}
            aria-current={stage.id === active?.id ? 'step' : undefined}
            data-stage-control={stage.id}
            onClick={() => void seek(stage.position)}
          >
            <b>{String(index + 1).padStart(2, '0')}</b>
            <span>{stage.title}</span>
            <small>#{stage.atSeq}</small>
          </button>
        ))}
      </nav>
      {active && image && (
        <details className="ia-replay-stage-provenance">
          <summary>
            {t('Image source')} · {active.assetId}
          </summary>
          <p>
            {image.width} × {image.height} · {image.bytes.toLocaleString()} bytes · SHA-256{' '}
            {image.sha256}
          </p>
        </details>
      )}
    </section>
  );
}

function SourceRecord({ record, t }: { record: ReplayRecord; t: (value: string) => string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="ia-replay-source" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{t('Full source record')}</summary>
      {open && (
        <>
          <dl>
            <dt>{t('Source file')}</dt>
            <dd>
              {record.source?.sourceFile || '—'}:{record.source?.sourceLine || '—'}
            </dd>
            <dt>{t('Source event')}</dt>
            <dd>{record.source?.eventId || record.seq}</dd>
            <dt>{t('Source type')}</dt>
            <dd>{record.source?.type || record.event.type}</dd>
          </dl>
          <pre>{JSON.stringify(record, null, 2)}</pre>
        </>
      )}
    </details>
  );
}

function ReplayApp() {
  const [language, setLanguage] = useState(navigator.language.startsWith('zh') ? 'zh-CN' : 'en');
  const t = (text: string, values?: Record<string, string | number | undefined>) =>
    language === 'zh-CN' && messages[text]
      ? messages[text]
      : translate(language === 'zh-CN' ? 'zh-CN' : 'en', text, values);
  const [dark, setDark] = useState(false);
  const [metadata, setMetadata] = useState<Metadata>();
  const [state, setState] = useState<ReplayState>();
  const [page, setPage] = useState<ReplayPage>();
  const [agent, setAgent] = useState('');
  const [offset, setOffset] = useState(0);
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState('');
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [flow, setFlow] = useState<ReplayFlow>();
  const [turnOffset, setTurnOffset] = useState<number>();
  const [blockOffset, setBlockOffset] = useState<number>();
  const flowRevision = useRef(0);
  const chatScroll = useRef<HTMLDivElement>(null);
  const requestRevision = useRef(0);
  useEffect(() => {
    void window.replayHost
      .metadata()
      .then(value => {
        setMetadata(value);
        setState(value);
      })
      .catch(reason => setError(String(reason)));
    return window.replayHost.onChanged(setState);
  }, []);
  const reached = agent
    ? state?.agents.find(item => item.id === agent)?.reachedEvents || 0
    : state?.position || 0;
  const effectiveOffset = follow ? Math.max(0, Math.ceil(reached / 100) - 1) * 100 : offset;
  useEffect(() => {
    const revision = ++requestRevision.current;
    void window.replayHost
      .page({ agentId: agent, offset: effectiveOffset })
      .then(value => {
        if (revision === requestRevision.current) setPage(value);
      })
      .catch(reason => setError(String(reason)));
  }, [agent, effectiveOffset, reached]);
  useEffect(() => {
    const revision = ++flowRevision.current;
    void window.replayHost
      .flow({ agentId: agent, turnOffset, blockOffset })
      .then(value => {
        if (revision === flowRevision.current) setFlow(value);
      })
      .catch(reason => setError(String(reason)));
  }, [agent, state?.position, turnOffset, blockOffset]);
  useEffect(() => {
    if (follow && state?.phase === 'playing' && chatScroll.current)
      chatScroll.current.scrollTop = chatScroll.current.scrollHeight;
  }, [flow, follow, state?.phase]);
  async function control(action: string, value?: number) {
    try {
      setState(await window.replayHost.control({ action, value }));
    } catch (reason) {
      setError(String(reason));
    }
  }
  function chooseAgent(id: string) {
    setAgent(id);
    setOffset(0);
    setTurnOffset(undefined);
    setBlockOffset(undefined);
  }
  function turnPage(next: number) {
    setFollow(false);
    setOffset(next);
  }
  const agentName = (id: string) =>
    id === 'main' ? (language === 'zh-CN' ? '主代理' : 'Main agent') : id;
  function renderRecord({ sourceIndex, record }: ReplayPage['rows'][number]) {
    const event = record.event;
    const id = record.origin?.agentId || event.replayAgentId || 'main';
    const title =
      event.replayRole === 'user'
        ? t('Recorded user message')
        : event.type === 'tool'
          ? `${t('Recorded tool call')} · ${event.name || ''}`
          : event.type === 'tool-result'
            ? t('Recorded tool result')
            : event.type === 'thinking'
              ? t('Thinking')
              : event.type === 'text'
                ? t('Text')
                : record.source?.type || event.type;
    const content =
      event.type === 'tool' ? event.arguments : event.text || event.output || event.message;
    const body =
      typeof content === 'string' ? content : content ? JSON.stringify(content, null, 2) : '';
    return (
      <article
        className={`ia-replay-record ia-replay-${event.type}`}
        key={sourceIndex}
        data-source-index={sourceIndex}
        data-agent={id}
      >
        <header>
          <b>{title}</b>
          <span>
            {agentName(id)} · #{sourceIndex + 1} · {(record.relMs / 1000).toFixed(2)}s
          </span>
        </header>
        {body &&
          (body.length <= 2400 ? (
            <pre className="ia-replay-content">{body}</pre>
          ) : (
            <details className="ia-replay-content">
              <summary>
                {t('Show complete content')} · {body.length.toLocaleString()} {t('chars')}
              </summary>
              <pre>{body}</pre>
            </details>
          ))}
        <SourceRecord record={record} t={t} />
      </article>
    );
  }
  if (!metadata || !state)
    return (
      <main className="ia-replay-loading" role={error ? 'alert' : 'status'}>
        {error || t('Loading recording…')}
      </main>
    );
  const stages = metadata.replayStages || [];
  const constructed =
    metadata.manifest.demo?.constructed === true ||
    metadata.manifest.source?.kind === 'constructed-demo';
  const projectName =
    metadata.manifest.chat?.displayName || metadata.manifest.recordingId || t('Recording replay');
  const readOnlyAction = async () => {
    throw Error(t('Read-only replay · input disabled'));
  };
  return (
    <DisplayTextProvider value={{ locale: language, t }}>
      <div
        className={`rp-shell ia-app theme-${dark ? 'dark' : 'light'} layout-split ia-replay-product`}
        data-product-replay="true"
      >
        <div className="ia-columns">
          <aside className="ia-tree ia-sidebar" aria-label={t('Project navigation')}>
            <div className="ia-sidebar-brand">
              <span className="ia-product-mark">
                <img src="./product-mark.png" width="28" height="28" alt="" />
              </span>
              <b>Industrial Harness</b>
            </div>
            <div className="ia-projects-heading">
              <span>{t('PROJECTS')}</span>
            </div>
            <div className="ia-project-list">
              <div className="ia-project-group">
                <button className="ia-project-row selected" title={projectName}>
                  <span className="ia-project-row-name">{projectName}</span>
                </button>
                <div className="ia-project-chats">
                  {state.agents.map(item => (
                    <button
                      key={item.id}
                      className={`ia-sidebar-chat ${(agent || state.agents[0]?.id) === item.id ? 'selected' : ''}`}
                      onClick={() => chooseAgent(item.id)}
                      data-agent-filter={item.id}
                    >
                      <AgentGlyph seed={item.id} />
                      <span>{agentName(item.id)}</span>
                      <small>{item.reachedEvents.toLocaleString()}</small>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="ia-replay-sidebar-foot">
              <small>
                {t('Recording replay')} · {t('Internal · Read only')}
              </small>
              {constructed && (
                <span className="ia-replay-demo-badge" data-constructed-demo="true">
                  {t('Constructed demo')}
                </span>
              )}
              <select
                aria-label={t('Theme')}
                value={dark ? 'dark' : 'light'}
                onChange={event => setDark(event.target.value === 'dark')}
              >
                <option value="light">{t('Light')}</option>
                <option value="dark">{t('Dark')}</option>
              </select>
              <select
                aria-label="Language"
                value={language}
                onChange={event => setLanguage(event.target.value)}
              >
                <option value="en">English</option>
                <option value="zh-CN">简体中文</option>
              </select>
            </div>
          </aside>
          <div className="ia-workbench ia-replay-workbench">
            <div className="ia-workbench-content">
              <main className="ia-chat" id="ia-chat-panel">
                <header className="ia-chat-header">
                  <div>
                    <b>{t('Recorded model conversation')}</b>
                    <span>{agentName(flow?.agentId || agent || 'main')}</span>
                  </div>
                  <small>{t('Recording replay')}</small>
                </header>
                <div className="ia-replay-conversation-notice">
                  {t(
                    constructed
                      ? 'This is a constructed demonstration. Stage images illustrate the sequence; they are not engineering verification results.'
                      : 'Historical content and instructions are displayed as recorded data. Playback does not call models, tools, or scripts.',
                  )}
                </div>
                <nav className="ia-replay-flow-pages">
                  <label>
                    {t('Turn')}{' '}
                    <input
                      data-flow-turn-offset
                      type="number"
                      min="0"
                      max={Math.max(0, (flow?.totalTurns || 1) - 1)}
                      value={flow?.turnOffset || 0}
                      onChange={event => {
                        setTurnOffset(Number(event.target.value));
                        setBlockOffset(undefined);
                      }}
                    />
                  </label>
                  <span>/ {flow?.totalTurns || 0}</span>
                  <button
                    disabled={!flow?.turn || flow.turn.blockOffset === 0}
                    onClick={() => setBlockOffset(Math.max(0, (flow?.turn?.blockOffset || 0) - 40))}
                  >
                    ‹
                  </button>
                  <label>
                    {t('Conversation blocks')}{' '}
                    <input
                      data-flow-block-offset
                      type="number"
                      min="0"
                      max={flow?.turn?.totalBlocks || 0}
                      value={flow?.turn?.blockOffset || 0}
                      onChange={event => setBlockOffset(Number(event.target.value))}
                    />
                  </label>
                  <span>/ {flow?.turn?.totalBlocks || 0}</span>
                  <button
                    disabled={!flow?.turn || flow.turn.blockOffset + 40 >= flow.turn.totalBlocks}
                    onClick={() => setBlockOffset((flow?.turn?.blockOffset || 0) + 40)}
                  >
                    ›
                  </button>
                </nav>
                <div className="ia-chat-scroll-area">
                  <div
                    className="ia-chat-scroll"
                    ref={chatScroll}
                    data-flow-ready={flow ? 'true' : 'false'}
                    data-flow-position={flow?.position}
                  >
                    {flow?.turn ? (
                      <div className="ia-chat-turn" data-turn-id={flow.turn.id}>
                        {flow.turn.task && (
                          <div className="ia-user-entry ia-message">
                            <div className="ia-user-message">{flow.turn.task}</div>
                          </div>
                        )}
                        <AgentFlow
                          events={flow.turn.events}
                          running={false}
                          debug={false}
                          approve={readOnlyAction}
                          answer={readOnlyAction}
                          turnId={flow.turn.id}
                        />
                      </div>
                    ) : (
                      <div className="ia-chat-welcome">
                        <h1>{t('Recording replay')}</h1>
                        <p>{t('Play or select a stage to reveal its recorded snapshot.')}</p>
                      </div>
                    )}
                  </div>
                </div>
                <div className="ia-composer-wrap">
                  <div className="ia-composer ia-replay-readonly-composer">
                    {t('Read-only replay · input disabled')}
                  </div>
                </div>
              </main>
              <section className="ia-viewer ia-workspace" id="ia-workspace-panel">
                {stages.length > 0 ? (
                  <StagePreview
                    stages={stages}
                    activeStageId={state.activeStageId}
                    seek={position => control('seek', position)}
                    t={t}
                  />
                ) : (
                  <>
                    <header className="ia-viewer-header">
                      <b>{t('Workspace')}</b>
                    </header>
                    <div className="ia-replay-no-artifact">
                      <h2>{t('No recorded artifact snapshots')}</h2>
                      <p>
                        {t(
                          'The event archive contains no project files to display. Select a staged recording to view its recorded artifacts.',
                        )}
                      </p>
                    </div>
                  </>
                )}
              </section>
            </div>
            <section className="ia-replay-controls" aria-label={t('Playback position')}>
              <div className="ia-replay-buttons">
                <button
                  onClick={() => void control(state.phase === 'playing' ? 'pause' : 'play')}
                  disabled={state.atEnd}
                  data-control="play"
                >
                  {t(state.phase === 'playing' ? 'Pause' : 'Play')}
                </button>
                <button onClick={() => void control('reset')} data-control="reset">
                  {t('Reset')}
                </button>
                <button onClick={() => void control('seek', 0)}>{t('Start')}</button>
                <button onClick={() => void control('seek', state.totalEvents)} data-control="end">
                  {t('End')}
                </button>
                <label>
                  {t('Speed')}{' '}
                  <select
                    value={state.speed}
                    onChange={event => void control('speed', Number(event.target.value))}
                    data-control="speed"
                  >
                    {[0.5, 1, 2, 4].map(speed => (
                      <option key={speed} value={speed}>
                        {speed}×
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ia-replay-follow">
                  <input
                    type="checkbox"
                    checked={follow}
                    onChange={event => setFollow(event.target.checked)}
                  />
                  {t('Follow playback')}
                </label>
              </div>
              <input
                type="range"
                min="0"
                max={state.totalEvents}
                value={state.position}
                aria-label={t('Playback position')}
                onChange={event => void control('seek', Number(event.target.value))}
                data-control="position"
              />
              <div
                className="ia-replay-progress"
                data-position={state.position}
                data-total={state.totalEvents}
              >
                <strong>
                  {t(state.atEnd ? 'Complete source coverage' : 'Reached')} ·{' '}
                  {state.position.toLocaleString()} / {state.totalEvents.toLocaleString()}
                </strong>
                <span>
                  {t('Source time')} · {(state.sourceMs / 1000).toFixed(1)}s ·{' '}
                  {t('Recording status')}: {t(metadata.manifest.status || '')}
                </span>
              </div>
            </section>
            {error && (
              <p className="ia-replay-error" role="alert">
                {t('Replay error')}: {error}
              </p>
            )}
            <details className="ia-replay-diagnostics">
              <summary>
                {t('Source diagnostics')} · {state.position.toLocaleString()} /{' '}
                {state.totalEvents.toLocaleString()}
              </summary>
              {metadata.warnings.length > 0 && (
                <pre>{JSON.stringify(metadata.warnings, null, 2)}</pre>
              )}
              <details
                className="ia-replay-ledger"
                open={ledgerOpen}
                onToggle={event => setLedgerOpen(event.currentTarget.open)}
              >
                <summary>
                  {t('Recorded event ledger')} · {state.position.toLocaleString()} /{' '}
                  {state.totalEvents.toLocaleString()}
                </summary>
                <div className="ia-replay-body">
                  <aside className="ia-replay-agents">
                    <button
                      className={agent === '' ? 'active' : ''}
                      onClick={() => chooseAgent('')}
                      data-debug-agent-filter=""
                    >
                      <b>{t('All agents')}</b>
                      <span>
                        {state.position.toLocaleString()} / {state.totalEvents.toLocaleString()}{' '}
                        {t('events')}
                      </span>
                    </button>
                    {state.agents.map(item => (
                      <button
                        key={item.id}
                        className={agent === item.id ? 'active' : ''}
                        onClick={() => chooseAgent(item.id)}
                        data-debug-agent-filter={item.id}
                      >
                        <b>{agentName(item.id)}</b>
                        <span>
                          {item.reachedEvents.toLocaleString()} /{' '}
                          {item.totalEvents.toLocaleString()} {t('events')}
                        </span>
                        {item.turnCount != null && (
                          <small>
                            {item.turnCount} {t('turns')}
                          </small>
                        )}
                      </button>
                    ))}
                  </aside>
                  <main className="ia-replay-events" aria-live="off">
                    <nav className="ia-replay-pagination">
                      <button
                        disabled={!page || page.offset === 0}
                        onClick={() => turnPage((page?.offset || 0) - 100)}
                        data-control="previous"
                      >
                        {t('Previous page')}
                      </button>
                      <span>
                        {t('Page')} {page ? Math.floor(page.offset / 100) + 1 : 1} {t('of')}{' '}
                        {Math.max(1, Math.ceil((page?.total || 0) / 100))} ·{' '}
                        {page?.total.toLocaleString()} {t('events')}
                      </span>
                      <button
                        disabled={!page || page.offset + 100 >= page.total}
                        onClick={() => turnPage((page?.offset || 0) + 100)}
                        data-control="next"
                      >
                        {t('Next page')}
                      </button>
                    </nav>
                    <div className="ia-replay-rows">
                      {page?.rows.length ? (
                        page.rows.map(renderRecord)
                      ) : (
                        <p className="ia-replay-empty">{t('No events reached for this agent.')}</p>
                      )}
                    </div>
                  </main>
                </div>
              </details>
            </details>
          </div>
        </div>
      </div>
    </DisplayTextProvider>
  );
}

createRoot(document.getElementById('root')!).render(<ReplayApp />);

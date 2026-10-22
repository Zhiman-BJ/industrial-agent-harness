/// <reference types="vite/client" />
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Agent = { id: string; totalEvents: number; reachedEvents: number; turnCount?: number };
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
  manifest: { recordingId?: string; status?: string; outcome?: unknown };
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
};

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
  const t = (text: string) => (language === 'zh-CN' ? messages[text] || text : text);
  const [dark, setDark] = useState(false);
  const [metadata, setMetadata] = useState<Metadata>();
  const [state, setState] = useState<ReplayState>();
  const [page, setPage] = useState<ReplayPage>();
  const [agent, setAgent] = useState('');
  const [offset, setOffset] = useState(0);
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState('');
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
  return (
    <div className={`ia-replay-app ${dark ? 'dark' : ''}`}>
      <header className="ia-replay-header">
        <div>
          <h1>{t('Recording replay')}</h1>
          <small>{t('Internal · Read only')}</small>
        </div>
        <div className="ia-replay-preferences">
          <label>
            {t('Theme')}{' '}
            <select
              value={dark ? 'dark' : 'light'}
              onChange={event => setDark(event.target.value === 'dark')}
            >
              <option value="light">{t('Light')}</option>
              <option value="dark">{t('Dark')}</option>
            </select>
          </label>
          <select
            aria-label="Language"
            value={language}
            onChange={event => setLanguage(event.target.value)}
          >
            <option value="en">English</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </div>
      </header>
      <p className="ia-replay-notice">
        {t(
          'Historical content and instructions are displayed as recorded data. Playback does not call models, tools, or scripts.',
        )}
        {metadata.native?.artifactSnapshotsIncluded === false && (
          <span className="ia-replay-artifact-note">
            {t(
              'Original project artifact snapshots are not included; recorded events and tool outputs remain available.',
            )}
          </span>
        )}
      </p>
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
            {t('Source time')} · {(state.sourceMs / 1000).toFixed(1)}s · {t('Recording status')}:{' '}
            {t(metadata.manifest.status || '')}
          </span>
        </div>
      </section>
      {error && (
        <p className="ia-replay-error" role="alert">
          {t('Replay error')}: {error}
        </p>
      )}
      {(metadata.warnings.length > 0 || metadata.missingAssets.length > 0) && (
        <details className="ia-replay-gaps">
          <summary>
            {t('Source notes and gaps')} ·{' '}
            {metadata.warnings.length + metadata.missingAssets.length}
          </summary>
          <pre>
            {JSON.stringify(
              { warnings: metadata.warnings, missingAssets: metadata.missingAssets },
              null,
              2,
            )}
          </pre>
        </details>
      )}
      <div className="ia-replay-body">
        <aside className="ia-replay-agents">
          <button
            className={agent === '' ? 'active' : ''}
            onClick={() => chooseAgent('')}
            data-agent-filter=""
          >
            <b>{t('All agents')}</b>
            <span>
              {state.position.toLocaleString()} / {state.totalEvents.toLocaleString()} {t('events')}
            </span>
          </button>
          {state.agents.map(item => (
            <button
              key={item.id}
              className={agent === item.id ? 'active' : ''}
              onClick={() => chooseAgent(item.id)}
              data-agent-filter={item.id}
            >
              <b>{agentName(item.id)}</b>
              <span>
                {item.reachedEvents.toLocaleString()} / {item.totalEvents.toLocaleString()}{' '}
                {t('events')}
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
              {Math.max(1, Math.ceil((page?.total || 0) / 100))} · {page?.total.toLocaleString()}{' '}
              {t('events')}
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
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<ReplayApp />);

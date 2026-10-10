import { DomainIcon } from '@industrial-agent-harness/viewer-builtin/domain-icon';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import { useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import type { DomainOption } from '@industrial-agent-harness/viewer-builtin/api';

type Draft = { directory: string; name: string; domain: string };

const DOMAIN_DESCRIPTIONS: Record<string, string> = {
  chip: 'Chip design: RTL, synthesis, netlist, GDS layout and waveform review.',
  pcb: 'PCB design: schematics, layout, fabrication outputs (KiCad).',
  cad: 'Mechanical CAD: 3D models and drawings (FreeCAD).',
  cuda: 'GPU compute: CUDA kernels and performance work.',
  godot: 'Game/simulation engineering with the Godot engine.',
};

export function CreateProjectModal({
  draft,
  domains,
  error,
  onChange,
  onChooseDirectory,
  onClose,
  onCreate,
}: {
  draft: Draft;
  domains: DomainOption[];
  error: string;
  onChange: (draft: Draft) => void;
  onChooseDirectory: () => Promise<void>;
  onClose: () => void;
  onCreate: (request: Draft) => Promise<void>;
}) {
  const { t } = useDisplayText();
  const [saving, setSaving] = useState(false);
  async function create() {
    setSaving(true);
    try {
      await onCreate(draft);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div
      className="ia-modal-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="ia-model-modal ia-create-project"
        role="dialog"
        aria-modal="true"
        aria-label={t('Create project')}
      >
        <header>
          <div>
            <h2>{t('New project')}</h2>
            <p>{t('Choose a folder and a domain for this project.')}</p>
          </div>
          <button onClick={onClose} aria-label={t('Close project creation')}>
            <X size={17} />
          </button>
        </header>
        <div className="ia-model-fields">
          <label>
            {t('Project name')}{' '}
            <input
              value={draft.name}
              onChange={event => onChange({ ...draft, name: event.target.value })}
              maxLength={100}
              placeholder={t('Project name')}
            />
          </label>
          <div className="ia-create-field">
            <span>{t('Local directory')}</span>
            <button className="ia-folder-picker" onClick={() => void onChooseDirectory()}>
              <FolderOpen size={15} />
              <span>{draft.directory || t('Choose folder…')}</span>
            </button>
            <small className="ia-create-hint">
              {t(
                'Existing files are kept as-is; the agent only writes after you approve an action.',
              )}
            </small>
          </div>
          <div className="ia-create-field">
            <span>{t('Domain')}</span>
            <div className="ia-domain-choices" role="group" aria-label={t('New project domain')}>
              {domains.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className="ia-domain-choice"
                  aria-pressed={draft.domain === item.id}
                  title={t(DOMAIN_DESCRIPTIONS[item.id] || item.label)}
                  onClick={() => onChange({ ...draft, domain: item.id })}
                >
                  <DomainIcon domain={item.id} />
                  {t(item.label)}
                </button>
              ))}
            </div>
            {draft.domain && DOMAIN_DESCRIPTIONS[draft.domain] && (
              <small className="ia-create-hint">{t(DOMAIN_DESCRIPTIONS[draft.domain])}</small>
            )}
          </div>
          {error && <p className="ia-model-error">{t(error)}</p>}
        </div>
        <footer>
          <span />
          <button onClick={onClose}>{t('Cancel')}</button>
          <button
            className="primary"
            onClick={() => void create()}
            disabled={saving || !draft.directory || !draft.name.trim() || !draft.domain}
          >
            {saving ? t('Creating…') : t('Create project')}
          </button>
        </footer>
      </section>
    </div>
  );
}

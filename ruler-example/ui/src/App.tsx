import { useEffect, useRef, useState } from 'react';
import { api, getActor, setActor, type Kind } from './api';
import { EditorPage, type EditorMode } from './editor';
import { Dropdown } from './dropdown';
import { ExprEditorPage } from './exprEditor';
import { applyTheme, cached, clearCache, readStore, savedTheme, useAsync, useHash, writeStore, type Theme } from './hooks';
import { ListPage } from './list';
import { ApiErrorBox, Button, Icon, Modal } from './ui';

// Routes: #/?case=&tab=   #/new?case=   #/tree/{case}/{name}?mode=view|edit&version=
function parse(hash: string) {
  const [path, q = ''] = hash.split('?');
  const params = new URLSearchParams(q);
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { parts, params };
}

export function App() {
  const [hash, go] = useHash();
  const { parts, params } = parse(hash);
  const cases = useAsync('cases', () => cached('cases', api.cases));
  // Coming back to the tab: the server may have restarted with new cases or attributes.
  useEffect(() => {
    const onFocus = () => {
      clearCache();
      cases.reload();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [actor, setActorState] = useState(getActor());
  const [asking, setAsking] = useState<(() => void) | null>(null);

  // A remembered case that the server no longer has falls back to the first one.
  const known = (c: string | null | undefined) => (c && (!cases.data || cases.data.some((x) => x.name === c)) ? c : undefined);
  const caseName =
    params.get('case') ?? (parts[1] !== 'new' ? parts[1] : undefined) ?? known(readStore('ruler.case')) ?? cases.data?.[0]?.name ?? '';
  useEffect(() => {
    if (caseName) writeStore('ruler.case', caseName);
  }, [caseName]);

  /** Mutations record who did them (X-Ruler-Actor): ask for a name once, then continue. */
  const withActor = (fn: () => void) => (getActor() ? fn() : setAsking(() => fn));

  let page;
  if (cases.error) page = <div className="page"><ApiErrorBox error={cases.error} /><p className="muted">Is ruler-example running on :9090?</p></div>;
  else if (!cases.data) page = <div className="page empty">Loading…</div>;
  else if (parts[0] === 'new') page = <EditorPage mode="new" caseName={caseName} go={go} withActor={withActor} />;
  else if (parts[0] === 'expr' && parts[1] === 'new') page = <ExprEditorPage mode="new" caseName={caseName} go={go} withActor={withActor} />;
  else if (parts[0] === 'expr' && parts[2])
    page = (
      <ExprEditorPage
        mode={(params.get('mode') as EditorMode) ?? 'view'}
        caseName={parts[1]}
        name={parts[2]}
        version={params.get('version') ? Number(params.get('version')) : undefined}
        go={go}
        withActor={withActor}
      />
    );
  else if (parts[0] === 'tree' && parts[2])
    page = (
      <EditorPage
        mode={(params.get('mode') as EditorMode) ?? 'view'}
        caseName={parts[1]}
        name={parts[2]}
        version={params.get('version') ? Number(params.get('version')) : undefined}
        go={go}
        withActor={withActor}
      />
    );
  else page = <ListPage caseName={caseName} tab={(params.get('tab') as Kind) ?? 'decision-trees'} go={go} withActor={withActor} />;

  const onEditor = parts[0] === 'new' || parts[0] === 'tree' || parts[0] === 'expr';
  return (
    <div className={`app ${onEditor ? 'app-editor' : ''}`}>
      <header className="topbar">
        <a className="brand" href={`#/?case=${encodeURIComponent(caseName)}`}>
          <span className="brand-mark">
            <Icon name="tree" size={16} />
          </span>
          Ruler <span className="brand-sub">Studio</span>
        </a>
        {!onEditor && cases.data && (
          <label className="case-pick">
            <span className="muted small">Case</span>
            <Dropdown
              ariaLabel="Case"
              value={caseName}
              onChange={(c) => go(`/?case=${encodeURIComponent(c)}`)}
              options={cases.data.map((c) => ({ value: c.name, label: c.name, meta: `${c.attribute_count} attributes` }))}
            />
          </label>
        )}
        <div className="spacer" />
        <ThemeSwitch />
        <ActorField
          actor={actor}
          onChange={(a) => {
            setActor(a);
            setActorState(a);
          }}
        />
      </header>
      <main>{page}</main>
      {asking && (
        <ActorPrompt
          onClose={() => setAsking(null)}
          onSet={(a) => {
            setActor(a);
            setActorState(a);
            const next = asking;
            setAsking(null);
            next();
          }}
        />
      )}
    </div>
  );
}

const THEMES: { value: Theme; icon: string; label: string }[] = [
  { value: 'light', icon: 'sun', label: 'Light' },
  { value: 'dark', icon: 'moon', label: 'Dark' },
  { value: 'system', icon: 'monitor', label: 'System' },
];

function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(savedTheme());
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme">
      {THEMES.map((t) => (
        <button
          key={t.value}
          role="radio"
          aria-checked={theme === t.value}
          aria-label={t.label}
          title={`${t.label} theme`}
          className={theme === t.value ? 'on' : ''}
          onClick={() => {
            applyTheme(t.value);
            setTheme(t.value);
          }}
        >
          <Icon name={t.icon} size={15} />
        </button>
      ))}
    </div>
  );
}

function ActorField({ actor, onChange }: { actor: string; onChange: (a: string) => void }) {
  const [value, setValue] = useState(actor);
  useEffect(() => setValue(actor), [actor]);
  return (
    <label className="actor" title="Recorded as created_by / updated_by on every change">
      <Icon name="user" />
      <input
        value={value}
        placeholder="Your name"
        aria-label="Acting as"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onChange(value.trim())}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

function ActorPrompt({ onClose, onSet }: { onClose: () => void; onSet: (a: string) => void }) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Modal
      title="Who is making this change?"
      subtitle="Your name is recorded on every version and status change."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!value.trim()} onClick={() => onSet(value.trim())}>
            Continue
          </Button>
        </>
      }
    >
      <input ref={ref} value={value} placeholder="e.g. jatin" onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && value.trim() && onSet(value.trim())} />
    </Modal>
  );
}

// Sample input + Calculate: runs the saved version with explain=true and hands the steps to the canvas to highlight.
import { useState } from 'react';
import { api, type EvaluationResult, type Kind } from './api';
import { buildTrace, showValue, type Trace } from './model';
import { ApiErrorBox, Button, Icon } from './ui';

export interface RunState {
  running: boolean;
  result?: EvaluationResult;
  error?: unknown;
}

/** Runs one saved version of a tree or expression; `trace` drives the highlighting on the canvas. */
export function useRun(kind: Kind, caseName: string, name: string, version: number | undefined) {
  const [state, setState] = useState<RunState>({ running: false });
  const [trace, setTrace] = useState<Trace | null>(null);
  const run = async (input: unknown) => {
    if (!version) return;
    setState({ running: true });
    try {
      const opts = { version, explain: true };
      const result = kind === 'decision-trees' ? await api.evaluate(caseName, name, input, opts) : await api.evaluateExpression(caseName, name, input, opts);
      setState({ running: false, result });
      setTrace(buildTrace(result.explanation?.steps ?? [], result.explanation?.attributes ?? []));
    } catch (error) {
      setState({ running: false, error });
      setTrace(null);
    }
  };
  const clear = () => {
    setState({ running: false });
    setTrace(null);
  };
  return { state, trace, run, clear };
}

/** The sample input saved with the version, docked on the right of the canvas, with Calculate and its result. */
export function SamplePanel({
  text,
  error,
  readOnly,
  onChange,
  onClose,
  run,
  onCalculate,
  onClear,
  runNote,
  cannotRun,
}: {
  text: string;
  error?: string;
  readOnly: boolean;
  onChange: (t: string) => void;
  onClose: () => void;
  run: RunState;
  onCalculate: () => void;
  onClear: () => void;
  /** e.g. "Runs saved v2 — unsaved changes are not included" */
  runNote?: string;
  /** Why Calculate is not possible (e.g. never saved); undefined = it is. */
  cannotRun?: string;
}) {
  const r = run.result;
  return (
    <aside className="sample-panel" aria-label="Sample input">
      <div className="sample-head">
        <Icon name="code" />
        <strong>Sample input</strong>
        <span className="spacer" />
        <button className="icon-btn" aria-label="Close the sample input" title="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <p className="hint">Saved with the version. Change it and press Calculate to see what the rule returns and which path it took.</p>
      <textarea className={`code-area ${error ? 'invalid' : ''}`} spellCheck={false} value={text} onChange={(e) => onChange(e.target.value)} aria-label="Sample input JSON" readOnly={false} />
      {error && <div className="field-error">{error}</div>}
      {readOnly && <div className="hint">Edits here are only for trying values; they are not saved.</div>}

      <div className="run-bar">
        <Button variant="primary" onClick={onCalculate} disabled={!!cannotRun || !!error || run.running} title={cannotRun ?? error}>
          <Icon name="play" /> {run.running ? 'Calculating…' : 'Calculate'}
        </Button>
        {(r || run.error !== undefined) && (
          <Button variant="ghost" onClick={onClear} title="Remove the result and the highlights">
            Clear
          </Button>
        )}
      </div>
      {(cannotRun || runNote) && <div className="hint">{cannotRun ?? runNote}</div>}

      {run.error ? <ApiErrorBox error={run.error} /> : null}
      {r && (
        <div className="run-result">
          <div className="run-label">
            Result <span className="muted small">v{r.version}{r.result_type ? ` · ${r.result_type}` : ''}</span>
          </div>
          <ResultValue value={r.value} />
          {r.explanation && r.explanation.attributes.length > 0 && (
            <>
              <div className="run-label">Values it used</div>
              <dl className="run-attrs">
                {r.explanation.attributes.map((a, i) => (
                  <div key={i}>
                    <dt title={a.path ?? a.code}>
                      {a.code}
                      {a.params && <span className="muted"> ({Object.entries(a.params).map(([k, v]) => `${k}=${showValue(v)}`).join(', ')})</span>}
                    </dt>
                    <dd>{showValue(a.value)}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

/** A map result as a small table, anything else as one big value. */
function ResultValue({ value }: { value: unknown }) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (
      <dl className="run-map">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{showValue(v)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return <div className="run-value">{showValue(value)}</div>;
}

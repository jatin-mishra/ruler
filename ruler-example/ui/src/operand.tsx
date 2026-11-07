// Editors for one operand: an attribute (with inline params when dynamic) or a typed constant.
import { createContext, useContext } from 'react';
import { api, typeLabel, type AttributeView, type ParamView, type ReturnSpec, type TypeRef, type ValidationError } from './api';
import { cached, useAsync } from './hooks';
import {
  emptyConstant,
  fieldErrors,
  findAttribute,
  operandToJson,
  samePath,
  type AttributeOperand,
  type ConstantOperand,
  type Operand,
  type ParamBind,
} from './model';
import { Dropdown, type Option } from './dropdown';
import { Icon, Segmented } from './ui';

export interface EditorEnv {
  caseName: string;
  attrs: AttributeView[];
  dataTypes: { name: string; numeric: boolean }[];
  returns: ReturnSpec;
  readOnly: boolean;
}
export const EditorContext = createContext<EditorEnv>(null as unknown as EditorEnv);
export const useEditor = () => useContext(EditorContext);

/** Attributes that fit a slot type (server-side widening rules, lld §16 C); no slot → all of them. */
export function useSlotAttributes(slot?: TypeRef): AttributeView[] | undefined {
  const { caseName, attrs } = useEditor();
  const key = slot ? `attrs|${caseName}|${typeLabel(slot)}` : null;
  const res = useAsync(key, () => cached(key!, () => api.attributes(caseName, slot).then((r) => r.attributes)));
  return slot ? res.data : attrs;
}

type OperandKind = 'ATTRIBUTE' | 'CONSTANT';

export function OperandEditor({
  value,
  onChange,
  slot,
  path,
  errors,
  compact,
  choices,
}: {
  value: Operand | null;
  onChange: (op: Operand | null) => void;
  /** Enum values the constant must be one of (from the other side's attribute); shown as a dropdown. */
  choices?: string[];
  /** The type this operand must fit; omitted for a condition's lhs, which sets the type. */
  slot?: TypeRef;
  path: string;
  errors: ValidationError[];
  compact?: boolean;
}) {
  const { readOnly } = useEditor();
  const mine = fieldErrors(errors, path);

  // Conditions take attributes and constants only (lld Q17); anything else loaded from JSON is shown, not edited.
  if (value && value.kind !== 'ATTRIBUTE' && value.kind !== 'CONSTANT') {
    const json = operandToJson(value);
    return (
      <div className="raw-op">
        <span className="raw-chip" title={JSON.stringify(json, null, 2)}>
          <Icon name="code" size={14} /> {exprSummary(json)}
        </span>
        {!readOnly && (
          <button type="button" className="link" onClick={() => onChange(null)}>
            Replace
          </button>
        )}
        <FieldErrors errors={mine} />
      </div>
    );
  }

  const kind: OperandKind | '' = value?.kind ?? '';
  const pick = (k: OperandKind) => {
    if (k === kind) return;
    onChange(k === 'CONSTANT' ? emptyConstant(slot ?? { container_type: 'primitive', data_type: 'string' }) : { kind: 'ATTRIBUTE', ref: '', params: {} });
  };
  return (
    <div className={`operand ${compact ? 'operand-compact' : ''} ${mine.length ? 'has-error' : ''}`}>
      <Segmented<OperandKind | ''>
        size="sm"
        value={kind}
        onChange={(k) => k && pick(k)}
        options={[
          { value: 'ATTRIBUTE', label: 'Attribute' },
          { value: 'CONSTANT', label: 'Constant' },
        ]}
      />
      {value?.kind === 'ATTRIBUTE' && <AttributePicker value={value} onChange={onChange} slot={slot} />}
      {value?.kind === 'CONSTANT' && <ConstantEditor value={value} onChange={onChange} slot={slot} choices={choices} />}
      {!value && <div className="hint">Choose where the value comes from</div>}
      <FieldErrors errors={mine} />
    </div>
  );
}

/**
 * Link to a saved expression's own page, at the version this rule is pinned to. While editing it opens a new tab,
 * so unsaved work here is not lost; while viewing it navigates in place.
 */
export function ExpressionLink({ refKey, version, compact }: { refKey: string; version: number; compact?: boolean }) {
  const { readOnly } = useEditor();
  const i = refKey.indexOf(':');
  if (i < 0 || !version) return null;
  const caseName = refKey.slice(0, i);
  const name = refKey.slice(i + 1);
  return (
    <a
      className={compact ? 'icon-btn ref-link-icon' : 'ref-link'}
      href={`#/expr/${encodeURIComponent(caseName)}/${encodeURIComponent(name)}?mode=view&version=${version}`}
      target={readOnly ? undefined : '_blank'}
      rel="noopener"
      title={`Open ${name} v${version}${readOnly ? '' : ' in a new tab'}`}
    >
      {compact ? <Icon name="external" size={14} /> : (
        <>
          Open {name} v{version} <Icon name="external" size={12} />
        </>
      )}
    </a>
  );
}

export function FieldErrors({ errors }: { errors: ValidationError[] }) {
  if (!errors.length) return null;
  return (
    <div className="field-errors">
      {errors.map((e, i) => (
        <div key={i}>
          <Icon name="alert" size={13} /> {e.message}
        </div>
      ))}
    </div>
  );
}

// ---------- attribute ----------

export function AttributePicker({ value, onChange, slot }: { value: AttributeOperand; onChange: (op: Operand) => void; slot?: TypeRef }) {
  const { attrs } = useEditor();
  const options = useSlotAttributes(slot);
  const meta = findAttribute(attrs, value.ref);
  const refOf = (a: AttributeView) => (a.dynamic ? a.code : a.path!);
  const fixed = (options ?? []).filter((a) => !a.dynamic);
  const computed = (options ?? []).filter((a) => a.dynamic);
  const missing = value.ref !== '' && options && !options.some((a) => (a.dynamic ? a.code === value.ref : samePath(a.path, value.ref)));

  return (
    <div className="attr">
<Dropdown
        ariaLabel="Attribute"
        value={meta && !missing ? refOf(meta) : value.ref}
        onChange={(ref) => onChange({ kind: 'ATTRIBUTE', ref, params: {} })}
        placeholder={options === undefined ? 'Loading…' : options.length ? 'Select attribute…' : 'No attribute fits this type'}
        invalid={!!missing}
        options={[
          ...(missing ? [{ value: value.ref, label: `${meta?.name ?? value.ref} (does not fit)`, disabled: true }] : []),
          ...fixed.map((a) => attributeOption(a, refOf(a), 'From the input')),
          ...computed.map((a) => attributeOption(a, refOf(a), 'Computed')),
        ]}
      />
      {meta && (
        <div className="attr-meta">
          <span className="type-chip">{typeLabel(meta.type)}</span>
          <code>{meta.dynamic ? `ƒ ${meta.code}` : meta.path}</code>
          {meta.description && <span className="attr-desc">{meta.description}</span>}
          {meta.type.enum_values?.length ? <span className="attr-desc">One of: {meta.type.enum_values.join(', ')}</span> : null}
        </div>
      )}
      {meta?.dynamic && meta.params.length > 0 && (
        <ParamsEditor params={meta.params} value={value.params} onChange={(params) => onChange({ ...value, params })} />
      )}
    </div>
  );
}

/** An attribute as a dropdown option: name, its type on the right, its description below. */
export const attributeOption = (a: AttributeView, value: string, group?: string): Option => ({
  value,
  label: a.name,
  group,
  meta: typeLabel(a.type),
  hint: a.description ?? (a.type.enum_values?.length ? `One of ${a.type.enum_values.join(', ')}` : a.path ?? undefined),
  icon: a.dynamic ? 'ƒ' : undefined,
});

export function ParamsEditor({
  params,
  value,
  onChange,
}: {
  params: ParamView[];
  value: Record<string, ParamBind>;
  onChange: (v: Record<string, ParamBind>) => void;
}) {
  return (
    <div className="params">
      <div className="params-title">Parameters</div>
      {params.map((p) => {
        const bind: ParamBind = value[p.name] ?? { source: 'CONSTANT', value: '' };
        const set = (b: ParamBind) => onChange({ ...value, [p.name]: b });
        return (
          <div className="param" key={p.name}>
            <div className="param-head">
              <span className="param-name">
                {p.name}
                {p.required && <span className="req" title="required">*</span>}
              </span>
              <span className="param-type">{typeLabel(p.type)}</span>
              <button
                type="button"
                className="param-source"
                title={bind.source === 'CONSTANT' ? 'Take this value from an attribute of the input' : 'Type the value instead'}
                onClick={() => set(bind.source === 'CONSTANT' ? { source: 'ATTRIBUTE', ref: '' } : { source: 'CONSTANT', value: '' })}
              >
                {bind.source === 'CONSTANT' ? 'use attribute' : 'type value'}
              </button>
            </div>
            {p.description && <div className="hint">{p.description}</div>}
            {bind.source === 'CONSTANT' ? (
              p.type.container_type === 'list' ? (
                <ListInput
                  dataType={p.type.data_type}
                  choices={p.allowed_values.length ? p.allowed_values.map(String) : undefined}
                  items={bind.items ?? ['']}
                  onChange={(items) => set({ source: 'CONSTANT', value: '', items })}
                />
              ) : (
                <ParamValueInput param={p} value={bind.value} onChange={(v) => set({ source: 'CONSTANT', value: v })} />
              )
            ) : (
              <StaticAttributeSelect slot={p.type} value={bind.ref} onChange={(ref) => set({ source: 'ATTRIBUTE', ref })} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ParamValueInput({ param, value, onChange }: { param: ParamView; value: string; onChange: (v: string) => void }) {
  const dflt = param.default_value === null || param.default_value === undefined ? null : String(param.default_value);
  const empty = param.required ? 'Select…' : `Default${dflt !== null ? ` (${dflt})` : ''}`;
  const choices = param.allowed_values.length ? param.allowed_values.map(String) : param.type.data_type === 'boolean' ? ['true', 'false'] : null;
  if (choices) {
    return (
      <Dropdown
        ariaLabel={param.name}
        value={value}
        onChange={onChange}
        placeholder={empty}
        options={[...(param.required ? [] : [{ value: '', label: empty }]), ...choices.map((c) => ({ value: c, label: c }))]}
      />
    );
  }
  return (
    <ScalarInput
      dataType={param.type.data_type}
      value={value}
      onChange={onChange}
      placeholder={param.required ? param.name : empty}
      label={param.name}
    />
  );
}

function StaticAttributeSelect({ slot, value, onChange }: { slot: TypeRef; value: string; onChange: (ref: string) => void }) {
  const options = (useSlotAttributes(slot) ?? []).filter((a) => !a.dynamic);
  return (
    <Dropdown
      ariaLabel="Attribute"
      value={value}
      onChange={onChange}
      placeholder={options.length ? 'Select attribute…' : 'No input attribute fits'}
      options={options.map((a) => attributeOption(a, a.path!))}
    />
  );
}

// ---------- constant ----------

export function ConstantEditor({
  value,
  onChange,
  slot,
  choices: given,
}: {
  value: ConstantOperand;
  onChange: (op: Operand) => void;
  slot?: TypeRef;
  choices?: string[];
}) {
  const { dataTypes } = useEditor();
  const set = (patch: Partial<ConstantOperand>) => onChange({ ...value, ...patch });
  const choices = given ?? slot?.enum_values ?? undefined;
  return (
    <div className="constant">
      {slot ? (
        <div className="hint">
          Must be <span className="type-chip">{typeLabel(slot)}</span>
        </div>
      ) : (
        <div className="row gap-sm">
          <Dropdown
            ariaLabel="Container type"
            value={value.container}
            onChange={(v) => {
              const container = v as ConstantOperand['container'];
              set(container === 'list' ? { container, items: [value.value] } : { container, value: value.items[0] ?? '' });
            }}
            options={[
              { value: 'primitive', label: 'single value' },
              { value: 'list', label: 'list' },
            ]}
          />
          <Dropdown
            ariaLabel="Data type"
            value={value.dataType}
            onChange={(t) => set({ dataType: t, value: t === 'boolean' ? 'true' : '', items: value.container === 'list' ? [''] : [] })}
            options={dataTypes.filter((t) => t.name !== 'object' && t.name !== 'enum').map((t) => ({ value: t.name, label: t.name }))} // a free constant is never an enum
          />
        </div>
      )}
      {value.container === 'list' ? (
        <ListInput dataType={value.dataType} items={value.items} choices={choices} onChange={(items) => set({ items })} />
      ) : choices ? (
        <EnumSelect choices={choices} value={value.value} onChange={(v) => set({ value: v })} label="Value" />
      ) : (
        <ScalarInput dataType={value.dataType} value={value.value} onChange={(v) => set({ value: v })} label="Value" />
      )}
    </div>
  );
}

const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

export function ScalarInput({
  dataType,
  value,
  onChange,
  placeholder,
  label,
}: {
  dataType: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label: string;
}) {
  const { dataTypes } = useEditor();
  if (dataType === 'boolean') {
    return (
      <Dropdown
        ariaLabel={label}
        value={value}
        onChange={onChange}
        options={[
          { value: 'true', label: 'true' },
          { value: 'false', label: 'false' },
        ]}
      />
    );
  }
  const numeric = dataTypes.find((t) => t.name === dataType)?.numeric ?? false;
  const whole = dataType === 'integer' || dataType === 'long';
  const bad = numeric && value !== '' && !(whole ? INTEGER : DECIMAL).test(value.trim());
  return (
    <input
      aria-label={label}
      className={bad ? 'invalid' : ''}
      value={value}
      inputMode={numeric ? 'decimal' : undefined}
      placeholder={placeholder ?? (numeric ? (whole ? 'e.g. 42' : 'e.g. 0.05') : 'text')}
      title={bad ? `Not a valid ${dataType}` : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function EnumSelect({ choices, value, onChange, label }: { choices: string[]; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <Dropdown
      ariaLabel={label}
      value={value}
      onChange={onChange}
      placeholder="Select a value…"
      invalid={!!value && !choices.includes(value)}
      options={[...(value && !choices.includes(value) ? [{ value, label: `${value} (not allowed)`, disabled: true }] : []), ...choices.map((c) => ({ value: c, label: c }))]}
    />
  );
}

/** Pick several of the allowed values: toggle chips, in the order they are allowed. */
function ChoiceChips({ choices, items, onChange }: { choices: string[]; items: string[]; onChange: (items: string[]) => void }) {
  const picked = new Set(items.filter((v) => v !== ''));
  const toggle = (c: string) => onChange(choices.filter((x) => (x === c ? !picked.has(c) : picked.has(x))));
  return (
    <div className="chips" role="group" aria-label="Allowed values">
      {choices.map((c) => (
        <button key={c} type="button" className={`chip ${picked.has(c) ? 'on' : ''}`} aria-pressed={picked.has(c)} onClick={() => toggle(c)}>
          {picked.has(c) && <Icon name="check" size={13} />}
          {c}
        </button>
      ))}
      {picked.size === 0 && <span className="hint">Pick one or more</span>}
    </div>
  );
}

export function ListInput({
  dataType,
  items,
  onChange,
  choices,
}: {
  dataType: string;
  items: string[];
  onChange: (items: string[]) => void;
  choices?: string[];
}) {
  const { readOnly } = useEditor();
  if (choices) return <ChoiceChips choices={choices} items={items} onChange={onChange} />;
  return (
    <div className="list-input">
      {items.map((v, i) => (
        <div className="row gap-sm" key={i}>
          <ScalarInput dataType={dataType} value={v} label={`Item ${i + 1}`} onChange={(nv) => onChange(items.map((x, j) => (j === i ? nv : x)))} />
          {!readOnly && items.length > 1 && (
            <button type="button" className="icon-btn" aria-label="Remove item" onClick={() => onChange(items.filter((_, j) => j !== i))}>
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button type="button" className="link" onClick={() => onChange([...items, dataType === 'boolean' ? 'true' : ''])}>
          <Icon name="plus" size={13} /> Add value
        </button>
      )}
    </div>
  );
}

/** One-line description of an expression operand (read-only for now). */
export function exprSummary(json: any): string {
  if (!json) return '∅';
  switch (json.type) {
    case 'EXPRESSION_REFERENCE':
      return `${String(json.value).split(':').pop()} @v${json.version}`;
    case 'EXPRESSION':
      return json.rhs ? `${json.operation}(${exprSummary(json.lhs)}, ${exprSummary(json.rhs)})` : `${json.operation}(${exprSummary(json.lhs)})`;
    case 'ATTRIBUTE':
      return String(json.value);
    case 'CONSTANT':
      return JSON.stringify(json.value);
    default:
      return json.type ?? '?';
  }
}

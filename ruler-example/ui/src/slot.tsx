// One side of an equation (LHS or RHS): a single dropdown that picks both what kind of value it is and which one.
//   Attributes …        → the attribute (dynamic ones show their params below)
//   Saved expressions … → a stored expression, pinned to its version
//   Type a value        → turns into an input (or a dropdown / chips for enums)
//   ƒ Calculate ↓       → the next ladder step opens below
import { api, typeLabel, type TypeRef, type ValidationError } from './api';
import { cached, useAsync } from './hooks';
import { useContext } from 'react';
import { TreeContext } from './context';
import { attributeValue, emptyConstant, showValue, stepOf, findAttribute, ownErrors, type ConstantOperand, type Operand } from './model';
import { Dropdown } from './dropdown';
import { EnumSelect, ExpressionLink, FieldErrors, ListInput, ParamsEditor, ScalarInput, attributeOption, useEditor, useSlotAttributes } from './operand';
import { Icon } from './ui';

export type SlotKind = 'ATTRIBUTE' | 'CONSTANT' | 'REF' | 'EXPR';

/** ACTIVE saved expressions; a slot keeps those whose result fits it; `null` = don't load. */
export function useSavedExpressions(slot: TypeRef | undefined | null) {
  const { caseName } = useEditor();
  const key = slot === null ? null : `exprs|${caseName}|${slot ? typeLabel(slot) : '*'}`;
  return useAsync(key, () => cached(key!, () => api.expressions(caseName, slot ?? undefined)));
}

export function SlotPicker({
  value,
  onChange,
  slot,
  allow,
  choices,
  path,
  errors,
  placeholder = 'Choose…',
  constantType,
}: {
  value: Operand | null;
  onChange: (op: Operand | null) => void;
  /** Type this side must fit; omitted on a left side, which sets the type. */
  slot?: TypeRef;
  allow: SlotKind[];
  /** Enum values a constant must be one of (from the other side). */
  choices?: string[];
  path: string;
  errors: ValidationError[];
  placeholder?: string;
  /** Starting type of a typed-in value when the side has no slot (defaults to string). */
  constantType?: TypeRef;
}) {
  const { attrs, readOnly } = useEditor();
  const attrOptions = useSlotAttributes(slot) ?? [];
  const saved = useSavedExpressions(allow.includes('REF') ? slot : null);
  const mine = ownErrors(errors, path);

  if (value?.kind === 'CONSTANT') {
    return (
      <div className={`side ${mine.length ? 'has-error' : ''}`}>
        <div className="side-row">
          <ConstantInput value={value} onChange={onChange} slot={slot} choices={choices} />
          {!readOnly && (
            <button type="button" className="icon-btn" title="Pick something else" aria-label="Pick something else" onClick={() => onChange(null)}>
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
        <FieldErrors errors={mine} />
      </div>
    );
  }

  const meta = value?.kind === 'ATTRIBUTE' ? findAttribute(attrs, value.ref) : undefined;
  const current =
    value?.kind === 'ATTRIBUTE' ? `attr:${meta ? (meta.dynamic ? meta.code : meta.path) : value.ref}` : value?.kind === 'REF' ? `ref:${value.key}` : value?.kind === 'EXPR' ? 'expr' : '';
  const refMeta = value?.kind === 'REF' ? (saved.data ?? []).find((e) => e.key === value.key) : undefined;
  const refOf = (a: (typeof attrs)[number]) => (a.dynamic ? a.code : a.path!);
  // the last run: what this attribute resolved to, or what this saved expression returned
  const { trace } = useContext(TreeContext);
  const used = value?.kind === 'ATTRIBUTE' ? attributeValue(trace, value.ref) : undefined;
  const refStep = value?.kind === 'REF' ? stepOf(trace, path, 'REFERENCE') : undefined;
  const ranText = used?.found ? showValue(used.value) : refStep ? showValue(refStep.result) : null;

  const pick = (v: string) => {
    if (v === 'const') onChange(emptyConstant(slot ?? constantType ?? { container_type: 'primitive', data_type: 'string' }));
    else if (v === 'expr') onChange({ kind: 'EXPR', op: '', unary: false, lhs: null, rhs: null });
    else if (v.startsWith('attr:')) onChange({ kind: 'ATTRIBUTE', ref: v.slice(5), params: {} });
    else if (v.startsWith('ref:')) {
      const e = (saved.data ?? []).find((x) => x.key === v.slice(4))!;
      onChange({ kind: 'REF', key: e.key, version: e.version });
    }
  };

  return (
    <div className={`side ${mine.length ? 'has-error' : ''}`}>
      <Dropdown
        ariaLabel="Value"
        value={current}
        onChange={pick}
        placeholder={placeholder}
        className={`side-select ${current === 'expr' ? 'is-calc' : ''}`}
        minMenuWidth={380}
        options={[
          ...(value?.kind === 'ATTRIBUTE' && !attrOptions.some((a) => `attr:${refOf(a)}` === current)
            ? [{ value: current, label: `${meta?.name ?? value.ref} (does not fit)`, group: 'Attributes', disabled: true }]
            : []),
          ...(allow.includes('ATTRIBUTE') ? attrOptions.map((a) => attributeOption(a, `attr:${refOf(a)}`, 'Attributes')) : []),
          ...(value?.kind === 'REF' && !refMeta ? [{ value: current, label: `${value.key.split(':').pop()} (does not fit)`, group: 'Saved expressions', disabled: true }] : []),
          ...(allow.includes('REF')
            ? (saved.data ?? []).map((e) => ({
                value: `ref:${e.key}`,
                label: e.name,
                group: 'Saved expressions',
                meta: typeLabel(e.result_type),
                hint: e.description ?? undefined,
                icon: <Icon name="code" size={13} />,
              }))
            : []),
          ...(allow.includes('CONSTANT') ? [{ value: 'const', label: 'Type a value', group: 'Other', icon: <Icon name="edit" size={13} />, hint: slot ? `a ${typeLabel(slot)}` : undefined }] : []),
          ...(allow.includes('EXPR')
            ? [{ value: 'expr', label: 'Calculate it in a step below', short: 'ƒ Calculated below ↓', group: 'Other', icon: 'ƒ', hint: 'opens a new step below, to the right' }]
            : []),
        ]}
      />
      {ranText && <div className="ran-side" title="What the last Calculate used">= {ranText}</div>}
      {meta && (meta.description || meta.type.enum_values?.length) && (
        <div className="side-note">{meta.type.enum_values?.length ? `One of ${meta.type.enum_values.join(', ')}` : meta.description}</div>
      )}
      {meta?.dynamic && meta.params.length > 0 && value?.kind === 'ATTRIBUTE' && (
        <ParamsEditor params={meta.params} value={value.params} onChange={(params) => onChange({ ...value, params })} />
      )}
      {value?.kind === 'REF' && value.key && <ExpressionLink refKey={value.key} version={value.version} />}
      {value?.kind === 'REF' && refMeta && refMeta.version !== value.version && !readOnly && (
        <button type="button" className="link" onClick={() => onChange({ ...value, version: refMeta.version })}>
          Pinned to v{value.version} · use active v{refMeta.version}
        </button>
      )}
      {value?.kind !== 'EXPR' && <FieldErrors errors={mine} />}
    </div>
  );
}

/** A constant on one side: typed by the slot when there is one, otherwise the author picks the type. */
function ConstantInput({
  value,
  onChange,
  slot,
  choices,
}: {
  value: ConstantOperand;
  onChange: (op: Operand) => void;
  slot?: TypeRef;
  choices?: string[];
}) {
  const { dataTypes } = useEditor();
  const set = (patch: Partial<ConstantOperand>) => onChange({ ...value, ...patch });
  const enumChoices = choices ?? slot?.enum_values ?? undefined;
  return (
    <div className="const-input">
      {!slot && (
        <Dropdown
          variant="chip"
          ariaLabel="Type"
          value={value.dataType}
          onChange={(t) => onChange({ ...emptyConstant({ container_type: 'primitive', data_type: t }), value: value.value })}
          options={dataTypes.filter((t) => t.name !== 'object' && t.name !== 'enum').map((t) => ({ value: t.name, label: t.name }))}
          minMenuWidth={160}
        />
      )}
      {value.container === 'list' ? (
        <ListInput dataType={value.dataType} items={value.items} choices={enumChoices} onChange={(items) => set({ items })} />
      ) : enumChoices ? (
        <EnumSelect choices={enumChoices} value={value.value} onChange={(v) => set({ value: v })} label="Value" />
      ) : (
        <ScalarInput dataType={value.dataType} value={value.value} onChange={(v) => set({ value: v })} label="Value" />
      )}
    </div>
  );
}


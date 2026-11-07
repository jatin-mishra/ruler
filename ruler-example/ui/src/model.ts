// The editor's tree model and its mapping to the decision-tree definition JSON (docs/lld.md §3).
// State is immutable: every edit builds new objects, so React re-renders and unchanged parts keep their identity.

import type { AttributeView, Container, ExplainStep, Explanation, ReturnSpec, TypeRef, ValidationError } from './api';

export interface ConstantOperand {
  kind: 'CONSTANT';
  container: Exclude<Container, 'map'>;
  dataType: string;
  value: string; // primitive; booleans as 'true' / 'false'
  items: string[]; // list
}

/** A dynamic-attribute param value, bound to a constant (list-typed params use `items`) or a static attribute path. */
export type ParamBind = { source: 'CONSTANT'; value: string; items?: string[] } | { source: 'ATTRIBUTE'; ref: string };

export interface AttributeOperand {
  kind: 'ATTRIBUTE';
  ref: string; // static → path, dynamic → code (lld Q5)
  params: Record<string, ParamBind>;
}

/** A stored expression, pinned to one version (lld Q3/Q5d). */
export interface RefOperand {
  kind: 'REF';
  key: string; // <case>:<name>
  version: number;
}

/** An inline calculation: `op(lhs, rhs)`; unary operators (e.g. sum, lower_case) have no rhs. */
export interface ExprOperand {
  kind: 'EXPR';
  op: string;
  unary: boolean;
  lhs: Operand | null;
  rhs: Operand | null;
}

/** Anything else the UI does not edit; kept exactly as authored. */
export interface RawOperand {
  kind: 'RAW';
  json: any;
}

export type Operand = ConstantOperand | AttributeOperand | RefOperand | ExprOperand | RawOperand;

export interface ConditionNode {
  id: string;
  type: 'condition';
  description: string;
  lhs: Operand | null;
  operator: string;
  rhs: Operand | null;
  failure: TreeNode | null; // FALSE, drawn on the left
  success: TreeNode | null; // TRUE, drawn on the right
}

export interface ValueRow {
  id: string;
  key: string; // map entries only; keys are always strings
  value: Operand | null;
}

export interface ValueNode {
  id: string;
  type: 'value';
  /** primitive = one expression for the whole result; list / map = built item by item / key by key. */
  shape: Container;
  single: Operand | null;
  rows: ValueRow[]; // list items or map entries
}

export type TreeNode = ConditionNode | ValueNode;
export type Branch = 'success' | 'failure';

export interface TreeDraft {
  caseName: string;
  name: string;
  description: string;
  returns: ReturnSpec;
  root: TreeNode | null;
  /** Sample input as JSON text; stored with every version as `sample_data` (lld §17). */
  sample: string;
}

let seq = 0;
export const newId = () => `n${++seq}`;

export const emptyCondition = (): ConditionNode => ({
  id: newId(),
  type: 'condition',
  description: '',
  lhs: null,
  operator: '',
  rhs: null,
  failure: null,
  success: null,
});

export const newRow = (): ValueRow => ({ id: newId(), key: '', value: null });

export const emptyValue = (shape: Container): ValueNode => ({
  id: newId(),
  type: 'value',
  shape,
  single: null,
  rows: shape === 'primitive' ? [] : [newRow()],
});

// Enum constants are plain strings; the server checks they are members (lld §18).
export const emptyConstant = (t: TypeRef): ConstantOperand => ({
  kind: 'CONSTANT',
  container: t.container_type === 'list' ? 'list' : 'primitive',
  dataType: t.data_type === 'enum' ? 'string' : t.data_type,
  value: t.data_type === 'boolean' ? 'true' : '',
  items: t.container_type === 'list' ? [''] : [],
});

export const constantType = (c: ConstantOperand): TypeRef => ({ container_type: c.container, data_type: c.dataType });

// ---------- paths (match the server's validation paths) ----------

export const ROOT_PATH = '$.root';
export const childPath = (path: string, branch: Branch) =>
  `${path}.${branch === 'success' ? 'success_condition' : 'failure_condition'}`;

/** Every node path in the tree, root first. */
export function nodePaths(root: TreeNode | null, path = ROOT_PATH, out: string[] = []): string[] {
  if (!root) return out;
  out.push(path);
  if (root.type === 'condition') {
    nodePaths(root.failure, childPath(path, 'failure'), out);
    nodePaths(root.success, childPath(path, 'success'), out);
  }
  return out;
}

const within = (errorPath: string, prefix: string) =>
  errorPath === prefix || errorPath.startsWith(prefix + '.') || errorPath.startsWith(prefix + '[');

/**
 * Assigns each error to the deepest node whose path prefixes it (a missing branch lands on its parent);
 * errors that fit no node (e.g. $.name, $.returns) go to `tree`.
 */
export function assignErrors(errors: ValidationError[], paths: string[]) {
  const byNode = new Map<string, ValidationError[]>();
  const tree: ValidationError[] = [];
  for (const e of errors) {
    const owner = paths.filter((p) => within(e.path, p)).sort((a, b) => b.length - a.length)[0];
    if (owner) byNode.set(owner, [...(byNode.get(owner) ?? []), e]);
    else tree.push(e);
  }
  return { byNode, tree };
}

/** Errors under one field of a card, e.g. `$.root.lhs`. */
export const fieldErrors = (errors: ValidationError[], fieldPath: string) => errors.filter((e) => within(e.path, fieldPath));

/** Errors of one expression node itself, not of its operands (those show on the operand). */
export const ownErrors = (errors: ValidationError[], path: string) =>
  fieldErrors(errors, path).filter((e) => !within(e.path, path + '.lhs') && !within(e.path, path + '.rhs'));

// ---------- completeness: only complete cards are sent for validation ----------

export function operandComplete(op: Operand | null): boolean {
  if (!op) return false;
  if (op.kind === 'RAW') return true;
  if (op.kind === 'REF') return op.key !== '';
  if (op.kind === 'EXPR') return op.op !== '' && operandComplete(op.lhs) && (op.unary || operandComplete(op.rhs));
  if (op.kind === 'ATTRIBUTE') return op.ref !== '';
  return op.container === 'list' ? op.items.length > 0 && op.items.every((v) => v.trim() !== '') : op.value.trim() !== '';
}

export function nodeComplete(node: TreeNode): boolean {
  if (node.type === 'condition') return operandComplete(node.lhs) && node.operator !== '' && operandComplete(node.rhs);
  if (node.shape === 'primitive') return operandComplete(node.single);
  return (
    node.rows.length > 0 &&
    node.rows.every((r) => operandComplete(r.value) && (node.shape !== 'map' || r.key.trim() !== '')) &&
    (node.shape !== 'map' || duplicateKeys(node).length === 0)
  );
}

/** Map keys used more than once (the server rejects them; lld §19). */
export const duplicateKeys = (node: ValueNode) => {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const r of node.rows) {
    const k = r.key.trim();
    if (k && seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return [...dup];
};

/** Path of one value row, as the server reports it: items[i] for lists, entries.<key> for maps. */
export const rowPath = (path: string, node: ValueNode, i: number) =>
  node.shape === 'map' ? `${path}.entries.${node.rows[i].key.trim()}` : `${path}.items[${i}]`;

/**
 * A ladder: LHS is a constant or attribute, RHS is a plain value or the next step (lld §5, UI rule).
 * Anything else (an expression on the left) is shown read-only and can be rebuilt.
 */
export function isLadder(op: Operand | null): boolean {
  if (!op || op.kind !== 'EXPR') return true;
  if (op.lhs && op.lhs.kind !== 'CONSTANT' && op.lhs.kind !== 'ATTRIBUTE') return false;
  return op.unary || isLadder(op.rhs);
}

/** What still blocks saving, as human-readable reasons (empty = ready). */
export function treeProblems(root: TreeNode | null, path = ROOT_PATH): string[] {
  if (!root) return ['The tree is empty'];
  const own = nodeComplete(root) ? [] : [`${describePath(path)} is not filled in`];
  if (root.type === 'value') {
    const dup = root.shape === 'map' ? duplicateKeys(root) : [];
    return dup.length ? [...own, `${describePath(path)} uses key "${dup[0]}" twice`] : own;
  }
  const missing = (['failure', 'success'] as Branch[])
    .filter((b) => !root[b])
    .map((b) => `${describePath(path)} has no ${b === 'success' ? 'TRUE' : 'FALSE'} branch`);
  return [
    ...own,
    ...missing,
    ...(root.failure ? treeProblems(root.failure, childPath(path, 'failure')) : []),
    ...(root.success ? treeProblems(root.success, childPath(path, 'success')) : []),
  ];
}

/** `$.root.success_condition.failure_condition` → "Root › TRUE › FALSE". */
export const describePath = (path: string) =>
  ['Root', ...path.replace(ROOT_PATH, '').split('.').filter(Boolean).map((s) => (s === 'success_condition' ? 'TRUE' : 'FALSE'))].join(' › ');

// ---------- tree edits ----------

/** Replaces the node at `path` (null removes it with its subtree). */
export function replaceAt(root: TreeNode | null, path: string, next: TreeNode | null): TreeNode | null {
  if (path === ROOT_PATH) return next;
  if (!root || root.type !== 'condition') return root;
  for (const branch of ['failure', 'success'] as Branch[]) {
    const p = childPath(ROOT_PATH, branch);
    if (path === p || path.startsWith(p + '.')) {
      const rest = ROOT_PATH + path.slice(p.length);
      return { ...root, [branch]: replaceAt(root[branch], rest, next) };
    }
  }
  return root;
}

/** Return container changed (new trees only): every value node takes the new, empty shape. */
export function reshapeValues(root: TreeNode | null, shape: Container): TreeNode | null {
  if (!root) return null;
  if (root.type === 'value') return root.shape === shape ? root : { ...emptyValue(shape), id: root.id };
  return { ...root, failure: reshapeValues(root.failure, shape), success: reshapeValues(root.success, shape) };
}

// ---------- JSON mapping ----------

// Operands loaded from JSON remember their source; an unedited operand is written back byte-for-byte.
// Edits create new objects (not in the map), which are then serialised from the model.
const authored = new WeakMap<object, any>();

const isNumericText = (v: unknown) => typeof v === 'number';

export function operandFromJson(json: any): Operand | null {
  if (!json) return null;
  let op: Operand;
  if (json.type === 'CONSTANT') {
    const list = Array.isArray(json.value);
    const sample = list ? json.value[0] : json.value;
    const inferred = typeof sample === 'boolean' ? 'boolean' : isNumericText(sample) ? (Number.isInteger(sample) ? 'integer' : 'double') : 'string';
    op = {
      kind: 'CONSTANT',
      container: list ? 'list' : 'primitive',
      dataType: json.data_type ?? inferred,
      value: list ? '' : String(json.value ?? ''),
      items: list ? json.value.map((v: unknown) => String(v)) : [],
    };
  } else if (json.type === 'ATTRIBUTE') {
    const params: Record<string, ParamBind> = {};
    for (const p of json.params ?? []) {
      params[p.name] =
        p.type === 'ATTRIBUTE'
          ? { source: 'ATTRIBUTE', ref: p.value }
          : Array.isArray(p.value)
            ? { source: 'CONSTANT', value: '', items: p.value.map((v: unknown) => String(v)) }
            : { source: 'CONSTANT', value: String(p.value ?? '') };
    }
    op = { kind: 'ATTRIBUTE', ref: json.value, params };
  } else if (json.type === 'EXPRESSION_REFERENCE') {
    op = { kind: 'REF', key: json.value, version: json.version };
  } else if (json.type === 'EXPRESSION') {
    op = { kind: 'EXPR', op: json.operation ?? '', unary: json.rhs == null, lhs: operandFromJson(json.lhs), rhs: operandFromJson(json.rhs) };
  } else {
    op = { kind: 'RAW', json };
  }
  authored.set(op, json);
  return op;
}

/** Text → JSON value. Numbers stay strings so decimals are exact (the server parses authored constants leniently). */
const scalar = (text: string, dataType: string) => (dataType === 'boolean' ? text === 'true' : text);

export function operandToJson(op: Operand | null, attrs: AttributeView[] = []): any {
  if (!op) return null;
  if (authored.has(op)) return authored.get(op);
  if (op.kind === 'RAW') return op.json;
  if (op.kind === 'REF') return { type: 'EXPRESSION_REFERENCE', value: op.key, version: op.version };
  if (op.kind === 'EXPR') {
    const json: any = { type: 'EXPRESSION', operation: op.op, lhs: operandToJson(op.lhs, attrs) };
    if (!op.unary) json.rhs = operandToJson(op.rhs, attrs);
    return json;
  }
  if (op.kind === 'CONSTANT') {
    return {
      type: 'CONSTANT',
      container_type: op.container,
      data_type: op.dataType,
      value: op.container === 'list' ? op.items.map((v) => scalar(v, op.dataType)) : scalar(op.value, op.dataType),
    };
  }
  const meta = findAttribute(attrs, op.ref);
  const params = Object.entries(op.params)
    .filter(([, b]) => paramFilled(b)) // empty optional → server default
    .map(([name, b]) => {
      if (b.source === 'ATTRIBUTE') return { name, type: 'ATTRIBUTE', value: b.ref };
      const t = meta?.params.find((p) => p.name === name)?.type;
      const dataType = t?.data_type ?? 'string';
      const value = b.items ? b.items.filter((v) => v !== '').map((v) => scalar(v, dataType)) : scalar(b.value, dataType);
      // enum params take plain strings; the server checks membership (lld §18)
      return t
        ? { name, type: 'CONSTANT', container_type: t.container_type, data_type: t.data_type === 'enum' ? 'string' : t.data_type, value }
        : { name, type: 'CONSTANT', value };
    });
  return params.length ? { type: 'ATTRIBUTE', value: op.ref, params } : { type: 'ATTRIBUTE', value: op.ref };
}

export function nodeFromJson(json: any, shape: Container): TreeNode | null {
  if (!json) return null;
  if (json.type === 'condition') {
    return {
      id: newId(),
      type: 'condition',
      description: json.description ?? '',
      lhs: operandFromJson(json.lhs),
      operator: json.operator ?? '',
      rhs: operandFromJson(json.rhs),
      failure: nodeFromJson(json.failure_condition, shape),
      success: nodeFromJson(json.success_condition, shape),
    };
  }
  const rows: ValueRow[] = json.items
    ? json.items.map((it: any) => ({ id: newId(), key: '', value: operandFromJson(it) }))
    : Object.entries(json.entries ?? {}).map(([key, value]) => ({ id: newId(), key, value: operandFromJson(value) })); // map[string, expression] (lld §19)
  // The node's own JSON decides its layout, not the tree's return type: `value` is ONE expression for the whole
  // result (it may itself return a list or map, e.g. a saved expression returning list<string>); `items` / `entries`
  // build a list / map element by element.
  const own: Container = json.value !== undefined ? 'primitive' : json.items ? 'list' : json.entries ? 'map' : shape;
  return { id: newId(), type: 'value', shape: own, single: operandFromJson(json.value), rows };
}

/** One node without its children: the body of validate-node. */
export function nodeToJson(node: TreeNode, attrs: AttributeView[], withChildren = true): any {
  if (node.type === 'condition') {
    const json: any = { type: 'condition' };
    if (node.description) json.description = node.description;
    json.lhs = operandToJson(node.lhs, attrs);
    json.operator = node.operator;
    json.rhs = operandToJson(node.rhs, attrs);
    if (withChildren) {
      if (node.success) json.success_condition = nodeToJson(node.success, attrs);
      if (node.failure) json.failure_condition = nodeToJson(node.failure, attrs);
    }
    return json;
  }
  if (node.shape === 'primitive') return { type: 'value', value: operandToJson(node.single, attrs) };
  if (node.shape === 'list') return { type: 'value', items: node.rows.map((r) => operandToJson(r.value, attrs)) };
  return { type: 'value', entries: Object.fromEntries(node.rows.map((r) => [r.key.trim(), operandToJson(r.value, attrs)])) };
}

export const paramFilled = (b: ParamBind) =>
  b.source === 'ATTRIBUTE' ? b.ref !== '' : b.items ? b.items.some((v) => v !== '') : b.value !== '';

export function draftFromJson(data: any, sampleData?: unknown): TreeDraft {
  return {
    caseName: data.case,
    name: data.name,
    description: data.description ?? '',
    returns: data.returns,
    root: nodeFromJson(data.root, data.returns.container_type),
    sample: sampleData == null ? '' : JSON.stringify(sampleData, null, 2),
  };
}

/** A starting sample input built from the case's static attribute paths (a.b, list.0.c, list.*.c), or enum values. */
export function sampleSkeleton(attrs: AttributeView[]): unknown {
  const root: any = {};
  const isIndex = (s: string) => s === '*' || /^\d+$/.test(s);
  for (const a of attrs) {
    if (a.dynamic || !a.path) continue;
    const segs = a.path.split('.');
    let cur = root;
    segs.forEach((s, i) => {
      const key = isIndex(s) ? 0 : s;
      if (i < segs.length - 1) {
        cur[key] = cur[key] ?? (isIndex(segs[i + 1]) ? [] : {});
        cur = cur[key];
        return;
      }
      const t = a.type;
      const v = t.enum_values?.length ? t.enum_values[0] : t.data_type === 'boolean' ? false : t.data_type === 'string' ? '' : 0;
      cur[key] = cur[key] ?? (t.container_type === 'list' ? [v] : t.container_type === 'map' ? {} : v);
    });
  }
  return root;
}

/** The parsed sample, or the JSON error to show. */
export function parseSample(text: string): { value?: unknown; error?: string } {
  if (!text.trim()) return { error: 'A sample input is required' };
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? { value } : { error: 'The sample input must be a JSON object' };
  } catch (e) {
    return { error: 'Not valid JSON: ' + (e as Error).message };
  }
}

export function draftToJson(d: TreeDraft, attrs: AttributeView[]): any {
  const json: any = { case: d.caseName, name: d.name };
  if (d.description) json.description = d.description;
  json.returns = cleanReturns(d.returns);
  json.root = d.root ? nodeToJson(d.root, attrs) : null;
  return json;
}

/** Drops empty optional fields; a map's key type is always string. */
export function cleanReturns(r: ReturnSpec): ReturnSpec {
  const out: ReturnSpec = { container_type: r.container_type, data_type: r.data_type };
  if (r.container_type === 'map') out.key_type = 'string';
  if (r.scale !== undefined && r.scale !== null && !Number.isNaN(r.scale)) out.scale = r.scale;
  if (r.rounding) out.rounding = r.rounding;
  if (r.data_type === 'enum') out.allowed_values = r.allowed_values ?? [];
  return out;
}

export const findAttribute = (attrs: AttributeView[], ref: string) =>
  attrs.find((a) => (a.dynamic ? a.code === ref : samePath(a.path, ref))) ?? attrs.find((a) => a.code === ref);

/** Paths may be written with or without a leading "$." (lld §21): `$.parties.*.id` and `parties.*.id` are the same. */
export const samePath = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.replace(/^\$\./, '') === b.replace(/^\$\./, '');

/** The whole return type as a slot (an expression's body must fit it). */
export const returnSlot = (r: ReturnSpec): TypeRef => ({
  container_type: r.container_type,
  data_type: r.data_type,
  key_type: r.container_type === 'map' ? 'string' : null,
  enum_values: r.allowed_values ?? null,
});

// ---------- run results (lld §22): which nodes ran, with what values ----------

/** Steps by path; steps inside a saved expression (path has "(case:name@v)") are left out: they belong to that expression. */
export interface Trace {
  steps: Map<string, ExplainStep[]>;
  /** The value each value node returned, by node path. */
  values: Map<string, unknown>;
  /** What each attribute resolved to: static by path, dynamic by code (first resolution; params shown in the panel). */
  attributes: Map<string, unknown>;
}

export function buildTrace(steps: ExplainStep[], attributes: Explanation['attributes'] = []): Trace {
  const byPath = new Map<string, ExplainStep[]>();
  const values = new Map<string, unknown>();
  for (const s of steps) {
    if (s.path.includes('(')) continue;
    byPath.set(s.path, [...(byPath.get(s.path) ?? []), s]);
    if (s.kind === 'VALUE') values.set(s.path, s.result);
  }
  const attrs = new Map<string, unknown>();
  for (const a of attributes) attrs.set(a.path ? a.path.replace(/^\$\./, '') : a.code, a.value);
  return { steps: byPath, values, attributes: attrs };
}

/** The value an attribute operand had in the last run (paths may be written with or without "$."). */
export const attributeValue = (trace: Trace | null | undefined, ref: string): { found: boolean; value?: unknown } => {
  const key = ref.replace(/^\$\./, '');
  return trace?.attributes.has(key) ? { found: true, value: trace.attributes.get(key) } : { found: false };
};

export const stepOf = (trace: Trace | null | undefined, path: string, kind: ExplainStep['kind']) =>
  trace?.steps.get(path)?.find((s) => s.kind === kind);

/** Did evaluation pass through this node (a condition it checked, or the value node it returned)? */
export const visited = (trace: Trace | null | undefined, path: string) =>
  !!(stepOf(trace, path, 'CONDITION') || stepOf(trace, path, 'VALUE'));

/** The value one row of a value node produced: the whole value, a list item, or a map entry. */
export function rowValue(trace: Trace | null | undefined, path: string, node: ValueNode, i: number | null): { found: boolean; value?: unknown } {
  if (!trace || !trace.values.has(path)) return { found: false };
  const v: any = trace.values.get(path);
  if (i === null) return { found: true, value: v };
  if (node.shape === 'list') return Array.isArray(v) && i < v.length ? { found: true, value: v[i] } : { found: false };
  const key = node.rows[i]?.key.trim();
  return v && typeof v === 'object' && key in v ? { found: true, value: v[key] } : { found: false };
}

/** A result for people: numbers grouped, strings quoted, the rest as JSON. */
export function showValue(v: unknown): string {
  if (typeof v === 'number') return new Intl.NumberFormat(undefined, { maximumFractionDigits: 10 }).format(v);
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'boolean' || v === null || v === undefined) return String(v);
  return JSON.stringify(v);
}

// ---------- expressions (lld §20): {case, name, description, returns, expression} ----------

export interface ExprDraft {
  caseName: string;
  name: string;
  description: string;
  returns: ReturnSpec;
  body: Operand | null;
  sample: string;
}

export const exprDraftFromJson = (data: any, sampleData?: unknown): ExprDraft => ({
  caseName: data.case,
  name: data.name,
  description: data.description ?? '',
  returns: data.returns,
  body: operandFromJson(data.expression),
  sample: sampleData == null ? '' : JSON.stringify(sampleData, null, 2),
});

export function exprDraftToJson(d: ExprDraft, attrs: AttributeView[]): any {
  const json: any = { case: d.caseName, name: d.name.trim() };
  if (d.description) json.description = d.description;
  json.returns = cleanReturns(d.returns);
  json.expression = operandToJson(d.body, attrs);
  return json;
}

/** Slot type a value row must fit: the element type of the tree's return type. */
export const valueSlot = (r: ReturnSpec): TypeRef => ({ container_type: 'primitive', data_type: r.data_type, enum_values: r.allowed_values ?? null });

/** Human labels for operators; unknown ones show their name. */
const OPERATOR_LABELS: Record<string, string> = {
  equals: 'equals',
  not_equals: 'does not equal',
  equals_ignore_case: 'equals (ignore case)',
  prefix_match: 'starts with',
  suffix_match: 'ends with',
  contains: 'contains',
  contains_any: 'contains any of',
  contains_all: 'contains all of',
  contains_key: 'has key',
  contains_value: 'has value',
  in: 'is one of',
  GT: 'greater than  >',
  LT: 'less than  <',
  GTE: 'at least  ≥',
  LTE: 'at most  ≤',
};
export const operatorLabel = (name: string) => OPERATOR_LABELS[name] ?? name.replace(/_/g, ' ');

/** Calculation operators: how they read with the left and right sides. */
const ARITHMETIC_LABELS: Record<string, string> = {
  add: 'left + right',
  subtract: 'left − right',
  multiply: 'left × right',
  divide: 'left ÷ right',
  min: 'smaller of the two',
  max: 'larger of the two',
  sum: 'sum of all items',
  append_prefix: 'right + left',
  append_suffix: 'left + right',
  remove_prefix_length: 'drop first <right> chars',
  remove_suffix_length: 'drop last <right> chars',
  lower_case: 'to lower case',
  upper_case: 'to upper case',
  union: 'all items of both',
  intersection: 'items in both',
  remove_all_if_exists: 'left without right items',
  add_all: 'left plus all right items',
};
export const arithmeticLabel = (name: string) => (ARITHMETIC_LABELS[name] ? `${name.replace(/_/g, ' ')} · ${ARITHMETIC_LABELS[name]}` : name.replace(/_/g, ' '));
/** What an operation does, in words (the dropdown's second line). */
export const arithmeticHint = (name: string) => ARITHMETIC_LABELS[name];

const ARITHMETIC_SYMBOLS: Record<string, string> = { add: '+', subtract: '−', multiply: '×', divide: '÷' };
/** What the operation select shows: a symbol for + − × ÷, the plain name otherwise. */
export const arithmeticShort = (name: string) => ARITHMETIC_SYMBOLS[name] ?? name.replace(/_/g, ' ');

// Typed client for the Ruler REST API (docs/lld.md §10, §16). JSON is snake_case, as the server sends it.

export type Container = 'primitive' | 'list' | 'map';
export type Status = 'DRAFT' | 'ACTIVE' | 'INACTIVE';
export type Kind = 'decision-trees' | 'expressions';

export interface TypeRef {
  container_type: Container;
  data_type: string;
  key_type?: string | null;
  /** data_type enum only: the allowed values, in display order (lld §18). */
  enum_values?: string[] | null;
}

export interface ReturnSpec extends TypeRef {
  scale?: number | null;
  rounding?: string | null;
  /** data_type enum only (the definition JSON calls them allowed_values). */
  allowed_values?: string[] | null;
}

export interface TypeCatalog {
  container_types: Container[];
  data_types: { name: string; numeric: boolean }[];
}

export interface CaseView {
  name: string;
  attribute_count: number;
}

export interface ParamView {
  name: string;
  description: string | null;
  type: TypeRef;
  required: boolean;
  default_value: unknown;
  min: number | null;
  max: number | null;
  allowed_values: unknown[];
  pattern: string | null;
}

export interface AttributeView {
  name: string;
  code: string;
  description: string | null;
  dynamic: boolean;
  path: string | null;
  type: TypeRef;
  params: ParamView[];
}

export interface ExpressionView {
  key: string;
  name: string;
  version: number;
  description: string | null;
  result_type: TypeRef;
}

export interface CaseAttributes {
  case_name: string;
  description: string | null;
  attributes: AttributeView[];
}

export interface OperatorCatalog {
  lhs: TypeRef;
  condition: { name: string; rhs: TypeRef }[];
  arithmetic: { name: string; rhs: TypeRef | null; result: TypeRef }[];
}

export interface VersionSummary {
  key: string;
  case_name: string;
  name: string;
  description: string | null;
  latest_version: number;
  latest_status: Status;
  active_version: number | null;
  draft_version: number | null;
  updated_by: string;
  updated_at: string;
  return_type: TypeRef | null;
}

export interface VersionView {
  key: string;
  case_name: string;
  name: string;
  version: number;
  status: Status;
  data: any;
  sample_data?: unknown;
  result_type?: TypeRef | null;
  description: string | null;
  remarks: string | null;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
}

export interface StatusTransition {
  key: string;
  version: number;
  from: Status | null;
  to: Status;
  actor: string;
  at: string;
  remarks: string | null;
}

export interface HistoryView {
  versions: VersionView[];
  transitions: StatusTransition[];
}

export interface ValidationError {
  path: string;
  code: string;
  message: string;
}

export interface ValidationOutcome {
  valid: boolean;
  result_type?: TypeRef | null;
  errors: ValidationError[];
}

/** One thing the evaluator did (lld §22). Paths match validation paths; `(case:name@v)` marks steps inside a saved expression. */
export interface ExplainStep {
  kind: 'CONDITION' | 'CALCULATION' | 'REFERENCE' | 'VALUE';
  path: string;
  description?: string;
  operation?: string;
  lhs?: unknown;
  rhs?: unknown;
  result: unknown;
}

export interface Explanation {
  steps: ExplainStep[];
  attributes: { code: string; path?: string; params?: Record<string, unknown>; value: unknown }[];
}

export interface EvaluationResult {
  value: unknown;
  key: string;
  version: number;
  result_type?: string;
  explanation?: Explanation;
}

export interface RunOptions {
  version?: number;
  explain?: boolean;
}

const runQuery = (o: RunOptions = {}) => {
  const q = [o.version ? `version=${o.version}` : '', o.explain ? 'explain=true' : ''].filter(Boolean).join('&');
  return q ? `?${q}` : '';
};

/** A failed call; carries the RFC 9457 ProblemDetail fields Ruler sends. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly errors: ValidationError[] = [],
  ) {
    super(message);
  }
}

const BASE = '/ruler';
const ACTOR_KEY = 'ruler.actor';

export function getActor(): string {
  try {
    return localStorage.getItem(ACTOR_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setActor(actor: string) {
  try {
    localStorage.setItem(ACTOR_KEY, actor);
  } catch {
    /* storage unavailable: the name lives for this page only */
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && getActor()) headers['X-Ruler-Actor'] = getActor();
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new ApiError(res.status, json?.detail ?? json?.title ?? res.statusText, json?.code, json?.errors ?? []);
  }
  return json as T;
}

const enc = encodeURIComponent;
export const enumValues = (t: TypeRef | ReturnSpec | null | undefined): string[] | null =>
  t?.data_type === 'enum' ? t.enum_values ?? (t as ReturnSpec).allowed_values ?? null : null;

const typeQuery = (t: TypeRef) => {
  const values = enumValues(t);
  return (
    `container_type=${enc(t.container_type)}&data_type=${enc(t.data_type)}` +
    (t.key_type ? `&key_type=${enc(t.key_type)}` : '') +
    (values ? `&allowed_values=${enc(values.join(','))}` : '')
  );
};

export const api = {
  types: () => call<TypeCatalog>('GET', '/catalog/types'),
  cases: () => call<CaseView[]>('GET', '/catalog/cases'),
  attributes: (caseName: string, slot?: TypeRef) =>
    call<CaseAttributes>('GET', `/catalog/${enc(caseName)}/attributes` + (slot ? '?' + typeQuery(slot) : '')),
  // Every string operator works on an enum and gives the same result types (lld §18), so an enum lhs asks for string's.
  operators: (lhs: TypeRef) =>
    call<OperatorCatalog>('GET', '/catalog/operators?' + typeQuery(lhs.data_type === 'enum' ? { ...lhs, data_type: 'string', enum_values: null } : lhs)),
  /** ACTIVE expressions of a case; with a slot, only those whose result fits it. */
  expressions: (caseName: string, slot?: TypeRef) =>
    call<ExpressionView[]>('GET', `/catalog/${enc(caseName)}/expressions` + (slot ? '?' + typeQuery(slot) : '')),

  list: (kind: Kind, caseName: string) => call<VersionSummary[]>('GET', `/${kind}?case=${enc(caseName)}`),
  get: (kind: Kind, caseName: string, name: string, version?: number) =>
    call<VersionView>('GET', `/${kind}/${enc(caseName)}/${enc(name)}` + (version ? `?version=${version}` : '')),
  history: (kind: Kind, caseName: string, name: string) =>
    call<HistoryView>('GET', `/${kind}/${enc(caseName)}/${enc(name)}/history`),

  create: (kind: Kind, data: unknown, sampleData: unknown, remarks?: string) =>
    call<VersionView>('POST', `/${kind}`, { data, sample_data: sampleData, remarks }),
  update: (kind: Kind, caseName: string, name: string, data: unknown, sampleData: unknown, remarks: string) =>
    call<VersionView>('PUT', `/${kind}/${enc(caseName)}/${enc(name)}`, { data, sample_data: sampleData, remarks }),
  /** `sampleInput` undefined → the server uses the sample stored with the version. */
  approve: (kind: Kind, caseName: string, name: string, version: number, sampleInput: unknown, remarks?: string) =>
    call<VersionView>('POST', `/${kind}/${enc(caseName)}/${enc(name)}/versions/${version}/approve`, {
      sample_input: sampleInput,
      remarks,
    }),
  reject: (kind: Kind, caseName: string, name: string, version: number, remarks: string) =>
    call<VersionView>('POST', `/${kind}/${enc(caseName)}/${enc(name)}/versions/${version}/reject`, { remarks }),
  inactivate: (kind: Kind, caseName: string, name: string, remarks?: string) =>
    call<VersionView>('POST', `/${kind}/${enc(caseName)}/${enc(name)}/inactivate`, { remarks }),
  reactivate: (kind: Kind, caseName: string, name: string, version: number, remarks: string) =>
    call<VersionView>('POST', `/${kind}/${enc(caseName)}/${enc(name)}/versions/${version}/reactivate`, { remarks }),

  validateExpression: (data: unknown, sampleData: unknown) =>
    call<ValidationOutcome>('POST', '/expressions/validate', { data, sample_data: sampleData }),
  validateTree: (data: unknown, sampleData: unknown) =>
    call<ValidationOutcome>('POST', '/decision-trees/validate', { data, sample_data: sampleData }),
  validateNode: (caseName: string, path: string, node: unknown, returns?: ReturnSpec) =>
    call<ValidationOutcome>('POST', '/decision-trees/validate-node', { case: caseName, path, node, returns }),
  /** Runs a tree: the ACTIVE version, or `version` whatever its status; `explain` adds the steps taken. */
  evaluate: (caseName: string, name: string, input: unknown, opts?: RunOptions) =>
    call<EvaluationResult>('POST', `/evaluate/${enc(caseName)}/${enc(name)}${runQuery(opts)}`, input),
  evaluateExpression: (caseName: string, name: string, input: unknown, opts?: RunOptions) =>
    call<EvaluationResult>('POST', `/expressions/${enc(caseName)}/${enc(name)}/evaluate${runQuery(opts)}`, input),
};

export const typeLabel = (t: TypeRef | ReturnSpec | null | undefined): string => {
  if (!t) return '—';
  const values = enumValues(t);
  const data = values ? `enum[${values.join(', ')}]` : t.data_type;
  if (t.container_type === 'primitive') return data;
  if (t.container_type === 'list') return `list<${data}>`;
  return `map<${t.key_type ?? 'string'}, ${data}>`;
};

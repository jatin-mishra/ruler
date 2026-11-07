// Shared state for everything drawn on a canvas (tree cards, value rows, ladder steps).
import { createContext, useContext, useEffect, useId, useState } from 'react';
import type { ValidationError } from './api';
import type { Trace, TreeNode } from './model';

export interface TreeOps {
  setAt: (path: string, node: TreeNode | null) => void;
  /** Errors from the last whole-tree check, by owning node path. */
  treeErrors: Map<string, ValidationError[]>;
  /** "Collapse all" / "Expand all": every card and row follows the latest signal. */
  collapse: { open: boolean; n: number };
  /** Each card and row reports whether it is open (null = gone), so the one toggle knows what to offer. */
  report: (id: string, open: boolean | null) => void;
  /** The last Calculate run with explain=true: which nodes ran and their values; null = nothing to show. */
  trace: Trace | null;
}
export const TreeContext = createContext<TreeOps>(null as unknown as TreeOps);

/** Open/closed state that also follows the global collapse / expand-all signal. */
export function useFolding(initialOpen: boolean): [boolean, (open: boolean) => void] {
  const { collapse, report } = useContext(TreeContext);
  const id = useId();
  const [open, setOpen] = useState(initialOpen);
  useEffect(() => {
    if (collapse.n > 0) setOpen(collapse.open);
  }, [collapse]);
  useEffect(() => report(id, open), [id, open, report]);
  useEffect(() => () => report(id, null), [id, report]);
  return [open, setOpen];
}


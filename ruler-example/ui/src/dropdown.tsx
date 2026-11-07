// The app's dropdown: a button that opens a styled, grouped, searchable list (native <select> menus can't be styled).
// The list is rendered in a portal with fixed positioning, so cards, the zoomed canvas and scroll areas never clip it.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './ui';

export interface Option {
  value: string;
  label: string;
  /** Group heading the option sits under (options keep their order; a heading shows where the group starts). */
  group?: string;
  /** Short text on the right, e.g. a type. */
  meta?: string;
  /** A muted second line, e.g. an attribute's description. */
  hint?: string;
  /** Leading glyph or icon. */
  icon?: ReactNode;
  disabled?: boolean;
  /** Shown in the button when chosen (defaults to label), e.g. just "×" for "× multiply". */
  short?: string;
}

const SEARCH_FROM = 8; // a search box appears once the list is longer than this

export function Dropdown({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  ariaLabel,
  disabled,
  invalid,
  className = '',
  variant = 'field',
  minMenuWidth = 220,
}: {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  /** field = looks like an input; pill = the operator between two sides; chip = small inline control. */
  variant?: 'field' | 'pill' | 'chip';
  minMenuWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const listId = useId();

  const chosen = options.find((o) => o.value === value);
  const iconColumn = options.some((o) => o.icon); // keep labels aligned when only some options have an icon
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => `${o.label} ${o.meta ?? ''} ${o.hint ?? ''} ${o.group ?? ''}`.toLowerCase().includes(q)) : options;
  }, [options, query]);
  const selectable = shown.filter((o) => !o.disabled);

  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(r.width, minMenuWidth);
    const below = window.innerHeight - r.bottom;
    const up = below < 280 && r.top > below;
    setPos({ left: Math.min(r.left, window.innerWidth - width - 8), top: up ? r.top - 6 : r.bottom + 6, width, up });
  };

  const openMenu = () => {
    if (disabled) return;
    place();
    setQuery('');
    setActive(Math.max(0, selectable.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const choose = (o: Option) => {
    if (o.disabled) return;
    onChange(o.value);
    close();
  };

  // follow the button while the page or canvas scrolls; close on outside click
  useLayoutEffect(() => {
    if (!open) return;
    const onScroll = () => place();
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close(false);
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('mousedown', onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(selectable.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectable[active]) choose(selectable[active]);
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  let lastGroup: string | undefined;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`dd dd-${variant} ${open ? 'dd-open' : ''} ${chosen && value !== '' ? '' : 'dd-empty'} ${invalid ? 'invalid' : ''} ${className}`}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKey}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={chosen?.hint ?? chosen?.label}
      >
        {chosen?.icon && !chosen.short && <span className="dd-icon">{chosen.icon}</span>}
        <span className="dd-value">{chosen ? chosen.short ?? chosen.label : value ? value : placeholder}</span>
        <Icon name="expand" size={14} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menu}
            className={`dd-menu ${pos.up ? 'dd-up' : ''}`}
            style={{ left: pos.left, top: pos.top, width: pos.width }}
            onKeyDown={onKey}
          >
            {options.length > SEARCH_FROM && (
              <div className="dd-search">
                <input
                  autoFocus
                  value={query}
                  placeholder="Search…"
                  aria-label="Search options"
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                />
              </div>
            )}
            <div className="dd-list" role="listbox" id={listId} aria-label={ariaLabel}>
              {shown.length === 0 && <div className="dd-none">Nothing matches</div>}
              {shown.map((o) => {
                const heading = o.group && o.group !== lastGroup ? o.group : null;
                lastGroup = o.group;
                const i = selectable.indexOf(o);
                return (
                  <div key={`${o.group ?? ''}|${o.value}`}>
                    {heading && <div className="dd-group">{heading}</div>}
                    <div
                      role="option"
                      aria-selected={o.value === value}
                      aria-disabled={o.disabled}
                      data-active={i === active}
                      className={`dd-opt ${o.value === value ? 'is-chosen' : ''} ${o.disabled ? 'is-disabled' : ''}`}
                      onMouseEnter={() => i >= 0 && setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(o)}
                    >
                      {iconColumn && <span className="dd-icon">{o.icon}</span>}
                      <span className="dd-text">
                        <span className="dd-label">{o.label}</span>
                        {o.hint && <span className="dd-hint">{o.hint}</span>}
                      </span>
                      {o.meta && <span className="dd-meta">{o.meta}</span>}
                      {o.value === value && <Icon name="check" size={14} />}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

import { Popover, PopoverClose, PopoverContent, PopoverTrigger, buttonStyle } from '@paint/ui';

export interface MenuAction {
  readonly key: string;
  readonly label: string;
  readonly onSelect: () => void;
}

/**
 * A button that opens a short list of actions, e.g. the stages a lead can move
 * to. Works with the keyboard and screen readers; nothing to drag.
 */
export function ActionMenu({
  label,
  accessibleLabel,
  actions,
  size = 'md',
}: {
  readonly label: string;
  /** A longer name for screen readers, e.g. "Move LD-000001". */
  readonly accessibleLabel: string;
  readonly actions: readonly MenuAction[];
  readonly size?: 'md' | 'sm';
}) {
  if (actions.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger {...buttonStyle('secondary', size)} aria-label={accessibleLabel}>
        {label}
      </PopoverTrigger>
      <PopoverContent aria-label={accessibleLabel} className="action-menu">
        <ul className="action-menu__list">
          {actions.map((action) => (
            <li key={action.key}>
              <PopoverClose
                className="action-menu__item"
                onClick={() => {
                  action.onSelect();
                }}
              >
                {action.label}
              </PopoverClose>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

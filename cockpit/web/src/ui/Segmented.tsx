import {
  SelectionIndicator, ToggleButton, ToggleButtonGroup,
  type Key, type ToggleButtonGroupProps, type ToggleButtonProps,
} from 'react-aria-components';
import { Icon, type IconName } from '../icons';

// A segmented switch between views (Chat / Terminal; a list filter): the same
// sliding --surface block as the segmented RadioGroup, over a --task track.
export interface SegmentedProps extends Omit<ToggleButtonGroupProps, 'className' | 'selectionMode' | 'selectedKeys' | 'onSelectionChange'> {
  value: Key;
  onChange: (key: Key) => void;
  className?: string;
}

export function Segmented({ value, onChange, className = '', ...rest }: SegmentedProps) {
  return (
    <ToggleButtonGroup {...rest} selectionMode="single" disallowEmptySelection
      selectedKeys={[value]} onSelectionChange={(keys) => { const k = [...keys][0]; if (k != null) onChange(k); }}
      className={`inline-grid auto-cols-[minmax(max-content,1fr)] grid-flow-col p-1 rounded-btn bg-task ${className}`} />
  );
}

export function Segment({ icon, className = '', children, ...rest }: Omit<ToggleButtonProps, 'className'> & { icon?: IconName; className?: string }) {
  return (
    <ToggleButton {...rest}
      className={`relative inline-flex items-center justify-center gap-2 min-h-[38px] px-3 rounded-[5px] text-ui text-text-2 cursor-default outline-none
        transition-colors duration-[var(--t-fast)] ease-std data-[hovered]:text-text data-[selected]:text-text data-[selected]:font-semibold
        data-[focus-visible]:outline-2 data-[focus-visible]:outline-accent data-[focus-visible]:outline-offset-1 ${className}`}>
      {(rp) => (
        <>
          <SelectionIndicator className="sel-ind absolute inset-0 rounded-[5px] bg-surface shadow-[var(--elev-1),inset_0_0_0_1px_var(--line)]" />
          {icon && <Icon name={icon} className="relative" />}
          <span className="relative whitespace-nowrap">{typeof children === 'function' ? children(rp) : children}</span>
        </>
      )}
    </ToggleButton>
  );
}

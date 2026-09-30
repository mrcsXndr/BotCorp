import type { ReactNode } from 'react';
import {
  Label, Radio as RACRadio, RadioGroup as RACRadioGroup, Text,
  type RadioGroupProps as RACRadioGroupProps, type RadioProps,
} from 'react-aria-components';

// Two looks over one RAC RadioGroup:
//  - 'segmented': a --task track whose chosen option sits on a --surface
//    block (Appearance: Auto / Light / Dark);
//  - 'list': 44px rows with a squared mark that fills when chosen.
export interface RadioGroupProps extends Omit<RACRadioGroupProps, 'className' | 'children'> {
  label?: ReactNode;
  description?: ReactNode;
  appearance?: 'segmented' | 'list';
  children: ReactNode;
  className?: string;
}

export function RadioGroup({ label, description, appearance = 'list', children, className = '', ...rest }: RadioGroupProps) {
  const seg = appearance === 'segmented';
  return (
    <RACRadioGroup {...rest} orientation={seg ? 'horizontal' : 'vertical'} data-appearance={appearance}
      className={`group/rg flex flex-col gap-1.5 ${className}`}>
      {label != null && <Label className="text-sm font-semibold text-text">{label}</Label>}
      <div className={seg ? 'grid auto-cols-fr grid-flow-col p-1 rounded-btn bg-task' : 'flex flex-col'}>{children}</div>
      {description != null && <Text slot="description" className="text-sm text-text-2">{description}</Text>}
    </RACRadioGroup>
  );
}

export function Radio({ className = '', children, ...rest }: Omit<RadioProps, 'className'> & { className?: string }) {
  return (
    <RACRadio {...rest}
      className={`group relative flex items-center gap-3 min-h-[var(--tap)] cursor-default outline-none text-ui text-text
        group-data-[appearance=segmented]/rg:justify-center group-data-[appearance=segmented]/rg:min-h-[38px] group-data-[appearance=segmented]/rg:px-3
        group-data-[appearance=segmented]/rg:text-text-2 data-[selected]:group-data-[appearance=segmented]/rg:text-text data-[selected]:font-semibold
        data-[focus-visible]:outline-2 data-[focus-visible]:outline-accent data-[focus-visible]:outline-offset-2 data-[disabled]:text-text-3 ${className}`}>
      {(rp) => (
        <>
          {/* RAC's SelectionIndicator renders nothing inside a RadioGroup, so the chosen option draws its own block */}
          {rp.isSelected && <span aria-hidden data-sel className="absolute inset-0 rounded-[5px] bg-surface shadow-[var(--elev-1),inset_0_0_0_1px_var(--line)] hidden group-data-[appearance=segmented]/rg:block" />}
          <span aria-hidden className="relative grid place-items-center size-5 flex-none rounded-xs border-[1.5px] border-line-strong
            transition-colors duration-[var(--t-fast)] ease-std group-data-[selected]:border-accent
            group-data-[appearance=segmented]/rg:hidden">
            <span className="size-2.5 rounded-[2px] bg-accent scale-0 transition-transform duration-[var(--t-fast)] ease-std group-data-[selected]:scale-100" />
          </span>
          <span className="relative">{typeof children === 'function' ? children(rp) : children}</span>
        </>
      )}
    </RACRadio>
  );
}

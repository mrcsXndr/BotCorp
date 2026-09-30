import type { ReactNode } from 'react';
import { Label, Meter as RACMeter, type MeterProps as RACMeterProps } from 'react-aria-components';

/** The header readouts' level(): --warn from 75%, --bad from 90%. */
export function meterLevel(pct: number): 'ok' | 'warn' | 'bad' {
  return pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : 'ok';
}

const FILL = { ok: 'bg-text-2', warn: 'bg-warn', bad: 'bg-bad' } as const;
const TEXT = { ok: 'text-text', warn: 'text-warn', bad: 'text-bad' } as const;

// A labelled usage meter: label left, the value (mono) right, then a 6px
// track whose fill grows by width (stable round caps, no scale).
export interface MeterProps extends Omit<RACMeterProps, 'className' | 'children'> {
  label: ReactNode;
  /** under the track, --text-2: "resets 14:20" */
  detail?: ReactNode;
  className?: string;
}

export function Meter({ label, detail, className = '', ...rest }: MeterProps) {
  return (
    <RACMeter {...rest} className={`flex flex-col gap-1.5 ${className}`}>
      {({ percentage, valueText }) => {
        const level = meterLevel(percentage);
        return (
          <>
            <div className="flex items-baseline gap-2">
              <Label className="flex-1 text-ui text-text">{label}</Label>
              <span className={`num text-ui ${TEXT[level]}`} data-level={level}>{valueText}</span>
            </div>
            <div className="h-1.5 rounded-[3px] bg-line overflow-hidden">
              <div className={`h-full rounded-[3px] ${FILL[level]} transition-[width] duration-[var(--t-med)] ease-std`}
                style={{ width: `${percentage}%` }} />
            </div>
            {detail != null && <div className="text-sm text-text-2">{detail}</div>}
          </>
        );
      }}
    </RACMeter>
  );
}

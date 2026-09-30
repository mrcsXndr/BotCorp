import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { FieldError, Input, Label, Text, TextArea, TextField as RACTextField, type TextFieldProps as RACTextFieldProps } from 'react-aria-components';

// A labelled field: 44px tall, 16px text (no iOS zoom on focus), --field
// fill and a strong edge that turns --accent on focus and --bad when invalid.
// The error region is always in the DOM so a server's 400 text can land in it.
export interface TextFieldProps extends Omit<RACTextFieldProps, 'className' | 'children'> {
  label?: ReactNode;
  description?: ReactNode;
  errorMessage?: ReactNode;
  placeholder?: string;
  multiline?: boolean;
  /** multiline only: grows with its text; `rows` is the minimum */
  autoGrow?: boolean;
  rows?: number;
  mono?: boolean;
  className?: string;
}

const field =
  'w-full min-h-[var(--tap)] px-3 rounded-btn bg-field border border-line-strong text-body text-text leading-ui outline-none ' +
  'placeholder:text-text-3 transition-colors duration-[var(--t-fast)] ease-std data-[hovered]:border-text-3 ' +
  'data-[focused]:border-accent data-[focused]:shadow-[0_0_0_1px_var(--accent)] data-[invalid]:border-bad data-[disabled]:opacity-60';

export function TextField({ label, description, errorMessage, placeholder, multiline, autoGrow, rows = 3, mono, className = '', ...rest }: TextFieldProps) {
  const area = useRef<HTMLTextAreaElement>(null);
  // auto-grow: `rows` is the minimum, the box follows its text up to a cap
  useLayoutEffect(() => {
    const el = area.current;
    if (!autoGrow || !el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  });
  return (
    <RACTextField {...rest} className={`flex flex-col gap-1.5 ${className}`}>
      {label != null && <Label className="text-sm font-semibold text-text">{label}</Label>}
      {multiline
        ? <TextArea ref={area} placeholder={placeholder} rows={rows} className={`${field} py-2.5 resize-none ${autoGrow ? 'max-h-48 overflow-y-auto' : ''} ${mono ? 'font-code' : ''}`} />
        : <Input placeholder={placeholder} className={`${field} ${mono ? 'font-code' : ''}`} />}
      {description != null && <Text slot="description" className="text-sm text-text-2">{description}</Text>}
      <FieldError className="text-sm text-bad">{errorMessage}</FieldError>
    </RACTextField>
  );
}

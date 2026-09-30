import { useRef, useState } from 'react';
import { Label, TextArea, TextField } from 'react-aria-components';
import { IconButton, toast } from '../../ui';
import { Icon } from '../../icons';
import { attachView } from '../../lib/cards';
import { COPY, t } from '../../lib/copy';

// The files on a paste or a drop (a copied screenshot arrives as an image item).
export function clipFiles(dt: DataTransfer | null): File[] {
  const out: File[] = [];
  for (const it of dt?.items || []) if (it.kind === 'file') { const f = it.getAsFile(); if (f) out.push(f); }
  if (!out.length) for (const f of dt?.files || []) out.push(f);
  return out;
}

// The message box: attach, the text (1 line growing to 8; Enter sends,
// Shift+Enter breaks the line), send. Files wait as chips above it.
export function Composer({ bot, onSend }: { bot: string; onSend: (text: string, files: File[]) => void }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const add = (list: File[]) => {
    const next = [...files];
    for (const f of list) {
      const v = attachView(f, next.length);
      if (v.why) { toast(v.why, 'bad'); continue; }
      next.push(f);
    }
    setFiles(next);
  };
  const send = () => {
    const body = text.replace(/\s+$/, '');
    if (!body && !files.length) return;
    onSend(body, files);
    setText('');
    setFiles([]);
  };
  const label = t(COPY.row.message, { bot });
  return (
    <form className="flex-none bg-bg shadow-[0_-1px_0_var(--line)] px-2 pt-2 pb-[max(8px,env(safe-area-inset-bottom))]"
      onSubmit={(e) => { e.preventDefault(); send(); }}>
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1 pb-2">
          {files.map((f, i) => {
            const v = attachView(f, i);
            return (
              <span key={`${f.name}:${i}`} className="inline-flex items-center gap-1.5 max-w-full pl-2 rounded-xs bg-task text-sm text-text">
                <Icon name="clip" size={13} className="flex-none text-text-2" />
                <span className="truncate">{v.name}</span><span className="num text-xs text-text-3 flex-none">{v.size}</span>
                <IconButton icon="x" size={14} label={t(COPY.button.removeFile, { file: v.name })} onPress={() => setFiles(files.filter((_, j) => j !== i))} />
              </span>
            );
          })}
        </div>
      )}
      <div className="flex items-end gap-1.5">
        <IconButton icon="clip" label={COPY.button.attach} onPress={() => input.current?.click()} />
        <input ref={input} type="file" multiple hidden onChange={(e) => { add([...(e.target.files || [])]); e.target.value = ''; }} />
        <TextField aria-label={label} value={text} onChange={setText} className="flex-1 min-w-0">
          <Label className="sr-only">{label}</Label>
          <TextArea rows={1} placeholder={label}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            onPaste={(e) => { const fs = clipFiles(e.clipboardData); if (fs.length) { e.preventDefault(); add(fs); } }}
            className="block w-full min-h-[var(--tap)] max-h-[calc(8*1.55em+20px)] px-3 py-[10px] rounded-btn bg-field border border-line-strong
              text-body leading-body text-text outline-none resize-none [field-sizing:content] placeholder:text-text-3
              data-[focused]:border-accent data-[focused]:shadow-[0_0_0_1px_var(--accent)]" />
        </TextField>
        <IconButton icon="send" label={COPY.button.send} tone="accent" type="submit" isDisabled={!text.trim() && !files.length} />
      </div>
    </form>
  );
}

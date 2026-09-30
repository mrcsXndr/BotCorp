// The state dot: an 8px disc in the state's colour, always beside the state
// word or the kind label it marks (the word carries the meaning, the dot lets
// a list scan). No glow, no pulse, never on its own.
export type DotTone = 'ok' | 'warn' | 'bad' | 'idle' | 'accent';

const COLOR: Record<DotTone, string> = {
  ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', idle: 'bg-text-3', accent: 'bg-accent',
};

export function Dot({ tone, className = '' }: { tone: DotTone; className?: string }) {
  return <span aria-hidden data-tone={tone} className={`inline-block flex-none size-2 rounded-full ${COLOR[tone]} ${className}`} />;
}

import { useMemo } from 'react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { renderMarkdown } from '../../lib/md';
import { COPY } from '../../lib/copy';
import helpText from '../../help.md?raw';

// `#/help`: src/help.md, one short section each. Each `## Title` becomes a
// real h2; the body goes through lib/md.ts (which escapes everything).
export function HelpScreen() {
  const sections = useMemo(() => helpText.split(/^## /m).map((s) => s.trim()).filter(Boolean).map((s) => {
    const nl = s.indexOf('\n');
    return { title: s.slice(0, nl).trim(), html: renderMarkdown(s.slice(nl + 1)) };
  }), []);
  return (
    <div className="mx-auto w-full max-w-[720px] pb-8">
      <ScreenHeader>{COPY.title.help}</ScreenHeader>
      {sections.map((s) => (
        <section key={s.title} className="px-4 py-3">
          <h2 className="m-0 mb-1 font-display text-lg leading-tight text-text">{s.title}</h2>
          <div className="md text-body leading-body text-text-2" dangerouslySetInnerHTML={{ __html: s.html }} />
        </section>
      ))}
    </div>
  );
}

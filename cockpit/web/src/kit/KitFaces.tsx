import { Segment, Segmented } from '../ui';
import { FACES, KitHeader, useFace, type FaceId } from './Kit';

const FAMILY: Record<FaceId, string> = {
  karrik: '"Karrik", var(--face-sans)',
  apfel: '"Apfel Grotezk", var(--face-sans)',
  ortica: '"Ortica Linear", var(--face-sans)',
};

// The display-face candidates side by side, each on the same content: a bot
// name, a screen title and the numerals, over a body line in the system face.
// "Use" applies one to every kit screen.
export function KitFaces() {
  const [face, setFace] = useFace();
  return (
    <div className="pb-10">
      <KitHeader title="Faces" />
      <div className="px-4 pt-4">
        <p className="m-0 text-body leading-body text-text-2">
          One display face for bot names and screen titles; body text stays on the system face. All three are SIL OFL, self-hosted.
        </p>
        <Segmented aria-label="Use face" value={face} onChange={(k) => setFace(k as FaceId)} className="mt-3 w-full">
          {FACES.map((f) => <Segment key={f.id} id={f.id}>{f.name.split(' ')[0]}</Segment>)}
        </Segmented>
      </div>
      {FACES.map((f) => (
        <section key={f.id} aria-label={f.name} className="mt-6 mx-4 px-4 py-4 rounded-card bg-surface shadow-1">
          <div className="flex items-baseline gap-2">
            <h2 className="m-0 text-ui font-semibold text-text">{f.name}</h2>
            {face === f.id && <span className="text-sm font-semibold text-accent">in use</span>}
          </div>
          <p className="m-0 mt-1 text-sm leading-ui text-text-2">{f.note}</p>
          <div style={{ fontFamily: FAMILY[f.id] }} className="mt-4 text-text">
            <div className="text-2xl leading-tight">Updates</div>
            <div className="mt-3 flex items-center gap-3">
              <span className="text-xl leading-tight">atlas</span>
              <span className="text-xl leading-tight text-text-2">harbor</span>
            </div>
            <div className="mt-3 text-lg leading-tight">Inbox · Settings · 0123456789</div>
          </div>
          <p className="m-0 mt-3 text-body leading-body text-text-2">
            <span className="font-semibold text-warn">waiting on you</span> · asked which chat gets the nightly digest
          </p>
        </section>
      ))}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Form } from 'react-aria-components';
import { usePairClaim } from '../api/queries';
import { setNeedHandler } from '../api/http';
import { Button, Sheet, TextField, toast } from '../ui';
import { FormError } from '../screens/manage/shared';
import { COPY } from '../lib/copy';

// Loopback only: an operator-gated call the browser is not paired for answers
// 403 {need}; the client hands that here. Enter the code `botcorp cockpit pair`
// printed and the call runs again; close the sheet and it fails with the
// server's text. Under Access the server never answers that, so it never opens.
export function PairHost() {
  const [open, setOpen] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const claim = usePairClaim();
  useEffect(() => setNeedHandler(() => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setError(''); setCode(''); setOpen(true);
  })), []);
  const finish = (ok: boolean) => { const r = resolver.current; resolver.current = null; setOpen(false); r?.(ok); };
  return (
    <Sheet isOpen={open} onOpenChange={(o) => { if (!o) finish(false); }} title={COPY.title.pairBrowser}>
      <Form className="flex flex-col gap-4" onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        try { await claim.mutateAsync({ code: code.trim() }); toast(COPY.toast.browserPaired, 'ok'); finish(true); }
        catch (err) { setError((err as Error).message); }
      }}>
        <TextField label={COPY.row.pairingCode} name="code" value={code} onChange={setCode} autoFocus autoComplete="off" mono />
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" block isDisabled={!code.trim() || claim.isPending}>{COPY.button.pair}</Button>
      </Form>
    </Sheet>
  );
}

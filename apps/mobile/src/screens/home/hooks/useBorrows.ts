// Phase C: borrowing domain extracted from HomeScreen (pure move, no behavior change).
// Open borrows per space ("مين أخذها؟"): list, match a thing to its borrow, two-tap return.
import { useCallback, useState } from 'react';
import type { Borrow } from '@mawjood/voice-engine';
import { engine } from '../../../lib/engine';

export function useBorrows() {
  const [borrows, setBorrows] = useState<Borrow[]>([]);
  const [confirmReturnId, setConfirmReturnId] = useState<string | null>(null);
  // ── borrowing (مين أخذها؟): match a thing to its open borrow ──
  const normAr = (t: string) =>
    t
      .toLowerCase()
      .replace(/[ً-ٰٟ]/g, '')
      .replace(/ـ/g, '')
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .split(/\s+/)
      .map((w) => w.replace(/^ال/, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  const borrowFor = (title: string): Borrow | undefined => {
    const nt = normAr(title);
    return borrows.find((b) => normAr(b.item_title) === nt);
  };
  const onReturnBorrow = useCallback(
    async (br: Borrow) => {
      if (confirmReturnId !== br.id) {
        setConfirmReturnId(br.id); // first tap → ask for confirmation
        return;
      }
      setConfirmReturnId(null);
      try {
        await engine.returnBorrow(br.id);
        setBorrows((prev) => prev.filter((b) => b.id !== br.id));
      } catch (e) {
        console.warn('returnBorrow failed', e);
      }
    },
    [confirmReturnId],
  );

  return {
    borrows,
    setBorrows,
    confirmReturnId,
    setConfirmReturnId,
    borrowFor,
    onReturnBorrow,
  };
}

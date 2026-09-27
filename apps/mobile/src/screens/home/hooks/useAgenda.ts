// Phase C: agenda domain extracted from HomeScreen (pure move, no behavior change).
// Appointment search, week-strip day filter, per-day counts, visible-day memo.
import { useMemo, useState } from 'react';
import type { Item, Space } from '@mawjood/voice-engine';
import { engine } from '../../../lib/engine';
import { useTabSearch } from '../../../lib/useTabSearch';

export interface UseAgendaArgs {
  upcoming: Item[];
  viewSpace: Space | null;
}

export function useAgenda({ upcoming, viewSpace }: UseAgendaArgs) {
  const agendaSearch = useTabSearch<Item>({
    search: (q) =>
      viewSpace
        ? engine.search(viewSpace.id, q, { kinds: ['appointment'], includeNotes: false }).then((r) => r.items)
        : Promise.resolve([]),
  });
  // ── agenda week strip: selected day filter (YYYY-MM-DD) ──
  const [agendaDay, setAgendaDay] = useState<string | null>(null);
  const agendaDayISO = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const agendaCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const u of upcoming) {
      const k = u.due_at ? agendaDayISO(u.due_at) : null;
      if (k) c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [upcoming]);
  const agendaVisible = useMemo(
    () =>
      agendaDay
        ? upcoming.filter((u) => u.due_at && agendaDayISO(u.due_at) === agendaDay)
        : upcoming,
    [upcoming, agendaDay],
  );

  return {
    agendaSearch,
    agendaDay,
    setAgendaDay,
    agendaDayISO,
    agendaCounts,
    agendaVisible,
  };
}

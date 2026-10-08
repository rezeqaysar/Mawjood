// Phase C: shopping domain extracted from HomeScreen (pure move, no behavior change).
// Directed shopping lists + loose-item adoption + per-tab search.
// Stays in HomeScreen: toggleItem (shared item toggle), onAssign (tasks),
// refreshFamily/onRefreshShopping (family space loader).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';
import type { FamilyMember, Item, ShoppingList, Space } from '@mawjood/voice-engine';
import { splitShoppingItems } from '@mawjood/voice-engine';
import { engine } from '../../../lib/engine';
import { t, tx } from '../../../lib/i18n';
import { tap } from '../../../lib/haptics';
import { useTabSearch } from '../../../lib/useTabSearch';

export interface UseShoppingArgs {
  userId: string | null;
  viewSpace: Space | null;
  trashRetention: number;
  familyMembers: FamilyMember[] | null;
  displayName: string | null;
  userEmail: string | null;
  showUndo: (msg: string, run: () => void) => void;
}

export function useShopping({
  userId,
  viewSpace,
  trashRetention,
  familyMembers,
  displayName,
  userEmail,
  showUndo,
}: UseShoppingArgs) {
  const [shopping, setShopping] = useState<Item[]>([]);
  const [shopLists, setShopLists] = useState<ShoppingList[]>([]); // directed lists ("يا جون جيب…")

  const shopSearch = useTabSearch<ShoppingList>({
    items: shopLists,
    filter: (ls, q) =>
      ls.filter(
        (l) =>
          l.title.toLowerCase().includes(q) ||
          (l.assigned_name ?? '').toLowerCase().includes(q) ||
          l.items.some((i) => i.title.toLowerCase().includes(q)),
      ),
  });

  const [activeListId, setActiveListId] = useState<string | null>(null); // shopping-mode modal
  const adoptedRef = useRef<string | null>(null); // loose-shopping adoption, once per space

  const [newListOpen, setNewListOpen] = useState(false); // manual list creator modal
  const [newListTitle, setNewListTitle] = useState('');
  const [newListItems, setNewListItems] = useState('');
  const [newListAssignee, setNewListAssignee] = useState<string | null>(null);
  const [archOpenId, setArchOpenId] = useState<string | null>(null); // expanded archived list
  const [assignFor, setAssignFor] = useState<string | null>(null);
  const [assignName, setAssignName] = useState('');

  /**
   * Set one shopping-list item's status: bought (✅), not found (❌ ما لقيناه),
   * or back to open. When every item is resolved the list is archived
   * (status done → moves to the history section).
   */
  const setShopItemStatus = useCallback(
    async (listId: string, item: Item, status: Item['status']) => {
      const list = shopLists.find((l) => l.id === listId);
      if (!list) return;
      tap('light');
      const now = new Date().toISOString();
      const items = list.items.map((p) =>
        p.id === item.id
          ? { ...p, status, bought_at: status === 'done' ? now : null }
          : p,
      );
      const allResolved = items.length > 0 && items.every((p) => p.status !== 'open');
      const listStatus = allResolved ? 'done' : 'open';
      // preserve the original archive date when editing an already-archived list
      const completedAt = allResolved ? (list.completed_at ?? now) : null;
      setShopLists((prev) =>
        prev.map((l) =>
          l.id === listId
            ? { ...l, items, status: listStatus, completed_at: completedAt }
            : l,
        ),
      );
      try {
        await engine.setItemStatus(item.id, status);
        await engine.setShoppingListStatus(listId, listStatus, completedAt);
      } catch (e) {
        console.warn('setShopItemStatus failed', e);
        // roll back the optimistic update (e.g. migration 0015 not run yet)
        setShopLists((prev) =>
          prev.map((l) =>
            l.id === listId ? { ...l, items: list.items, status: list.status } : l,
          ),
        );
      }
    },
    [shopLists],
  );

  /** Delete a shopping list → trash (Plus) or permanent (free). Single tap: trash is the safety net. */
  const deleteShopList = useCallback(
    async (listId: string) => {
      if (!userId) return;
      const snap = shopLists.find((l) => l.id === listId);
      setShopLists((prev) => prev.filter((l) => l.id !== listId));
      if (activeListId === listId) setActiveListId(null);
      try {
        await engine.trashShoppingList(listId, userId, trashRetention);
        tap('medium');
        if (snap) {
          showUndo(t('deletedList'), () => {
            setShopLists((prev) => [snap, ...prev.filter((l) => l.id !== snap.id)]);
            void engine
              .undelete(
                snap.id,
                'shopping_lists',
                snap as unknown as Record<string, unknown>,
                (snap.items ?? []) as unknown as Record<string, unknown>[],
              )
              .catch((e) => console.warn('undelete failed', e));
          });
        }
      } catch (e) {
        console.warn('trashShoppingList failed', e);
      }
    },
    [userId, trashRetention, activeListId, shopLists, showUndo],
  );

  /** share a shopping list as text: native share sheet on web (iOS share
   *  options: WhatsApp, Messages, Mail…), wa.me fallback elsewhere. */
  const shareShoppingList = useCallback((list: ShoppingList) => {
    const lines = list.items.map(
      (i) =>
        `${i.status === 'done' ? '✅' : i.status === 'not_found' ? '❌' : '⬜'} ${i.title}${
          i.status === 'not_found' ? ` ${t('shareNotFoundTag')}` : ''
        }`,
    );
    const text = `${t('shareListHead')}: ${list.title}\n${lines.join('\n')}`;
    const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { share?: (d: { text: string }) => Promise<void> }) : undefined;
    if (nav?.share) {
      nav.share({ text }).catch(() => console.warn('share failed'));
      return;
    }
    void Linking.openURL(`https://wa.me/?text=${encodeURIComponent(text)}`).catch(() =>
      console.warn('share failed'),
    );
  }, []);

  /** Restore an archived list to live: not_found items reopen, bought stay bought. */
  const restoreShopList = useCallback(
    async (listId: string) => {
      const list = shopLists.find((l) => l.id === listId);
      if (!list || list.status !== 'done') return;
      const items = list.items.map((p) =>
        p.status === 'not_found' ? { ...p, status: 'open' as const } : p,
      );
      setShopLists((prev) =>
        prev.map((l) =>
          l.id === listId ? { ...l, items, status: 'open' as const, completed_at: null } : l,
        ),
      );
      if (archOpenId === listId) setArchOpenId(null);
      try {
        await engine.restoreShoppingList(listId);
      } catch (e) {
        console.warn('restoreShoppingList failed', e);
        // roll back the optimistic update
        setShopLists((prev) =>
          prev.map((l) => (l.id === listId ? { ...list, status: 'done' as const } : l)),
        );
      }
    },
    [shopLists, archOpenId],
  );

  const [shopRefreshing, setShopRefreshing] = useState(false);

  const createManualList = useCallback(async () => {
    const items = splitShoppingItems(newListItems);
    const sid = viewSpace?.id;
    if (items.length === 0 || !sid || !userId) return;
    const member = (familyMembers ?? []).find((m) => m.user_id === newListAssignee) ?? null;
    const assigneeName = member?.display_name ?? null;
    const title =
      newListTitle.trim() ||
      (assigneeName ? tx('shopListTitle', { name: assigneeName }) : t('shopListGenericTitle'));
    setNewListOpen(false);
    setNewListTitle('');
    setNewListItems('');
    setNewListAssignee(null);
    try {
      const list = await engine.createShoppingList({
        spaceId: sid,
        title,
        assignedTo: member?.user_id ?? null,
        assignedName: assigneeName,
        items,
        userId,
      });
      setShopLists((prev) => [list, ...prev]);
      if (member?.user_id) {
        const speaker = displayName ?? userEmail ?? '';
        engine
          .notifyUser(
            member.user_id,
            t('shopListPushTitle'),
            tx('shopListPushBody', { by: speaker, items: items.join('، ') }),
          )
          .catch(() => {});
      }
    } catch (e) {
      console.warn('createManualList failed', e);
    }
  }, [newListItems, newListTitle, newListAssignee, viewSpace, userId, familyMembers, displayName, userEmail]);

  /**
   * Transition helper: sweep any loose shopping items (created before the
   * list-only change, or by the old extract fn before its redeploy) into one
   * unassigned list so nothing stays invisible.
   */
  const adoptLooseShopping = useCallback(
    async (spaceId: string, loose: Item[]) => {
      if (loose.length === 0 || !userId) return;
      try {
        const list = await engine.createShoppingList({
          spaceId,
          title: t('shopListGenericTitle'),
          assignedTo: null,
          assignedName: null,
          items: [],
          userId,
        });
        await engine.attachItemsToList(
          loose.map((i) => i.id),
          list.id,
        );
        setShopping([]);
        const withItems = await engine.listShoppingLists(spaceId);
        setShopLists(withItems);
      } catch (e) {
        console.warn('adoptLooseShopping failed', e);
      }
    },
    [userId],
  );

  // list-only shopping: sweep stray loose items into one unassigned list
  // (once per space — covers items made before this change)
  useEffect(() => {
    adoptedRef.current = null;
  }, [viewSpace?.id]);
  useEffect(() => {
    const sid = viewSpace?.id;
    if (!sid || shopping.length === 0 || adoptedRef.current) return;
    adoptedRef.current = sid;
    void adoptLooseShopping(sid, shopping);
  }, [viewSpace?.id, shopping, adoptLooseShopping]);

  return {
    shopping,
    setShopping,
    shopLists,
    setShopLists,
    shopSearch,
    activeListId,
    setActiveListId,
    newListOpen,
    setNewListOpen,
    newListTitle,
    setNewListTitle,
    newListItems,
    setNewListItems,
    newListAssignee,
    setNewListAssignee,
    archOpenId,
    setArchOpenId,
    assignFor,
    setAssignFor,
    assignName,
    setAssignName,
    shopRefreshing,
    setShopRefreshing,
    setShopItemStatus,
    deleteShopList,
    shareShoppingList,
    restoreShopList,
    createManualList,
    adoptLooseShopping,
  };
}

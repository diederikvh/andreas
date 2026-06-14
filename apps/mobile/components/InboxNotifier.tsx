/**
 * Detecteert lokaal nieuwe inbox-items (friend-requests + invitations)
 * en triggert de InboxToast. Werkt náást de push-listener: zelfs als
 * een push gemist wordt (no-permission, OEM battery, simulator-APNS)
 * vangt de polling 'm op zodra de gebruiker op de voorgrond is.
 *
 * Spelregels:
 *  - Eerste pass na sessie-start primet de "seen"-set zonder toasts —
 *    bestaande items zijn geen "nieuw".
 *  - Daarna: elke ID die ontbrak in de vorige set → toast.
 *  - Op /social (en /jij als fallback) tonen we GEEN toast: daar staat
 *    de rij al voor je neus, dubbele feedback is irritant.
 *  - Alleen incoming pending invitations triggeren een toast —
 *    outgoing/accepted/declined zijn geen actie-vereist.
 *  - End-of-tick prune: items die uit de lijst verdwijnen (decline,
 *    intrekken) verlaten ook de seen-set. Belangrijk voor friend-
 *    requests: ApiFriendRequest.id == userId, dus 'n hervatte aanvraag
 *    van dezelfde persoon krijgt anders nooit meer een banner.
 */
import { usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';

import { useInboxToast } from '@/components/InboxToast';
import { useSession } from '@/lib/authClient';
import { useT } from '@/lib/i18n';
import { useFriendRequests, useInvitations } from '@/lib/queries';

export function InboxNotifier() {
  const { data: session } = useSession();
  const authed = Boolean(session?.user?.id);
  const userId = session?.user?.id ?? null;
  const { data: requests } = useFriendRequests({ enabled: authed });
  const { data: invitations } = useInvitations({ enabled: authed });
  const { showToast } = useInboxToast();
  const pathname = usePathname();
  const t = useT();

  const seenRequestIds = useRef<Set<string>>(new Set());
  const seenInviteIds = useRef<Set<string>>(new Set());
  // Per-user init zodat het wisselen van account opnieuw primet — zo
  // krijg je geen ghost-toasts uit het vorige account.
  const primedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!authed || !userId) {
      seenRequestIds.current = new Set();
      seenInviteIds.current = new Set();
      primedFor.current = null;
      return;
    }
    if (!requests || !invitations) return;

    // Eerste keer voor deze user: prime de sets, geen toasts.
    if (primedFor.current !== userId) {
      seenRequestIds.current = new Set(requests.map((r) => r.id));
      seenInviteIds.current = new Set(invitations.map((i) => i.id));
      primedFor.current = userId;
      return;
    }

    const onSocialView =
      pathname.startsWith('/social') || pathname.startsWith('/jij');

    if (!onSocialView) {
      for (const r of requests) {
        if (seenRequestIds.current.has(r.id)) continue;
        showToast({
          title: t('Nieuw verzoek', 'New request'),
          body: t(
            `${r.name} wil bevriend worden`,
            `${r.name} wants to connect`
          ),
          url: '/social',
        });
      }
      for (const inv of invitations) {
        if (seenInviteIds.current.has(inv.id)) continue;
        // Alleen incoming pending — een outgoing invite die ik zelf
        // verstuurd heb of een 'going'-RSVP die ik al had hoeft geen
        // banner.
        if (inv.isOutgoing) continue;
        if (inv.myStatus !== 'pending') continue;
        showToast({
          title: t('Nieuwe uitnodiging', 'New invitation'),
          body: t(
            `${inv.from.name} vraagt je mee naar ${inv.event.title}`,
            `${inv.from.name} is inviting you to ${inv.event.title}`
          ),
          url: inv.group
            ? `/invitation/${inv.id}`
            : `/event/${inv.event.id}?o=${inv.occurrence.id}`,
        });
      }
    }

    // Update de seen-sets — ook wanneer we op de sociaal-tab zaten,
    // anders krijg je bij wegnavigeren alsnog backlog-toasts.
    for (const r of requests) seenRequestIds.current.add(r.id);
    for (const inv of invitations) seenInviteIds.current.add(inv.id);

    // Prune: items die uit de lijst zijn verdwenen (request geaccepteerd
    // /declined, invite ingetrokken, verlopen) moeten ook uit de seen-
    // set zodat 'n hervatte verzending opnieuw toastet. Belangrijk voor
    // friend-requests: ApiFriendRequest.id == userId, dus dezelfde
    // vriend die declined → opnieuw aanvraag stuurt heeft dezelfde key.
    // Zonder prune zou de tweede aanvraag stil blijven.
    const currentReqIds = new Set(requests.map((r) => r.id));
    const currentInvIds = new Set(invitations.map((i) => i.id));
    for (const id of seenRequestIds.current) {
      if (!currentReqIds.has(id)) seenRequestIds.current.delete(id);
    }
    for (const id of seenInviteIds.current) {
      if (!currentInvIds.has(id)) seenInviteIds.current.delete(id);
    }
  }, [authed, userId, requests, invitations, pathname, showToast, t]);

  return null;
}

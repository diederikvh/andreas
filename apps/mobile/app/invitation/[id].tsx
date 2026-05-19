import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BackButton } from '@/components/BackButton';
import { EventListRow } from '@/components/EventListRow';
import { ProfileAvatar } from '@/components/ProfileAvatar';
import type { ApiInvitation, ApiInvitationResponse, InvitationStatus } from '@/lib/api';
import {
  CATEGORY_TICK,
  dowMixed,
  eventImageUrl,
  monthShort,
  rowTimeLabel,
  translateCategory,
} from '@/lib/eventDisplay';
import { useLocale, useT } from '@/lib/i18n';
import { safeBack } from '@/lib/navigation';
import { useSession } from '@/lib/authClient';
import {
  useInvitations,
  useRemindInvitation,
  useRespondInvitation,
  useRevokeInvitation,
} from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

/**
 * Detail-overzicht van één uitnodiging — toont event-info, optioneel
 * groeps-context, en alle responses gegroepeerd per status. Initiator
 * ziet bij elke pending rij een Herinner-knop (één-shot per spec) en
 * een Intrekken-actie. Niet-initiator ziet zijn eigen response-knoppen
 * (Ga / Misschien / Nee) met optioneel reply-veld.
 */
export default function InvitationDetail() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = rawId ?? '';
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();

  const { data: session } = useSession();
  const myId = session?.user?.id ?? null;

  // Pak invitation uit de cache (de InviteRow die hierheen navigeerde
  // staat al in `useInvitations`). Als ie ontbreekt — bv. door een
  // diepe link — tonen we een fallback.
  const { data: invitations } = useInvitations();
  const invitation = useMemo(
    () => invitations?.find((inv) => inv.id === id) ?? null,
    [invitations, id]
  );

  const respond = useRespondInvitation();
  const remind = useRemindInvitation();
  const revoke = useRevokeInvitation();

  const [reply, setReply] = useState('');

  // Bij keyboard-show: scroll de hele content naar het einde zodat de
  // respondWrap (reply-veld + Ga/Misschien/Nee-knoppen) boven het
  // keyboard komt te staan. Eenvoudiger dan measureInWindow-rekenwerk
  // en werkt prima omdat de respondWrap onderaan de scrollview staat.
  const scrollRef = useRef<ScrollView>(null);
  useEffect(() => {
    const evtName =
      Platform.OS === 'ios' ? 'keyboardDidShow' : 'keyboardDidShow';
    const sub = Keyboard.addListener(evtName, () => {
      // Kleine vertraging zodat de KeyboardAvoidingView eerst z'n
      // padding kan zetten — anders scrollen we naar een nog-te-korte
      // contentSize.
      setTimeout(() => {
        scrollRef.current?.scrollToEnd({ animated: true });
      }, 50);
    });
    return () => sub.remove();
  }, []);

  if (!invitation) {
    return (
      <View
        style={[
          styles.root,
          styles.center,
          { backgroundColor: roles.bg },
        ]}
      >
        <Text style={[styles.errorText, { color: roles.fgMuted }]}>
          {t(
            'Deze uitnodiging is niet meer beschikbaar.',
            'This invitation is no longer available.'
          )}
        </Text>
        <Pressable onPress={() => safeBack()} style={{ paddingTop: 16 }}>
          <Text style={{ color: roles.accent, fontFamily: fontFamily.medium }}>
            {t('Terug', 'Back')}
          </Text>
        </Pressable>
      </View>
    );
  }

  const isOutgoing = invitation.isOutgoing;
  const isGroup = Boolean(invitation.group);
  const occStart = invitation.occurrence.startsAt;
  const occEnd = invitation.occurrence.endsAt;
  const d = new Date(occStart);
  const dow = dowMixed(d.getDay(), locale);
  const month = monthShort(d.getMonth(), locale).toLowerCase();
  const time = rowTimeLabel(occStart, occEnd, locale);
  const dateLabel = `${dow} ${d.getDate()} ${month} · ${time}`;

  // Eigen response + edit-state. Zodra je een keuze hebt gemaakt
  // (status !== 'pending'), verbergen we het reply-veld + de drie
  // knoppen en tonen we het antwoord met een potloodje. Het potlood
  // verdwijnt vanaf 24u voor het event start — kort daarvoor wordt het
  // antwoord beschouwd als definitief om laatste-minuut-flips te
  // ontmoedigen.
  const myResponse = invitation.responses.find((r) => r.user.id === myId);
  const myStatus = myResponse?.status ?? null;
  const hasAnswered = myStatus !== null && myStatus !== 'pending';
  const msUntilStart = new Date(occStart).getTime() - Date.now();
  const canEdit = msUntilStart > 24 * 60 * 60 * 1000;
  const [editing, setEditing] = useState(false);
  const showRespondForm = !hasAnswered || editing;

  // Groepeer responses per status. Initiator zit ook in responses
  // (default 'going') — die nemen we mee in de going-sectie.
  const groups: Record<InvitationStatus, ApiInvitationResponse[]> = {
    going: [],
    maybe: [],
    pending: [],
    not_going: [],
  };
  for (const r of invitation.responses) groups[r.status].push(r);

  const onRespond = (status: 'going' | 'maybe' | 'not_going') => {
    if (respond.isPending) return;
    // Haptic bij tap: notification voor going (success-feel),
    // impactAsync(Medium) voor maybe/nee — voelbaarder dan
    // selectionAsync (die op iOS soms helemaal niet voelt).
    if (status === 'going') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    respond.mutate({
      id: invitation.id,
      status,
      replyMessage: reply.trim() || undefined,
      eventId: invitation.event.id,
    });
    setReply('');
    setEditing(false);
    Keyboard.dismiss();
  };

  const onRemind = (userId: string) => {
    if (remind.isPending) return;
    remind.mutate({
      invitationId: invitation.id,
      userId,
      eventId: invitation.event.id,
    });
  };

  const onRevoke = () => {
    Alert.alert(
      t('Uitnodiging intrekken?', 'Withdraw invitation?'),
      t(
        'Niemand krijgt een melding hierover. De uitnodiging verdwijnt uit alle inboxen.',
        'Nobody will be notified. The invitation will disappear from all inboxes.'
      ),
      [
        { text: t('Annuleer', 'Cancel'), style: 'cancel' },
        {
          text: t('Intrekken', 'Withdraw'),
          style: 'destructive',
          onPress: () => {
            revoke.mutate(
              { id: invitation.id, eventId: invitation.event.id },
              {
                onSuccess: () => {
                  Haptics.notificationAsync(
                    Haptics.NotificationFeedbackType.Success
                  );
                  safeBack();
                },
              }
            );
          },
        },
      ]
    );
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.root, { backgroundColor: roles.bg }]}
      // iOS heeft een kleine status-bar offset nodig zodat de header
      // niet onder de notch schuift wanneer het keyboard opent.
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
    >
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <BackButton onPress={() => safeBack()} />
        <Text
          numberOfLines={1}
          style={[styles.title, { color: roles.fg }]}
        >
          {isGroup
            ? t(`Via ${invitation.group?.name}`, `Via ${invitation.group?.name}`)
            : t('Uitnodiging', 'Invitation')}
        </Text>
        {isOutgoing ? (
          <Pressable
            onPress={onRevoke}
            hitSlop={6}
            style={[
              styles.headerIcon,
              {
                backgroundColor: isNacht ? palette.noir2 : palette.paper2,
              },
            ]}
          >
            <Ionicons name="trash-outline" size={18} color={roles.fgMuted} />
          </Pressable>
        ) : (
          <View style={{ width: 40 }} />
        )}
      </View>

      <ScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        {/* Hele event-rij klikbaar — `onPress` prop van EventListRow
            gebruikt (niet een buitenste Pressable wrapper, want die
            wordt gevangen door de inner Pressable in de row). */}
        <EventListRow
          time={dateLabel}
          dateAbove
          thumb={
            eventImageUrl({
              imageUrl: invitation.event.imageUrl,
              venue: { imageUrl: null },
            }) ?? ''
          }
          title={invitation.event.title}
          venue=""
          tags={[
            {
              label: translateCategory(invitation.event.category, locale),
              tone: CATEGORY_TICK[invitation.event.category],
            },
            {
              label: invitation.event.venueName,
              tone: CATEGORY_TICK[invitation.event.category],
            },
          ]}
          tick={CATEGORY_TICK[invitation.event.category]}
          onPress={() =>
            router.push(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              `/event/${invitation.event.id}?o=${invitation.occurrence.id}` as any
            )
          }
        />

        {invitation.message && invitation.message.length > 0 && (
          <View
            style={[
              styles.messageWrap,
              { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
            ]}
          >
            <Text style={[styles.messageText, { color: roles.fgRead }]}>
              “{invitation.message}”
            </Text>
            <Text style={[styles.messageFrom, { color: roles.fgMuted }]}>
              — {invitation.from.name}
            </Text>
          </View>
        )}

        <StatusGroup
          label={t('Gaat', 'Going')}
          tone={roles.accent}
          responses={groups.going}
          myId={myId}
          renderRowExtra={null}
        />
        <StatusGroup
          label={t('Misschien', 'Maybe')}
          tone={roles.fgMuted}
          responses={groups.maybe}
          myId={myId}
          renderRowExtra={null}
        />
        <StatusGroup
          label={t('Nog niet gereageerd', 'Pending')}
          tone={roles.fgMuted}
          responses={groups.pending}
          myId={myId}
          renderRowExtra={(r) =>
            isOutgoing && r.user.id !== myId ? (
              <RemindButton
                disabled={Boolean(r.reminderSentAt) || remind.isPending}
                sent={Boolean(r.reminderSentAt)}
                onPress={() => onRemind(r.user.id)}
              />
            ) : null
          }
        />
        <StatusGroup
          label={t('Kan niet', 'Not coming')}
          tone={roles.fgPlaceholder}
          responses={groups.not_going}
          myId={myId}
          renderRowExtra={null}
        />

        {/* Eigen-antwoord-blok. Twee modes:
            1. Nog geen antwoord OF gebruiker tikt potlood → form (reply-
               veld + Ga/Misschien/Nee).
            2. Antwoord gegeven → samenvatting met optioneel potloodje
               (verdwijnt 24u vóór event-start). */}
        {!isOutgoing && (
          <View style={styles.respondWrap}>
            <Text style={[styles.respondLabel, { color: roles.fgMuted }]}>
              {t('Jouw antwoord', 'Your response')}
            </Text>
            {!showRespondForm && hasAnswered && myStatus && (
              <View
                style={[
                  styles.answerSummary,
                  {
                    borderColor: isNacht ? '#2a2a2d' : palette.paper,
                    backgroundColor: isNacht ? palette.noir2 : palette.paper2,
                  },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.answerStatus, { color: roles.fg }]}>
                    {myStatus === 'going'
                      ? t('Je gaat', 'You’re going')
                      : myStatus === 'maybe'
                        ? t('Je twijfelt nog', 'You’re unsure')
                        : t('Je gaat niet', 'You’re not coming')}
                  </Text>
                  {myResponse?.replyMessage ? (
                    <Text
                      numberOfLines={3}
                      style={[styles.answerReply, { color: roles.fgMuted }]}
                    >
                      “{myResponse.replyMessage}”
                    </Text>
                  ) : null}
                </View>
                {canEdit && (
                  <Pressable
                    onPress={() => {
                      setReply(myResponse?.replyMessage ?? '');
                      setEditing(true);
                    }}
                    hitSlop={8}
                    style={[
                      styles.editIcon,
                      { backgroundColor: isNacht ? palette.noir3 : palette.paper },
                    ]}
                    accessibilityLabel={t('Wijzig antwoord', 'Edit response')}
                  >
                    <Ionicons name="pencil" size={16} color={roles.fgMuted} />
                  </Pressable>
                )}
              </View>
            )}
            {showRespondForm && (
              <>
            <View
              style={[
                styles.replyField,
                {
                  borderColor: isNacht ? '#2a2a2d' : palette.paper,
                  backgroundColor: isNacht ? palette.noir2 : palette.paper2,
                },
              ]}
            >
              <TextInput
                value={reply}
                onChangeText={setReply}
                placeholder={t(
                  'kort antwoord (optioneel)',
                  'short reply (optional)'
                )}
                placeholderTextColor={roles.fgPlaceholder}
                multiline
                maxLength={280}
                style={[styles.replyInput, { color: roles.fg }]}
              />
            </View>
            <View style={styles.respondBtnRow}>
              <TouchableOpacity
                onPress={() => onRespond('going')}
                disabled={respond.isPending}
                activeOpacity={0.65}
                style={[
                  styles.respondBtn,
                  { backgroundColor: roles.accent },
                ]}
              >
                <Text
                  style={[styles.respondBtnText, { color: roles.onAccent }]}
                >
                  {t('Ga', 'Going')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => onRespond('maybe')}
                disabled={respond.isPending}
                activeOpacity={0.65}
                style={[
                  styles.respondBtn,
                  {
                    backgroundColor: isNacht ? palette.noir3 : palette.paper,
                  },
                ]}
              >
                <Text style={[styles.respondBtnText, { color: roles.fg }]}>
                  {t('Misschien', 'Maybe')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => onRespond('not_going')}
                disabled={respond.isPending}
                activeOpacity={0.65}
                style={[
                  styles.respondBtn,
                  {
                    backgroundColor: isNacht ? palette.noir3 : palette.paper,
                  },
                ]}
              >
                <Text
                  style={[styles.respondBtnText, { color: roles.fgMuted }]}
                >
                  {t('Nee', 'No')}
                </Text>
              </TouchableOpacity>
            </View>
              </>
            )}
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function StatusGroup({
  label,
  tone,
  responses,
  myId,
  renderRowExtra,
}: {
  label: string;
  tone: string;
  responses: ApiInvitationResponse[];
  myId: string | null;
  renderRowExtra: ((r: ApiInvitationResponse) => React.ReactNode) | null;
}) {
  const roles = useRoles();
  const t = useT();
  if (responses.length === 0) return null;
  return (
    <View style={styles.groupWrap}>
      <View style={styles.groupHead}>
        <Text style={[styles.groupLabel, { color: tone }]}>{label}</Text>
        <Text style={[styles.groupCount, { color: tone }]}>
          {responses.length}
        </Text>
      </View>
      {responses.map((r) => {
        const isMe = r.user.id === myId;
        return (
          <View
            key={r.user.id}
            style={[styles.respRow, { borderColor: roles.bgChip }]}
          >
            <ProfileAvatar
              avatarUrl={r.user.avatarUrl}
              name={r.user.name}
              size={36}
            />
            <View style={styles.respBody}>
              <Text
                numberOfLines={1}
                style={[styles.respName, { color: roles.fg }]}
              >
                {r.user.name}
                {isMe ? t(' (jij)', ' (you)') : ''}
              </Text>
              {r.replyMessage ? (
                <Text
                  numberOfLines={2}
                  style={[styles.respReply, { color: roles.fgMuted }]}
                >
                  “{r.replyMessage}”
                </Text>
              ) : r.user.handle ? (
                <Text
                  numberOfLines={1}
                  style={[styles.respHandle, { color: roles.fgMuted }]}
                >
                  @{r.user.handle}
                </Text>
              ) : null}
            </View>
            {renderRowExtra?.(r)}
          </View>
        );
      })}
    </View>
  );
}

function RemindButton({
  disabled,
  sent,
  onPress,
}: {
  disabled: boolean;
  sent: boolean;
  onPress: () => void;
}) {
  const roles = useRoles();
  const t = useT();
  return (
    <Pressable
      onPress={(e) => {
        e.stopPropagation();
        if (!disabled) onPress();
      }}
      disabled={disabled}
      style={[
        styles.remindPill,
        { borderColor: sent ? `${roles.fgMuted}80` : `${roles.accent}80` },
      ]}
    >
      <Text
        style={[
          styles.remindPillText,
          { color: sent ? roles.fgMuted : roles.accent },
        ]}
      >
        {sent ? t('Herinnerd', 'Reminded') : t('Herinner', 'Remind')}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  errorText: { fontFamily: fontFamily.body, fontSize: 14 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingBottom: 12,
    gap: 8,
  },
  title: {
    flex: 1,
    fontFamily: fontFamily.bold,
    fontSize: 18,
    letterSpacing: -0.36,
    textAlign: 'center',
  },
  headerIcon: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },

  kickerWrap: {
    paddingHorizontal: 22,
    paddingTop: 10,
    paddingBottom: 6,
    gap: 2,
  },
  kicker: {
    fontFamily: fontFamily.mono,
    fontSize: 9.5,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  viaGroup: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    letterSpacing: -0.1,
  },

  messageWrap: {
    marginHorizontal: 22,
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    gap: 6,
  },
  messageText: {
    fontFamily: fontFamily.body,
    fontSize: 14.5,
    lineHeight: 19,
  },
  messageFrom: {
    fontFamily: fontFamily.mono,
    fontSize: 9.5,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },

  groupWrap: {
    paddingTop: 22,
  },
  groupHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingBottom: 8,
  },
  // Sectie-titel matcht de "Leden"-stijl op /group/[id] en andere
  // section heads in de app — display, 18px, lichte negative letter-
  // spacing. Per-status tone gekleurd (going accent, etc.).
  groupLabel: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.36,
  },
  // Aantal rechts-uitgelijnd in dezelfde tone als de label — laat de
  // counts onder elkaar uitlijnen tussen secties.
  groupCount: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.36,
  },
  respRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  respBody: { flex: 1, minWidth: 0 },
  respName: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    letterSpacing: -0.22,
  },
  respReply: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 17,
    marginTop: 2,
  },
  respHandle: {
    fontFamily: fontFamily.mono,
    fontSize: 9.5,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginTop: 4,
  },
  remindPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  remindPillText: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 9,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },

  respondWrap: {
    paddingHorizontal: 22,
    paddingTop: 28,
    gap: 12,
  },
  respondLabel: {
    fontFamily: fontFamily.mono,
    fontSize: 9.5,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  // Samenvatting na gemaakte keuze. Zelfde card-look als het reply-veld
  // zodat het bij elkaar past, met een potlood-knop rechts voor edit.
  answerSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderRadius: 12,
  },
  answerStatus: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    letterSpacing: -0.22,
  },
  answerReply: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
  editIcon: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  replyField: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderRadius: 12,
    minHeight: 70,
  },
  replyInput: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 19,
    padding: 0,
    minHeight: 46,
    textAlignVertical: 'top',
  },
  respondBtnRow: {
    flexDirection: 'row',
    gap: 8,
  },
  respondBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  respondBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.07,
  },
});

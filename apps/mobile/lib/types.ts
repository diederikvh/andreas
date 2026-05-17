/**
 * Gedeelde shared types voor de mobile-app — categorie-tone-keys en
 * friend-shape voor de friends-pill. Eerder leefden die in mocks/,
 * maar er hangt geen mock-data meer aan; dus permanent hier.
 */

export type BadgeTone = 'acid' | 'flare' | 'plum' | 'azure' | 'saffron' | 'cobalt';

export type Friend = {
  name: string;
  avatar: string | null;
};

import { Redirect } from 'expo-router';

/**
 * Landing voor `andreas://spotify-import`. Normaal vangt het inlogvenster
 * die terugsprong zelf af (zie `SpotifyImport` in artiesten.tsx), maar op
 * Android kan hij als gewone link binnenkomen. Dan niet op "pagina niet
 * gevonden" landen, maar bij je artiesten.
 */
export default function SpotifyImportLanding() {
  return <Redirect href={'/artiesten' as never} />;
}

import { getShareExtensionKey } from 'expo-share-intent';

/**
 * Deeplinks die niet van ons komen omleiden voordat expo-router ze als
 * route probeert te lezen.
 *
 * De iOS-share-extension opent de app met `andreas://dataUrl=<key>...`.
 * Dat is geen route — zonder deze redirect belandt een gedeelde poster op
 * een 404 in plaats van op het importscherm. Op Android komt de share via
 * een intent binnen en niet via een URL; daar doet deze hook niets en
 * pakt `<ShareImportCapture />` het op.
 *
 * Alle andere paden (universal links naar /e, /v, /u, /i) gaan
 * onveranderd door.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (path.includes(`dataUrl=${getShareExtensionKey()}`)) return '/import';
    return path;
  } catch {
    return path;
  }
}

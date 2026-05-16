import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * Server-side font loading voor Satori. We hergebruiken Archivo uit
 * `@expo-google-fonts/archivo` zodat IG-posts dezelfde typografie hebben
 * als de app. TTF wordt één keer in-memory geladen bij module-init.
 */

const require = createRequire(import.meta.url);

function loadTtf(spec: string): Buffer {
  return readFileSync(require.resolve(spec));
}

const archivoBody = loadTtf(
  '@expo-google-fonts/archivo/400Regular/Archivo_400Regular.ttf'
);
const archivoMedium = loadTtf(
  '@expo-google-fonts/archivo/500Medium/Archivo_500Medium.ttf'
);
const archivoBold = loadTtf(
  '@expo-google-fonts/archivo/700Bold/Archivo_700Bold.ttf'
);
const archivoBlack = loadTtf(
  '@expo-google-fonts/archivo/900Black/Archivo_900Black.ttf'
);

export const satoriFonts = [
  { name: 'Archivo', data: archivoBody, weight: 400, style: 'normal' },
  { name: 'Archivo', data: archivoMedium, weight: 500, style: 'normal' },
  { name: 'Archivo', data: archivoBold, weight: 700, style: 'normal' },
  { name: 'Archivo', data: archivoBlack, weight: 900, style: 'normal' },
] as const;

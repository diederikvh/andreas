import { spawn } from 'node:child_process';
import { mkdtemp, readFile, unlink, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Render een Remotion-compositie via subprocess. We gebruiken de
 * `remotion render` CLI uit `apps/video-gen` zodat alle bundling/
 * dependencies daar geïsoleerd blijven. Vereist een lokale draaiende
 * API (Remotion render gebruikt headless Chromium en kan dus NIET op
 * Fly draaien — verwacht een dev-machine).
 *
 * Returns: een Buffer met de MP4-content (geheugen, niet op disk).
 */
export async function renderVideo(options: {
  compositionId: string;
  props: unknown;
  /** Override pad naar de monorepo-root; default = vier directories omhoog. */
  repoRoot?: string;
}): Promise<Buffer> {
  // apps/api/dist/social/render-video.js → repo root = ../../../..
  const repoRoot =
    options.repoRoot ??
    resolve(import.meta.dirname ?? process.cwd(), '..', '..', '..', '..');

  const tmpDir = await mkdtemp(join(tmpdir(), 'andreas-render-'));
  const propsPath = join(tmpDir, 'props.json');
  const outPath = join(tmpDir, 'out.mp4');

  await writeFile(propsPath, JSON.stringify(options.props));

  // CLI: `remotion render src/index.ts <id> <out> --props=<file>`
  const videoGenDir = resolve(repoRoot, 'apps', 'video-gen');
  const args = [
    'exec',
    '--',
    'remotion',
    'render',
    'src/index.ts',
    options.compositionId,
    outPath,
    `--props=${propsPath}`,
    '--log=error',
  ];

  console.log(
    `[render-video] pnpm ${args.join(' ')} (cwd=${videoGenDir})`,
  );

  await new Promise<void>((resolveP, reject) => {
    const child = spawn('pnpm', args, {
      cwd: videoGenDir,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolveP();
      else reject(new Error(`remotion render exited with code ${code}`));
    });
  });

  const buf = await readFile(outPath);

  // Opruimen — render-output kan tientallen MB zijn.
  await Promise.allSettled([
    unlink(propsPath),
    unlink(outPath),
  ]);
  await rmdir(tmpDir).catch(() => {});

  return buf;
}

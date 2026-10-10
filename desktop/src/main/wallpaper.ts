// The user's own picture for the home page: chosen once, kept as a copy in the app's data.
import { dialog, nativeImage, type BaseWindow } from 'electron';
import fs from 'node:fs';

import { dataPath } from './store';

const file = () => dataPath('wallpaper.jpg');
/** Wide enough for a large screen; a bigger picture would only make new tabs slower. */
const MAX_WIDTH = 2560;

let cached: { stamp: number; url: string } | null = null;

/** Lets the user pick a picture. Returns false when they cancelled or it could not be read. */
export async function chooseWallpaper(window: BaseWindow): Promise<boolean> {
  const result = await dialog.showOpenDialog(window, {
    title: 'Choose a picture for the home page',
    properties: ['openFile'],
    filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  });
  const chosen = result.filePaths[0];
  if (result.canceled || !chosen) return false;
  let image = nativeImage.createFromPath(chosen);
  if (image.isEmpty()) return false;
  if (image.getSize().width > MAX_WIDTH) image = image.resize({ width: MAX_WIDTH, quality: 'best' });
  await fs.promises.mkdir(dataPath(), { recursive: true });
  await fs.promises.writeFile(file(), image.toJPEG(84));
  cached = null;
  return true;
}

/** The picture as a data: URL, or null when there is none. */
export async function wallpaperImage(): Promise<string | null> {
  try {
    const stamp = (await fs.promises.stat(file())).mtimeMs;
    if (cached?.stamp !== stamp) {
      cached = { stamp, url: `data:image/jpeg;base64,${(await fs.promises.readFile(file())).toString('base64')}` };
    }
    return cached.url;
  } catch {
    return null;
  }
}

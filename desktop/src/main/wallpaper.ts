// The user's own picture for the home page: chosen once, kept as a copy in the app's data.
import { dialog, nativeImage, type BaseWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PhotoWallpaper } from '../shared/types';
import { dataPath, jsonFile, resourcePath } from './store';

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

let photos: PhotoWallpaper[] | null = null;

/**
 * The photos that ship with the app (resources/wallpapers), with who took each one. They
 * are used under the Unsplash License; credits.json records where each was checked.
 */
export function photoWallpapers(): PhotoWallpaper[] {
  if (photos) return photos;
  const dir = resourcePath('wallpapers', 'resources/wallpapers');
  try {
    const credits = JSON.parse(fs.readFileSync(path.join(dir, 'credits.json'), 'utf8')) as { source: string; photos: { id: string; title: string; author: string; page: string }[] };
    photos = credits.photos
      .filter((photo) => fs.existsSync(path.join(dir, `${photo.id}.jpg`)))
      .map((photo) => ({
        ...photo,
        source: credits.source,
        url: pathToFileURL(path.join(dir, `${photo.id}.jpg`)).href,
        thumb: pathToFileURL(path.join(dir, 'thumbs', `${photo.id}.jpg`)).href,
      }));
  } catch {
    photos = [];
  }
  return photos;
}

let photoOfTheRun: number | null = null;

/**
 * Which photo the home page shows when photos take turns: one for each time the app is
 * opened, never the one from last time.
 */
export function shuffledPhoto(): number {
  if (photoOfTheRun !== null) return photoOfTheRun;
  const count = photoWallpapers().length;
  const state = jsonFile<{ last: number }>('wallpaper-turn.json', { last: -1 });
  let index = count > 0 ? Math.floor(Math.random() * count) : 0;
  if (count > 1 && index === state.value.last) index = (index + 1) % count;
  state.value = { last: index };
  state.changed();
  photoOfTheRun = index;
  return index;
}

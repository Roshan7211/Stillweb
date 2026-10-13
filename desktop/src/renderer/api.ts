import type { ChromeApi, ChromeEvents } from '../shared/types';

type Bridge = ChromeApi & {
  /** Listens for a message from the main process; returns a function that stops listening. */
  on<K extends keyof ChromeEvents>(channel: K, listener: (payload: ChromeEvents[K]) => void): () => void;
};

declare global {
  interface Window {
    stillweb: Bridge;
  }
}

export const api = window.stillweb;

// js/storage.js keeps the paused round (its snapshot) and its other records in
// `localStorage`: on the engine that is this shim over the device's
// starhermit:storage, installed before js/storage.js is evaluated (main.ts
// imports this module first). Progress, achievements and the local boards
// are the game's save instead (platform.ts).
import { storage } from "starhermit:storage";

const shim = {
  getItem(key: string): string | null {
    try { return storage.getText(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    storage.set(key, String(value));
  },
  removeItem(key: string): void {
    try { storage.remove(key); } catch { /* gone */ }
  },
};
(globalThis as unknown as { localStorage: typeof shim }).localStorage = shim;
export {};

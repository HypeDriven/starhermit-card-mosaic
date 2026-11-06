// js/storage.js keeps the paused round (its snapshot) and its other records in
// `localStorage`: on the engine that is the engine's, over the device's
// starhermit:storage, installed before js/storage.js is evaluated (main.ts
// imports this module first). Progress, achievements and the local boards
// are the game's save instead (platform.ts).
import { installLocalStorage } from "starhermit:storage";

installLocalStorage();

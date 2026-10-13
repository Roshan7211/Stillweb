// Preload script for every frame of every page (registered per session in main/shields.ts).
// It runs in an isolated world: the page cannot see or change anything defined here. The
// cosmetic scripts are the ones the mobile apps inject; the order of these imports matters.
import './frameStart';
import '../../../native/shield-webview/web/shieldjs/cosmetic-host.js';
import '../../../native/shield-webview/web/shieldjs/cosmetic-generic.js';

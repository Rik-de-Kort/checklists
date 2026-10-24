import { init } from './ui.js';

init();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './styles/theme.css';
import { hasBridge } from './api/bridge';
import { installBrowserZoomGuard } from './lib/browserZoom';

// The browser remote client should not have Ctrl/Cmd +/- resize the office; the Electron window
// keeps the normal browser-like behaviour. See lib/browserZoom.js.
if (!hasBridge()) installBrowserZoomGuard();

createApp(App).use(createPinia()).mount('#app');

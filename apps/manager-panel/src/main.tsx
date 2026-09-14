import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { Gallery } from './gallery.js';
import { browserEnvironment, browserStorage, readPreferences } from './preferences.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Panel root is missing');
}

// The component workbench. Not a destination, not in the navigation, and not
// behind the session, because it renders nothing real - it exists so that a
// primitive can be looked at in both themes and at both widths before a page
// is built out of it.
const gallery = window.location.hash === '#gallery';
if (gallery) {
  const { theme, locale } = readPreferences(browserStorage(), browserEnvironment());
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.lang = locale;
}

createRoot(root).render(
  <StrictMode>{gallery ? <Gallery /> : <App />}</StrictMode>,
);

/**
 * The page's translator (Electron window or Capacitor WebView). Its language
 * is owned by TranslationProvider (react/contexts/TranslationContext.tsx),
 * which reads and persists it over window.api; code outside the hook tree —
 * ErrorBoundary, Modal, the deadline notifier — translates through this same
 * instance so it always matches the provider.
 */

import { createTranslator } from './translator';

export const rendererTranslator = createTranslator();

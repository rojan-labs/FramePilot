import { createLogger } from '@framepilot/shared-types';
import { registerDeferredDesktopServices } from './ipc/deferred-services.js';
import { installScopedConsoleRouter } from './scoped-console.js';

// Route the legacy composition root's remaining bare console calls through the shared
// logger. New desktop modules use createLogger directly.
installScopedConsoleRouter(console, createLogger('desktop:console'));

// Register lightweight channel stubs before the lifecycle module creates the window.
// The filesystem/schema-heavy implementations load only when those features are used.
registerDeferredDesktopServices();

await import('./main.js');

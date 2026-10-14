import { WebUIServer } from './server.js';

// Standalone entry for `npm run web` and dist/web/server.js. It lives here
// rather than at the bottom of server.ts: esbuild inlines server.ts into other
// entries (dist/setup.js), where an "am I the entry point?" check compares the
// bundle's own import.meta.url and starts a second wizard next to the one the
// entry starts.
const port = parseInt(process.env.PORT || '3000');
const server = new WebUIServer(port);
server.start();

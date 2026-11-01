// `npm test` runs under this: `import ... from 'electron'` resolves to fake-electron/index.mjs,
// so src/main.js runs in plain node, with no Chromium, and its wiring can be asserted.
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);

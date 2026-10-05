/**
 * Entry point. Everything else lives in src/engine (foundation-web) and src/modules/<name> (module owners).
 * `/?view=game` runs every module; `/?view=<module>` is that module's gallery (see docs/ENGINE.md).
 */
import '@fontsource-variable/fredoka';
import '@fontsource-variable/nunito';
import { Engine } from './engine/Engine';

Engine.boot().catch((e) => {
  // Engine.boot already painted the fatal screen and logged; keep the rejection visible to tools.
  console.error('[main] boot failed', e);
});

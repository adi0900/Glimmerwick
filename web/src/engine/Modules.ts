/**
 * Module auto-discovery: every `web/src/modules/<name>/index.ts` default-exports a `GameModule`.
 * No registry file to edit -- `import.meta.glob` finds new folders (Vite reloads when one is added).
 *
 * Views:  `game` = every module · `<name>` = that module + its transitive `needs`
 * Extra URL params: `with=a,b` adds modules to any view · `without=a,b` removes them (incl. dependencies' own).
 * Order: ascending `order` (default 100), then name, never before the modules it `needs`.
 */
import type { GameModule, ViewInfo } from './types';

const loaders = import.meta.glob('../modules/*/index.ts') as Record<string, () => Promise<{ default: GameModule }>>;

const NAME_RE = /\/modules\/([^/]+)\/index\.ts$/;

export function availableModules(): string[] {
  return Object.keys(loaders)
    .map((p) => NAME_RE.exec(p)?.[1] ?? '')
    .filter(Boolean)
    .sort();
}

export interface LoadedModules {
  list: GameModule[];
  /** modules that could not be loaded (import error / missing dependency) */
  failed: { name: string; error: string }[];
}

async function loadOne(name: string): Promise<GameModule> {
  const key = Object.keys(loaders).find((p) => NAME_RE.exec(p)?.[1] === name);
  if (!key) throw new Error(`no such module "${name}" (available: ${availableModules().join(', ') || 'none'})`);
  const mod = await loaders[key]!();
  const m = mod.default;
  if (!m || typeof m.init !== 'function') throw new Error(`modules/${name}/index.ts must default-export a GameModule with init()`);
  if (m.name !== name) console.warn(`[modules] modules/${name}/index.ts declares name "${m.name}" (folder name wins for lookups)`);
  return m;
}

export async function resolveModules(view: ViewInfo): Promise<LoadedModules> {
  const params = view.params;
  const csv = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const without = new Set(csv(params.without));
  const roots = view.isGame ? availableModules() : [view.name];
  for (const w of csv(params.with)) if (!roots.includes(w)) roots.push(w);

  const loaded = new Map<string, GameModule>();
  const failed: { name: string; error: string }[] = [];
  const visiting = new Set<string>();

  const visit = async (name: string, chain: string[]): Promise<void> => {
    if (loaded.has(name) || without.has(name)) return;
    if (visiting.has(name)) throw new Error(`module dependency cycle: ${[...chain, name].join(' -> ')}`);
    visiting.add(name);
    try {
      const m = await loadOne(name);
      for (const dep of m.needs ?? []) await visit(dep, [...chain, name]);
      loaded.set(name, m);
    } catch (e) {
      // the requested view itself must exist; for everything else keep going and report
      if (!view.isGame && name === view.name && !loaded.size && chain.length === 0) throw e;
      failed.push({ name, error: e instanceof Error ? e.message : String(e) });
    } finally {
      visiting.delete(name);
    }
  };
  for (const r of roots) await visit(r, []);

  // stable topological order by (order, name)
  const remaining = new Map(loaded);
  const placed = new Set<string>();
  const list: GameModule[] = [];
  const key = (m: GameModule) => [m.order ?? 100, m.name] as const;
  while (remaining.size) {
    const ready = [...remaining.values()]
      .filter((m) => (m.needs ?? []).every((d) => placed.has(d) || without.has(d) || !loaded.has(d)))
      .sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1].localeCompare(key(b)[1]));
    const next = ready[0] ?? [...remaining.values()][0]!;
    remaining.delete(next.name);
    placed.add(next.name);
    list.push(next);
  }
  return { list, failed };
}

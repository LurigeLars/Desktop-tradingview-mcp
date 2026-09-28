import { z } from 'zod';
import { jsonResult } from './_format.js';
import { applyWatchManifest } from '../core/watch-manifest.js';
import { withTopologyMutationLock } from '../core/topology-lock.js';

const studySchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    inputs: z.record(z.string(), z.unknown()).optional(),
  }),
]);

const extraEntrySchema = z.object({
  handle: z.string().optional(),
  symbol: z.string(),
  timeframe: z.string(),
  studies: z.array(studySchema).optional(),
  groups: z.array(z.string()).optional(),
});

export function registerWatchManifestTools(server) {
  server.registerTool('watch_manifest_apply', {
    description: 'Load the canonical market-watch manifest and reconcile its selected themes into the logical resident worker universe. Optional dynamic entries are bounded and tagged separately.',
    inputSchema: {
      themes: z.array(z.string()).optional().describe('Optional named manifest themes. Omit to use the manifest defaults.'),
      extra_entries: z.array(extraEntrySchema).max(12).optional().describe('Optional current trade/WATCH entries to add without editing the manifest.'),
      dry_run: z.coerce.boolean().optional().describe('Preview the compiled universe without changing worker state.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    try {
      if (args?.dry_run) return jsonResult(applyWatchManifest(args));
      return jsonResult(await withTopologyMutationLock('watch_manifest_apply', () => applyWatchManifest(args)));
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}

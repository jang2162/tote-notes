/** Run by `pnpm build` after `vite build`: fails when the bundle has lost the names of the
 * functions the editor keys run. The shortcut settings name an editor key after its function
 * (`editorBindings` in src/shortcuts/keys.ts), which a minifier renames unless `keepNames` is on
 * (vite.config.ts): `selectLine` would read `Qp`. */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "../dist/assets");

const named = readdirSync(ASSETS)
  .filter((file) => file.endsWith(".js"))
  .some((file) => /\bselectLine=/.test(readFileSync(join(ASSETS, file), "utf8")));
if (!named) {
  console.error(
    "dist/assets: no `selectLine=`. The editor's function names were minified away; " +
      "the shortcut settings would name editor keys wrongly. Is `keepNames` still in vite.config.ts?",
  );
  process.exit(1);
}

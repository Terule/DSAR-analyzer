import fs from "node:fs";
import path from "node:path";

const targetPath = path.join(
  process.cwd(),
  "node_modules",
  "openai",
  "src",
  "tsconfig.json",
);

try {
  if (!fs.existsSync(targetPath)) {
    console.log("[patch-openai-tsconfig] target not found, skipping.");
    process.exit(0);
  }

  const raw = fs.readFileSync(targetPath, "utf-8");
  let patched = raw;

  if (patched.includes('"ignoreDeprecations"')) {
    patched = patched.replace(
      /"ignoreDeprecations"\s*:\s*"[^"]+"/,
      '"ignoreDeprecations": "5.0"',
    );
  } else {
    patched = patched.replace(
      '"moduleResolution": "node"',
      '"moduleResolution": "node",\n    "ignoreDeprecations": "5.0"',
    );
  }

  if (patched === raw) {
    console.log("[patch-openai-tsconfig] expected token not found, skipping.");
    process.exit(0);
  }

  fs.writeFileSync(targetPath, patched);
  console.log("[patch-openai-tsconfig] patched openai/src/tsconfig.json");
} catch (err) {
  console.warn("[patch-openai-tsconfig] failed:", err);
  process.exit(0);
}

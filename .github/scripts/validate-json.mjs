import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse, printParseErrorCode } from "jsonc-parser";

const tracked = execFileSync("git", ["ls-files", "*.json", "*.jsonc"], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

if (tracked.length === 0) {
  console.log("No JSON files to validate.");
  process.exit(0);
}

let failed = 0;
for (const file of tracked) {
  const src = readFileSync(file, "utf8");
  if (file.endsWith(".jsonc")) {
    const errors = [];
    parse(src, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length > 0) {
      console.log(`FAIL ${file}`);
      for (const err of errors) {
        const code = printParseErrorCode(err.error);
        console.log(`     ${code} at offset ${err.offset} (length ${err.length})`);
      }
      failed = 1;
    } else {
      console.log(`ok   ${file}`);
    }
  } else {
    try {
      JSON.parse(src);
      console.log(`ok   ${file}`);
    } catch (err) {
      console.log(`FAIL ${file}`);
      console.log(`     ${err.message}`);
      failed = 1;
    }
  }
}

process.exit(failed);

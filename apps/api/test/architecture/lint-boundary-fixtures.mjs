// Imported explicitly rather than relied on as a global: this file is linted with the same
// browser-agnostic configuration as the rest of the API, which declares no Node globals.
import process from "node:process";
import { ESLint } from "eslint";

/**
 * Lints synthetic module-boundary fixtures with the API's real ESLint configuration and prints
 * the `no-restricted-imports` messages for each as JSON.
 *
 * It is a separate ES module, run as a child process, for one mechanical reason: the flat
 * config is an `.mjs` file and ESLint loads it with a dynamic `import()`, which Jest's CommonJS
 * module registry refuses. Rather than weaken the test to a hand-rolled copy of the rules — the
 * exact thing that would make the check vacuous — the real loader runs where dynamic import
 * works, and the test reads its answer.
 *
 * Nothing is written to disk. `lintText` resolves configuration from the file path it is given,
 * so a path is all the fixtures need.
 */
const input = JSON.parse(await readStdin());
const eslint = new ESLint({ cwd: process.cwd() });
const output = [];

for (const fixture of input) {
  const [result] = await eslint.lintText(fixture.code, {
    filePath: fixture.filePath,
  });

  output.push({
    filePath: fixture.filePath,
    messages: (result?.messages ?? [])
      .filter((message) => message.ruleId === "no-restricted-imports")
      .map((message) => message.message),
  });
}

process.stdout.write(JSON.stringify(output));

function readStdin() {
  return new Promise((resolve, reject) => {
    let buffer = "";

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
    });
    process.stdin.on("end", () => resolve(buffer));
    process.stdin.on("error", reject);
  });
}

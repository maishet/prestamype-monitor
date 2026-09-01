/* global process, Buffer */
import { writeFileSync } from "node:fs";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString("utf8");
writeFileSync(
  process.env.FAKE_HELPER_INPUT,
  JSON.stringify({ argv: process.argv.slice(2), input }),
);
process.stdout.write("x".repeat(150_000));
process.stderr.write("y".repeat(150_000));
process.exitCode = Number(process.env.FAKE_HELPER_EXIT ?? "0");

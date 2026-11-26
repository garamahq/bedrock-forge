import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  escapeSedLiteralPattern,
  escapeSedLiteralReplacement,
  detectContentDirectory,
  replaceLiteralUrlInFiles,
  runSerializedDbSearchReplace,
} from "./url-replace.utils";

describe("url-replace.utils (#19, #54, #60, #111, #112)", () => {
  describe("escapeSedLiteralPattern & escapeSedLiteralReplacement with real GNU sed (#54, #112)", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "bf-sed-test-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("replaces exact URL literally without matching dot wildcards or expanding & in replacement", () => {
      const sampleFile = join(dir, "sample.css");
      const initial = [
        "background: url('https://old.test/wp-content/a.png');",
        "other: url('https://oldXtest/wp-content/keep.png');",
        "literal_regex_chars: 'https://old[1].test/*$';",
      ].join("\n");
      writeFileSync(sampleFile, initial, "utf8");

      const pat = escapeSedLiteralPattern("https://old.test");
      const rep = escapeSedLiteralReplacement("https://new.test/?a=1&b=2");
      execFileSync("sed", ["-i", `s|${pat}|${rep}|g`, sampleFile]);

      const updated = readFileSync(sampleFile, "utf8");
      expect(updated).toContain(
        "background: url('https://new.test/?a=1&b=2/wp-content/a.png');",
      );
      // Dot in old.test MUST NOT match oldXtest
      expect(updated).toContain(
        "other: url('https://oldXtest/wp-content/keep.png');",
      );
      expect(updated).toContain(
        "literal_regex_chars: 'https://old[1].test/*$';",
      );
    });
  });

  describe("detectContentDirectory (#54, #112)", () => {
    it("detects web/app on Bedrock layouts and falls back to wp-content on standard WordPress", async () => {
      const bedrockExec = {
        execute: jest.fn().mockImplementation(async (cmd: string) => ({
          code: 0,
          stdout: cmd.includes("web/app") ? "ok" : "missing",
          stderr: "",
        })),
      } as any;
      expect(await detectContentDirectory(bedrockExec, "/var/www/site")).toBe(
        "/var/www/site/web/app",
      );

      const standardExec = {
        execute: jest.fn().mockImplementation(async (cmd: string) => ({
          code: 0,
          stdout: cmd.includes("wp-content") ? "ok" : "missing",
          stderr: "",
        })),
      } as any;
      expect(await detectContentDirectory(standardExec, "/var/www/site")).toBe(
        "/var/www/site/wp-content",
      );
    });
  });

  describe("replaceLiteralUrlInFiles (#54, #112)", () => {
    it("throws when sed exits non-zero and never silently ignores file permission failures", async () => {
      const executor = {
        execute: jest.fn().mockImplementation(async (cmd: string) => {
          if (cmd.includes("test -d")) {
            return { code: 0, stdout: "ok", stderr: "" };
          }
          if (cmd.includes("sed -i")) {
            return {
              code: 4,
              stdout: "",
              stderr: "sed: couldn't open temporary file: Permission denied",
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        }),
      } as any;

      await expect(
        replaceLiteralUrlInFiles(
          executor,
          "/var/www/site/web/app",
          "https://old.test",
          "https://new.test",
        ),
      ).rejects.toThrow(/Permission denied|exit 4/i);
    });

    it("fails when real read-only file/dir cannot be updated in local integration check", async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), "bf-files-"));
      try {
        const roFile = join(tmpRoot, "style.css");
        writeFileSync(roFile, "a { src: 'https://old.test/x.css'; }\n", "utf8");
        chmodSync(roFile, 0o444);
        chmodSync(tmpRoot, 0o555);

        const localExec = {
          execute: jest.fn().mockImplementation(async (cmd: string) => {
            try {
              const out = execFileSync("bash", ["-c", cmd], {
                encoding: "utf8",
              });
              return { code: 0, stdout: out, stderr: "" };
            } catch (e: any) {
              return {
                code: typeof e.status === "number" ? e.status : 1,
                stdout: e.stdout?.toString?.() ?? "",
                stderr: e.stderr?.toString?.() ?? e.message,
              };
            }
          }),
        } as any;

        await expect(
          replaceLiteralUrlInFiles(
            localExec,
            tmpRoot,
            "https://old.test",
            "https://new.test",
          ),
        ).rejects.toThrow();
      } finally {
        chmodSync(tmpRoot, 0o755);
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  describe("runSerializedDbSearchReplace (#19, #60, #111)", () => {
    it("runs search-replace.php cleanly and fails without SQL fallback on errors or non-zero exit", async () => {
      const executor = {
        pushFile: jest.fn().mockResolvedValue(undefined),
        execute: jest.fn().mockImplementation(async (cmd: string) => {
          if (cmd.includes("information_schema.tables")) {
            return { code: 0, stdout: "wp_", stderr: "" };
          }
          if (cmd.includes("php ") && cmd.includes("search")) {
            return {
              code: 1,
              stdout: JSON.stringify({
                tables_scanned: 10,
                rows_affected: 4,
                errors: ["UPDATE batch on wp_postmeta failed"],
              }),
              stderr: "mysql batch error",
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        }),
      } as any;

      await expect(
        runSerializedDbSearchReplace({
          executor,
          creds: {
            dbHost: "localhost",
            dbUser: "u",
            dbPassword: "p",
          },
          dbName: "db",
          sourceUrl: "https://old.test",
          targetUrl: "https://new.test",
          jobId: "j1",
          tmpTag: "test",
          scriptsDir: join(__dirname, "../../scripts"),
        }),
      ).rejects.toThrow(/wp_postmeta failed|errors/i);

      // Must never push or run raw SQL UPDATE REPLACE statement fallback
      expect(
        executor.execute.mock.calls.some(
          ([cmd]: [string]) =>
            cmd.includes("UPDATE") && cmd.includes("REPLACE("),
        ),
      ).toBe(false);
    });
  });
});

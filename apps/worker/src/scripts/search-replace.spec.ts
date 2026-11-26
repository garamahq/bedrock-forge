import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT_PATH = join(__dirname, "../../scripts/search-replace.php");

function isPhpCliAvailable(): boolean {
  try {
    execFileSync("php", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("search-replace.php contract (#60, #64)", () => {
  const phpSource = readFileSync(SCRIPT_PATH, "utf8");

  it("never casts objects through (object) (array) into stdClass and uses serialized stream rewriting (#64)", () => {
    expect(phpSource).not.toContain("return (object) sr_deep_replace((array)");
    expect(phpSource).toContain("sr_rewrite_serialized");
    expect(phpSource).toContain("allowed_classes");
    expect(phpSource).toContain("skipped_serialized");
  });

  it("checks keyless UPDATE outcomes and exits non-zero whenever errors exist (#60)", () => {
    expect(phpSource).toContain("exit(!empty($errors) ? 1 : 0)");
    expect(phpSource).toContain("ROW_COUNT()");
    // Must not unconditionally return exit(0) after errors
    expect(phpSource).not.toMatch(/exit\(\s*0\s*\)\s*;?\s*$/);
  });

  if (isPhpCliAvailable()) {
    it("preserves custom PHP class names, private visibility, and recalculated byte lengths under real PHP CLI (#64)", () => {
      const code = `
        define('SEARCH_REPLACE_LIB_ONLY', true);
        require ${JSON.stringify(SCRIPT_PATH)};
        $payload = 'O:17:"Plugin_Custom_Cfg":3:{s:3:"url";s:16:"https://old.test";s:23:"\\0Plugin_Custom_Cfg\\0priv";s:21:"https://old.test/path";s:8:"*\\0prot";a:1:{i:0;s:20:"https://old.test/one";}}';
        [$out, $changed, $skipped] = sr_replace_value($payload, 'https://old.test', 'https://longer-new-domain.test');
        echo json_encode(['out' => $out, 'changed' => $changed, 'skipped' => $skipped]);
      `;
      const raw = execFileSync("php", ["-r", code], { encoding: "utf8" });
      const parsed = JSON.parse(raw) as { out: string; changed: boolean; skipped: number };
      expect(parsed.changed).toBe(true);
      expect(parsed.skipped).toBe(0);
      expect(parsed.out).toContain('O:17:"Plugin_Custom_Cfg":3:');
      expect(parsed.out).toContain('s:28:"https://longer-new-domain.test"');
      expect(parsed.out).not.toContain('stdClass');
    });
  }
});

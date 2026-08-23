/// <reference types="jest" />

import { execFileSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const wpUsersScript = resolve(__dirname, "../../scripts/wp-users.php");

describe("wp-users.php script", () => {
  it("extracts users via WP-CLI fallback and normalizes field case correctly", () => {
    const root = mkdtempSync(join(tmpdir(), "bf-wp-users-test-"));
    const docroot = join(root, "site");
    const binDir = join(root, "bin");
    mkdirSync(join(docroot, "wp-includes"), { recursive: true });
    mkdirSync(binDir, { recursive: true });

    // Mock wp-includes/version.php
    writeFileSync(
      join(docroot, "wp-includes/version.php"),
      "<?php $wp_version = '6.5';",
    );

    // Mock wp binary returning upper/mixed case JSON
    const fakeWp = join(binDir, "wp");
    const mockUsersJson = JSON.stringify([
      {
        ID: "3",
        USER_LOGIN: "admin",
        USER_EMAIL: "admin@example.com",
        DISPLAY_NAME: "Site Admin",
        USER_REGISTERED: "2026-01-01 12:00:00",
        ROLES: "administrator",
      },
      {
        id: 8,
        user_login: "editor1",
        user_email: "editor@example.com",
        display_name: "Content Editor",
        user_registered: "2026-02-01 12:00:00",
        roles: ["editor"],
      },
    ]);

    writeFileSync(
      fakeWp,
      `#!/usr/bin/env bash\necho '${mockUsersJson}'\nexit 0\n`,
    );
    chmodSync(fakeWp, 0o755);

    try {
      const output = execFileSync(
        "php",
        [wpUsersScript, `--docroot=${docroot}`],
        {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
          encoding: "utf8",
        },
      );

      const parsed = JSON.parse(output);
      expect(parsed.users).toBeDefined();
      expect(parsed.users).toHaveLength(2);

      expect(parsed.users[0]).toEqual({
        id: 3,
        user_login: "admin",
        user_email: "admin@example.com",
        display_name: "Site Admin",
        user_registered: "2026-01-01 12:00:00",
        roles: ["administrator"],
      });

      expect(parsed.users[1]).toEqual({
        id: 8,
        user_login: "editor1",
        user_email: "editor@example.com",
        display_name: "Content Editor",
        user_registered: "2026-02-01 12:00:00",
        roles: ["editor"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns empty users list with descriptive error if no credentials or docroot found", () => {
    const output = execFileSync("php", [wpUsersScript], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(output);
    expect(parsed.users).toEqual([]);
    expect(parsed.error).toContain("No DB credentials provided");
  });
});

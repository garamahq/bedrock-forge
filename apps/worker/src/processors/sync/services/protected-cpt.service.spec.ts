import { ProtectedCptService } from "./protected-cpt.service";
import { StepTracker } from "../../../services/step-tracker";

describe("ProtectedCptService", () => {
  let service: ProtectedCptService;

  beforeEach(() => {
    service = new ProtectedCptService();
  });

  const creds = {
    dbHost: "localhost",
    dbUser: "u",
    dbPassword: "p",
    dbName: "db",
  };
  const postTypes = ["course", "lesson"];
  const tgtMycnf = "/tmp/my.cnf";

  function makeTracker() {
    return {
      track: jest.fn().mockResolvedValue(undefined),
    } as unknown as StepTracker;
  }

  it("extracts original and generated upload paths from attachment metadata", () => {
    const output = [
      "10\t_wp_attached_file\t2026/01/project.jpg",
      '10\t_wp_attachment_metadata\ta:2:{s:4:"file";s:19:"2026/01/project.jpg";s:5:"sizes";a:1:{s:9:"thumbnail";a:1:{s:4:"file";s:21:"project-150x150.jpg";}}}',
    ].join("\n");

    expect((service as any).extractProtectedUploadPaths(output)).toEqual([
      "2026/01/project.jpg",
      "2026/01/project-150x150.jpg",
    ]);
  });

  describe("backupProtectedPostTypes", () => {
    it("returns null if postTypes list is empty", async () => {
      const executor = { execute: jest.fn() } as any;
      const tracker = makeTracker();
      const res = await service.backupProtectedPostTypes(
        executor,
        creds,
        tgtMycnf,
        [],
        tracker,
      );
      expect(res).toBeNull();
    });

    it("returns null if posts table does not exist", async () => {
      const executor = {
        execute: jest
          .fn()
          .mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
      } as any;
      const tracker = makeTracker();
      const res = await service.backupProtectedPostTypes(
        executor,
        creds,
        tgtMycnf,
        postTypes,
        tracker,
      );
      expect(res).toBeNull();
      expect(tracker.track).toHaveBeenCalledWith(
        expect.objectContaining({
          step: expect.stringContaining("posts table does not exist"),
        }),
      );
    });

    it("returns prefix and skips backup if backup table already exists", async () => {
      const executor = {
        pushFile: jest.fn(),
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("SHOW TABLES") && cmd.includes("wp_posts")) {
            return Promise.resolve({ code: 0, stdout: "wp_posts", stderr: "" });
          }
          if (
            cmd.includes("SHOW TABLES") &&
            cmd.includes("wp_forge_backup_posts")
          ) {
            return Promise.resolve({
              code: 0,
              stdout: "wp_forge_backup_posts",
              stderr: "",
            });
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }),
      } as any;
      const tracker = makeTracker();
      const res = await service.backupProtectedPostTypes(
        executor,
        creds,
        tgtMycnf,
        postTypes,
        tracker,
      );
      expect(res).toEqual({ prefix: "wp_", uploadPaths: [] });
      expect(executor.pushFile).not.toHaveBeenCalled();
      expect(tracker.track).toHaveBeenCalledWith(
        expect.objectContaining({
          step: expect.stringContaining("existing backup tables detected"),
        }),
      );
    });

    it("creates backup and returns prefix if backup table does not exist", async () => {
      let pushedSql = "";
      const executor = {
        pushFile: jest.fn().mockImplementation(({ content }) => {
          pushedSql = Buffer.isBuffer(content)
            ? content.toString("utf8")
            : String(content);
          return Promise.resolve(undefined);
        }),
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("SHOW TABLES") && cmd.includes("wp_posts")) {
            return Promise.resolve({ code: 0, stdout: "wp_posts", stderr: "" });
          }
          if (
            cmd.includes("SHOW TABLES") &&
            cmd.includes("wp_forge_backup_posts")
          ) {
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }),
      } as any;
      const tracker = makeTracker();
      const res = await service.backupProtectedPostTypes(
        executor,
        creds,
        tgtMycnf,
        postTypes,
        tracker,
      );
      expect(res).toEqual({ prefix: "wp_", uploadPaths: [] });
      expect(executor.pushFile).toHaveBeenCalled();
      expect(pushedSql).toContain("a.post_type = 'attachment'");
      expect(pushedSql).toContain("forge_backup_term_taxonomy");
      expect(pushedSql).toContain("forge_backup_terms");
      expect(tracker.track).toHaveBeenCalledWith(
        expect.objectContaining({
          step: expect.stringContaining("backing up target post types"),
        }),
      );
    });

    it("returns null if backup command fails", async () => {
      const executor = {
        pushFile: jest.fn().mockResolvedValue(undefined),
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("SHOW TABLES") && cmd.includes("wp_posts")) {
            return Promise.resolve({ code: 0, stdout: "wp_posts", stderr: "" });
          }
          if (
            cmd.includes("SHOW TABLES") &&
            cmd.includes("wp_forge_backup_posts")
          ) {
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
          }
          if (cmd.includes("<") && cmd.includes("forge_post_type_backup_")) {
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "Access denied",
            });
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }),
      } as any;
      const tracker = makeTracker();
      const res = await service.backupProtectedPostTypes(
        executor,
        creds,
        tgtMycnf,
        postTypes,
        tracker,
      );
      expect(res).toBeNull();
      expect(tracker.track).toHaveBeenCalledWith(
        expect.objectContaining({
          step: expect.stringContaining("backup failed"),
        }),
      );
    });
  });

  describe("restoreProtectedPostTypes", () => {
    it("skips restore if postTypes is empty", async () => {
      const executor = { execute: jest.fn() } as any;
      const tracker = makeTracker();
      await service.restoreProtectedPostTypes(
        executor,
        creds,
        tgtMycnf,
        [],
        "wp_",
        tracker,
      );
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it("skips restore if backup table does not exist", async () => {
      const executor = {
        execute: jest
          .fn()
          .mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
      } as any;
      const tracker = makeTracker();
      await service.restoreProtectedPostTypes(
        executor,
        creds,
        tgtMycnf,
        postTypes,
        "wp_",
        tracker,
      );
      expect(executor.execute).toHaveBeenCalledTimes(1);
    });

    it("performs restore and tracks success when query succeeds", async () => {
      let pushedSql = "";
      const executor = {
        pushFile: jest.fn().mockImplementation(({ content }) => {
          pushedSql = Buffer.isBuffer(content)
            ? content.toString("utf8")
            : String(content);
          return Promise.resolve(undefined);
        }),
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (
            cmd.includes("SHOW TABLES") &&
            cmd.includes("wp_forge_backup_posts")
          ) {
            return Promise.resolve({
              code: 0,
              stdout: "wp_forge_backup_posts",
              stderr: "",
            });
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }),
      } as any;
      const tracker = makeTracker();
      await service.restoreProtectedPostTypes(
        executor,
        creds,
        tgtMycnf,
        postTypes,
        "wp_",
        tracker,
      );
      expect(executor.pushFile).toHaveBeenCalled();
      expect(pushedSql).toContain("a.post_type = 'attachment'");
      expect(pushedSql).toContain(
        "ID IN (SELECT ID FROM `wp_forge_backup_posts`)",
      );
      expect(pushedSql).toContain("REPLACE INTO `wp_terms`");
      expect(pushedSql).toContain("REPLACE INTO `wp_term_taxonomy`");
      expect(pushedSql).toContain("INSERT IGNORE INTO `wp_term_relationships`");
      expect(tracker.track).toHaveBeenCalledWith(
        expect.objectContaining({
          step: expect.stringContaining("restored successfully"),
        }),
      );
    });

    it("throws an error when restore query fails", async () => {
      const executor = {
        pushFile: jest.fn().mockResolvedValue(undefined),
        execute: jest.fn().mockImplementation((cmd: string) => {
          if (
            cmd.includes("SHOW TABLES") &&
            cmd.includes("wp_forge_backup_posts")
          ) {
            return Promise.resolve({
              code: 0,
              stdout: "wp_forge_backup_posts",
              stderr: "",
            });
          }
          if (cmd.includes("<") && cmd.includes("forge_post_type_restore_")) {
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "Restore error",
            });
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }),
      } as any;
      const tracker = makeTracker();
      await expect(
        service.restoreProtectedPostTypes(
          executor,
          creds,
          tgtMycnf,
          postTypes,
          "wp_",
          tracker,
        ),
      ).rejects.toThrow("restore failed: Restore error");
      expect(tracker.track).toHaveBeenCalledWith(
        expect.objectContaining({
          step: expect.stringContaining("restore failed"),
        }),
      );
    });
  });

  describe("collectProtectedPostTypeUploadPaths (#83)", () => {
    it("returns an empty list when query succeeds with zero rows", async () => {
      const executor = {
        execute: jest.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
      } as any;
      const tracker = makeTracker();

      const res = await service.collectProtectedPostTypeUploadPaths(
        executor,
        creds,
        tgtMycnf,
        ["course"],
        tracker,
        "wp_",
      );
      expect(res).toEqual([]);
    });

    it("throws instead of returning [] when MySQL enumeration fails", async () => {
      const executor = {
        execute: jest.fn().mockResolvedValue({
          code: 1,
          stdout: "",
          stderr: "ERROR 1045 (28000): Access denied",
        }),
      } as any;
      const tracker = makeTracker();

      await expect(
        service.collectProtectedPostTypeUploadPaths(
          executor,
          creds,
          tgtMycnf,
          ["course"],
          tracker,
          "wp_",
        ),
      ).rejects.toThrow(/enumerate|collect|Access denied/i);
    });
  });
});

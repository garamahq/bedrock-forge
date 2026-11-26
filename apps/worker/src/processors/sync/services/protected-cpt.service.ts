import { Injectable, Logger } from "@nestjs/common";
import { StepTracker } from "../../../services/step-tracker";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { escapeMysql } from "../../../utils/cyberpanel-http";
import { shellQuote } from "../../../utils/processor-utils";
import { WpLayout } from "./layout-detector.service";

type Executor = Awaited<ReturnType<typeof createRemoteExecutor>>;

export type Creds = {
  dbHost: string;
  dbUser: string;
  dbPassword: string;
  dbName: string;
};

export type ProtectedPostTypeBackup = {
  prefix: string;
  uploadPaths: string[];
};

const POST_TYPE_REGEX = /^[A-Za-z0-9_-]+$/;

@Injectable()
export class ProtectedCptService {
  private readonly logger = new Logger(ProtectedCptService.name);

  normalizeProtectedPostTypes(postTypes: string[] = []): string[] {
    return Array.from(
      new Set(
        postTypes.map((t) => t.trim()).filter((t) => POST_TYPE_REGEX.test(t)),
      ),
    );
  }

  async collectProtectedPostTypeUploadPaths(
    executor: Executor,
    creds: Creds,
    tgtMycnf: string,
    postTypes: string[],
    tracker: StepTracker,
    knownPrefix?: string,
    useBackupTables = false,
  ): Promise<string[]> {
    const safePostTypes = this.normalizeProtectedPostTypes(postTypes);
    if (safePostTypes.length === 0) return [];

    const prefix =
      knownPrefix ??
      (await this.detectTargetTablePrefix(executor, creds, tgtMycnf));
    const postTypesList = safePostTypes
      .map((t) => `'${escapeMysql(t)}'`)
      .join(",");
    const postsTable = useBackupTables
      ? `${prefix}forge_backup_posts`
      : `${prefix}posts`;
    const postmetaTable = useBackupTables
      ? `${prefix}forge_backup_postmeta`
      : `${prefix}postmeta`;
    const query = `
			SELECT pm.post_id, pm.meta_key, pm.meta_value
			FROM \`${postmetaTable}\` pm
			INNER JOIN \`${postsTable}\` a ON pm.post_id = a.ID
			INNER JOIN \`${postsTable}\` p ON a.post_parent = p.ID
			WHERE a.post_type = 'attachment'
			  AND p.post_type IN (${postTypesList})
			  AND pm.meta_key IN ('_wp_attached_file', '_wp_attachment_metadata')
			ORDER BY pm.post_id, pm.meta_key
		`;
    const result = await executor.execute(
      `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} ${shellQuote(creds.dbName)} -B -N -e ${shellQuote(query)}`,
    );
    if (result.code !== 0) {
      await tracker.track({
        step: "Protected Post Types — failed to enumerate upload paths",
        level: "error",
        detail: result.stderr,
      });
      throw new Error(
        `Failed to enumerate protected post type upload paths (exit ${result.code}): ${result.stderr || result.stdout}`,
      );
    }

    const paths = this.extractProtectedUploadPaths(result.stdout);
    if (paths.length > 0) {
      await tracker.track({
        step: "Protected Post Types — protected upload files detected",
        level: "info",
        detail: `${paths.length} upload path(s) will be excluded from file sync deletion/overwrite`,
      });
    }
    return paths;
  }

  async detectTargetTablePrefix(
    executor: Executor,
    creds: Creds,
    tgtMycnf: string,
  ): Promise<string> {
    const prefixQuery = `SELECT REPLACE(table_name,'options','') FROM information_schema.tables WHERE table_schema='${escapeMysql(creds.dbName)}' AND table_name LIKE '%options' LIMIT 1`;
    const prefixResult = await executor.execute(
      `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} ${shellQuote(creds.dbName)} -sN -e ${shellQuote(prefixQuery)}`,
    );
    return prefixResult.code === 0 && prefixResult.stdout.trim()
      ? prefixResult.stdout.trim()
      : "wp_";
  }

  extractProtectedUploadPaths(mysqlOutput: string): string[] {
    type AttachmentMeta = {
      attachedFile?: string;
      metadata?: string;
    };
    const byPost = new Map<string, AttachmentMeta>();

    for (const line of mysqlOutput.split("\n")) {
      if (!line.trim()) continue;
      const [postId, metaKey, ...valueParts] = line.split("\t");
      const metaValue = valueParts.join("\t").trim();
      const current = byPost.get(postId) ?? {};
      if (metaKey === "_wp_attached_file") current.attachedFile = metaValue;
      if (metaKey === "_wp_attachment_metadata") current.metadata = metaValue;
      byPost.set(postId, current);
    }

    const paths = new Set<string>();
    for (const meta of byPost.values()) {
      if (!meta.attachedFile) continue;
      const attached = this.normalizeUploadPath(meta.attachedFile);
      if (!attached) continue;
      paths.add(attached);

      const dir = attached.includes("/")
        ? attached.slice(0, attached.lastIndexOf("/"))
        : "";
      const metadata = meta.metadata ?? "";
      const fileMatches = metadata.matchAll(
        /s:\d+:"([^"]+\.[A-Za-z0-9]{2,8})"/g,
      );
      for (const match of fileMatches) {
        const raw = match[1];
        const candidate = raw.includes("/") || !dir ? raw : `${dir}/${raw}`;
        const normalized = this.normalizeUploadPath(candidate);
        if (normalized) paths.add(normalized);
      }
    }

    return Array.from(paths);
  }

  normalizeUploadPath(path: string): string | null {
    const clean = path
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/^wp-content\/uploads\//, "")
      .replace(/^app\/uploads\//, "")
      .trim();

    if (!clean || clean.includes("..") || clean.endsWith("/")) return null;
    return clean;
  }

  buildProtectedUploadFileExcludes(
    targetRoot: string,
    targetLayout: WpLayout,
    uploadPaths: string[],
  ): string[] {
    if (uploadPaths.length === 0) return [];
    const normalizedRoot = targetRoot.replace(/\/+$/, "");
    const normalizedContent = targetLayout.contentPath.replace(/\/+$/, "");
    const contentRelative = normalizedContent.startsWith(`${normalizedRoot}/`)
      ? normalizedContent.slice(normalizedRoot.length + 1)
      : targetLayout.isBedrock
        ? "web/app"
        : "wp-content";

    return Array.from(
      new Set(
        uploadPaths
          .map((p) => this.normalizeUploadPath(p))
          .filter((p): p is string => Boolean(p))
          .map((p) => `${contentRelative}/uploads/${p}`.replace(/\/+/g, "/")),
      ),
    );
  }

  async backupProtectedPostTypes(
    executor: Executor,
    creds: Creds,
    tgtMycnf: string,
    postTypes: string[],
    tracker: StepTracker,
  ): Promise<ProtectedPostTypeBackup | null> {
    const safePostTypes = this.normalizeProtectedPostTypes(postTypes);
    if (safePostTypes.length === 0) return null;

    let prefix = "wp_";
    try {
      const prefixQuery = `SELECT REPLACE(table_name,'options','') FROM information_schema.tables WHERE table_schema='${escapeMysql(creds.dbName)}' AND table_name LIKE '%options' LIMIT 1`;
      const prefixResult = await executor.execute(
        `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} ${shellQuote(creds.dbName)} -sN -e ${shellQuote(prefixQuery)}`,
      );
      if (prefixResult.code === 0 && prefixResult.stdout.trim()) {
        prefix = prefixResult.stdout.trim();
      }
    } catch (err) {
      this.logger.warn(
        `Failed to auto-detect target table prefix for post type backup, defaulting to wp_: ${err}`,
      );
    }

    const tableCheck = await executor.execute(
      `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} ${shellQuote(creds.dbName)} -sN -e ${shellQuote(`SHOW TABLES LIKE '${prefix}posts'`)}`,
    );
    if (tableCheck.code !== 0) {
      await tracker.track({
        step: "Protected Post Types — failed to inspect target posts table",
        level: "error",
        detail: tableCheck.stderr,
      });
      throw new Error(
        `Failed to inspect target posts table for protected post types (exit ${tableCheck.code}): ${tableCheck.stderr || tableCheck.stdout}`,
      );
    }
    if (tableCheck.stdout.trim() === "") {
      await tracker.track({
        step: "Protected Post Types — posts table does not exist, skipping backup",
        level: "info",
      });
      return null;
    }

    // Check if backup tables already exist. If they do, DO NOT overwrite them because
    // they contain the original target data from a previous failed sync attempt.
    const backupTableCheck = await executor.execute(
      `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} ${shellQuote(creds.dbName)} -sN -e ${shellQuote(`SHOW TABLES LIKE '${prefix}forge_backup_posts'`)}`,
    );
    if (backupTableCheck.code === 0 && backupTableCheck.stdout.trim() !== "") {
      await tracker.track({
        step: "Protected Post Types — existing backup tables detected from a previous failed run, retaining them",
        level: "info",
      });
      return {
        prefix,
        uploadPaths: await this.collectProtectedPostTypeUploadPaths(
          executor,
          creds,
          tgtMycnf,
          safePostTypes,
          tracker,
          prefix,
          true,
        ),
      };
    }

    await tracker.track({
      step: "Protected Post Types — backing up target post types",
      level: "info",
      detail: `Post types: ${safePostTypes.join(", ")}`,
    });

    const postTypesList = safePostTypes
      .map((t) => `'${escapeMysql(t)}'`)
      .join(",");

    const queries = [
      // Back up protected posts, their revisions, and directly attached media.
      `DROP TABLE IF EXISTS \`${prefix}forge_backup_posts\`;`,
      `CREATE TABLE \`${prefix}forge_backup_posts\` AS
			  SELECT * FROM \`${prefix}posts\` WHERE post_type IN (${postTypesList})
			  UNION ALL
			  SELECT r.* FROM \`${prefix}posts\` r
			    INNER JOIN \`${prefix}posts\` p ON r.post_parent = p.ID
			    WHERE r.post_type = 'revision' AND p.post_type IN (${postTypesList})
			  UNION ALL
			  SELECT a.* FROM \`${prefix}posts\` a
			    INNER JOIN \`${prefix}posts\` p ON a.post_parent = p.ID
			    WHERE a.post_type = 'attachment' AND p.post_type IN (${postTypesList});`,
      // Back up related postmeta
      `DROP TABLE IF EXISTS \`${prefix}forge_backup_postmeta\`;`,
      `CREATE TABLE \`${prefix}forge_backup_postmeta\` AS SELECT * FROM \`${prefix}postmeta\` WHERE post_id IN (SELECT ID FROM \`${prefix}forge_backup_posts\`);`,
      // Back up taxonomy graph used by protected posts/media.
      `DROP TABLE IF EXISTS \`${prefix}forge_backup_term_relationships\`;`,
      `CREATE TABLE \`${prefix}forge_backup_term_relationships\` AS SELECT * FROM \`${prefix}term_relationships\` WHERE object_id IN (SELECT ID FROM \`${prefix}forge_backup_posts\`);`,
      `DROP TABLE IF EXISTS \`${prefix}forge_backup_term_taxonomy\`;`,
      `CREATE TABLE \`${prefix}forge_backup_term_taxonomy\` AS
			  SELECT DISTINCT tt.* FROM \`${prefix}term_taxonomy\` tt
			    INNER JOIN \`${prefix}forge_backup_term_relationships\` tr ON tr.term_taxonomy_id = tt.term_taxonomy_id;`,
      `DROP TABLE IF EXISTS \`${prefix}forge_backup_terms\`;`,
      `CREATE TABLE \`${prefix}forge_backup_terms\` AS
			  SELECT DISTINCT t.* FROM \`${prefix}terms\` t
			    INNER JOIN \`${prefix}forge_backup_term_taxonomy\` tt ON tt.term_id = t.term_id;`,
      // Back up comments and their meta
      `DROP TABLE IF EXISTS \`${prefix}forge_backup_comments\`;`,
      `CREATE TABLE \`${prefix}forge_backup_comments\` AS SELECT * FROM \`${prefix}comments\` WHERE comment_post_ID IN (SELECT ID FROM \`${prefix}forge_backup_posts\`);`,
      `DROP TABLE IF EXISTS \`${prefix}forge_backup_commentmeta\`;`,
      `CREATE TABLE \`${prefix}forge_backup_commentmeta\` AS SELECT * FROM \`${prefix}commentmeta\` WHERE comment_id IN (SELECT comment_ID FROM \`${prefix}forge_backup_comments\`);`,
    ];

    const sqlFile = `/tmp/forge_post_type_backup_${Date.now()}.sql`;
    await executor.pushFile({
      remotePath: sqlFile,
      content: Buffer.from(queries.join("\n")),
    });

    const res = await executor.execute(
      `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} ${shellQuote(creds.dbName)} < ${shellQuote(sqlFile)}`,
    );
    await executor.execute(`rm -f ${shellQuote(sqlFile)}`);

    if (res.code !== 0) {
      await tracker.track({
        step: "Protected Post Types — backup failed",
        level: "warn",
        detail: res.stderr,
      });
      return null;
    }

    return {
      prefix,
      uploadPaths: await this.collectProtectedPostTypeUploadPaths(
        executor,
        creds,
        tgtMycnf,
        safePostTypes,
        tracker,
        prefix,
        true,
      ),
    };
  }

  async restoreProtectedPostTypes(
    executor: Executor,
    creds: Creds,
    tgtMycnf: string,
    postTypes: string[],
    prefix: string,
    tracker: StepTracker,
  ): Promise<void> {
    const safePostTypes = this.normalizeProtectedPostTypes(postTypes);
    if (safePostTypes.length === 0) return;

    const tableCheck = await executor.execute(
      `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} ${shellQuote(creds.dbName)} -sN -e ${shellQuote(`SHOW TABLES LIKE '${prefix}forge_backup_posts'`)}`,
    );
    if (tableCheck.code !== 0 || tableCheck.stdout.trim() === "") {
      return;
    }

    await tracker.track({
      step: "Protected Post Types — restoring target post types",
      level: "info",
      detail: `Post types: ${safePostTypes.join(", ")}`,
    });

    const postTypesList = safePostTypes
      .map((t) => `'${escapeMysql(t)}'`)
      .join(",");
    const protectedImportedPostsPredicate =
      `p.post_type IN (${postTypesList}) OR ` +
      `(p.post_type = 'attachment' AND parent.post_type IN (${postTypesList}))`;

    const queries = [
      // Step 1: Delete comments/meta for source-imported protected posts and attached media.
      `DELETE cm FROM \`${prefix}commentmeta\` cm
			  INNER JOIN \`${prefix}comments\` c ON cm.comment_id = c.comment_ID
			  INNER JOIN \`${prefix}posts\` p ON c.comment_post_ID = p.ID
			  LEFT JOIN \`${prefix}posts\` parent ON p.post_parent = parent.ID
			  WHERE c.comment_post_ID IN (SELECT ID FROM \`${prefix}forge_backup_posts\`)
			    OR ${protectedImportedPostsPredicate};`,

      `DELETE c FROM \`${prefix}comments\` c
			  INNER JOIN \`${prefix}posts\` p ON c.comment_post_ID = p.ID
			  LEFT JOIN \`${prefix}posts\` parent ON p.post_parent = parent.ID
			  WHERE c.comment_post_ID IN (SELECT ID FROM \`${prefix}forge_backup_posts\`)
			    OR ${protectedImportedPostsPredicate};`,

      // Step 2: Delete postmeta for source-imported protected posts, revisions, and attached media.
      `DELETE FROM \`${prefix}postmeta\`
			  WHERE post_id IN (SELECT ID FROM \`${prefix}forge_backup_posts\`);`,
      `DELETE pm FROM \`${prefix}postmeta\` pm
			  INNER JOIN \`${prefix}posts\` p ON pm.post_id = p.ID
			  WHERE p.post_type IN (${postTypesList});`,
      `DELETE pm FROM \`${prefix}postmeta\` pm
			  INNER JOIN \`${prefix}posts\` r ON pm.post_id = r.ID
			  INNER JOIN \`${prefix}posts\` p ON r.post_parent = p.ID
			  WHERE r.post_type = 'revision' AND p.post_type IN (${postTypesList});`,
      `DELETE pm FROM \`${prefix}postmeta\` pm
			  INNER JOIN \`${prefix}posts\` a ON pm.post_id = a.ID
			  INNER JOIN \`${prefix}posts\` p ON a.post_parent = p.ID
			  WHERE a.post_type = 'attachment' AND p.post_type IN (${postTypesList});`,

      // Step 3: Delete term relationships for source-imported protected posts and attached media.
      `DELETE FROM \`${prefix}term_relationships\`
			  WHERE object_id IN (SELECT ID FROM \`${prefix}forge_backup_posts\`);`,
      `DELETE tr FROM \`${prefix}term_relationships\` tr
			  INNER JOIN \`${prefix}posts\` p ON tr.object_id = p.ID
			  WHERE p.post_type IN (${postTypesList});`,
      `DELETE tr FROM \`${prefix}term_relationships\` tr
			  INNER JOIN \`${prefix}posts\` a ON tr.object_id = a.ID
			  INNER JOIN \`${prefix}posts\` p ON a.post_parent = p.ID
			  WHERE a.post_type = 'attachment' AND p.post_type IN (${postTypesList});`,

      // Step 4: Delete dependent source-imported rows.
      `DELETE r FROM \`${prefix}posts\` r
			  INNER JOIN \`${prefix}posts\` p ON r.post_parent = p.ID
			  WHERE r.post_type = 'revision' AND p.post_type IN (${postTypesList});`,
      `DELETE a FROM \`${prefix}posts\` a
			  INNER JOIN \`${prefix}posts\` p ON a.post_parent = p.ID
			  WHERE a.post_type = 'attachment' AND p.post_type IN (${postTypesList});`,

      `DELETE FROM \`${prefix}posts\` WHERE post_type IN (${postTypesList});`,
      `DELETE FROM \`${prefix}posts\`
			  WHERE ID IN (SELECT ID FROM \`${prefix}forge_backup_posts\`);`,

      // Step 5: Restore original target rows from backup tables.
      `REPLACE INTO \`${prefix}terms\` SELECT * FROM \`${prefix}forge_backup_terms\`;`,
      `REPLACE INTO \`${prefix}term_taxonomy\` SELECT * FROM \`${prefix}forge_backup_term_taxonomy\`;`,
      `INSERT IGNORE INTO \`${prefix}posts\` SELECT * FROM \`${prefix}forge_backup_posts\`;`,
      `INSERT IGNORE INTO \`${prefix}postmeta\` SELECT * FROM \`${prefix}forge_backup_postmeta\`;`,
      `INSERT IGNORE INTO \`${prefix}term_relationships\` SELECT * FROM \`${prefix}forge_backup_term_relationships\`;`,
      `INSERT IGNORE INTO \`${prefix}comments\` SELECT * FROM \`${prefix}forge_backup_comments\`;`,
      `INSERT IGNORE INTO \`${prefix}commentmeta\` SELECT * FROM \`${prefix}forge_backup_commentmeta\`;`,

      // Step 6: Drop temporary backup tables.
      `DROP TABLE IF EXISTS \`${prefix}forge_backup_commentmeta\`;`,
      `DROP TABLE IF EXISTS \`${prefix}forge_backup_comments\`;`,
      `DROP TABLE IF EXISTS \`${prefix}forge_backup_terms\`;`,
      `DROP TABLE IF EXISTS \`${prefix}forge_backup_term_taxonomy\`;`,
      `DROP TABLE IF EXISTS \`${prefix}forge_backup_term_relationships\`;`,
      `DROP TABLE IF EXISTS \`${prefix}forge_backup_postmeta\`;`,
      `DROP TABLE IF EXISTS \`${prefix}forge_backup_posts\`;`,
    ];

    const sqlFile = `/tmp/forge_post_type_restore_${Date.now()}.sql`;
    await executor.pushFile({
      remotePath: sqlFile,
      content: Buffer.from(queries.join("\n")),
    });

    const res = await executor.execute(
      `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} ${shellQuote(creds.dbName)} < ${shellQuote(sqlFile)}`,
    );
    await executor.execute(`rm -f ${shellQuote(sqlFile)}`);

    if (res.code !== 0) {
      await tracker.track({
        step: "Protected Post Types — restore failed",
        level: "error",
        detail: res.stderr,
      });
      throw new Error(`Protected Post Types — restore failed: ${res.stderr}`);
    } else {
      await tracker.track({
        step: "Protected Post Types — restored successfully",
        level: "info",
      });
    }
  }
}

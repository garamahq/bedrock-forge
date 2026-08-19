import { WpDbCredentials } from "@bedrock-forge/shared";

/**
 * CredentialParserService
 *
 * Extracts WordPress DB credentials from raw wp-config.php or .env content
 * using regex only. NEVER sources, evals, requires, or spawns any file.
 *
 * Handles all real-world patterns:
 * - define('DB_NAME', 'mydb');
 * - define( "DB_NAME", "mydb" );
 * - define('DB_PASSWORD', 'p@$$w0rd!123');
 * - .env style: DB_NAME=mydb / DB_NAME='mydb' / DB_NAME="mydb"
 * - export DB_NAME=mydb (shell-sourced .env)
 * - DATABASE_URL=mysql://user:pass@host:port/dbname
 * - Missing or commented-out DB_HOST (defaults to localhost)
 * - Constants defined in any order
 * - Whitespace variations
 * - Values containing special characters
 */
export class CredentialParserService {
  /**
   * Parse wp-config.php file content and extract DB credentials.
   * Returns null if DB_NAME, DB_USER or DB_PASSWORD cannot be found.
   * DB_HOST defaults to 'localhost' when absent.
   */
  parseWpConfig(content: string): WpDbCredentials | null {
    // Normalise Windows line endings so anchors behave correctly
    content = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const dbName = this.extractDefine(content, "DB_NAME");
    const dbUser = this.extractDefine(content, "DB_USER");
    const dbPassword = this.extractDefine(content, "DB_PASSWORD");
    const dbHost = this.extractDefine(content, "DB_HOST") ?? "localhost";

    if (!dbName || !dbUser || !dbPassword) {
      return null;
    }

    return { dbName, dbUser, dbPassword, dbHost };
  }

  /**
   * Parse .env file content and extract DB credentials.
   *
   * Strategy:
   * 1. Try individual DB_NAME / DB_USER / DB_PASSWORD / DB_HOST vars.
   * 2. If DB_NAME is still missing, fall back to DATABASE_URL parsing.
   * 3. DB_HOST defaults to 'localhost' when absent or commented out.
   *
   * Returns null if the minimum set (dbName + dbUser + dbPassword) cannot
   * be determined.
   */
  parseEnvFile(content: string): WpDbCredentials | null {
    // Normalise Windows line endings (common on hosting-panel-generated .env files)
    content = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let dbName = this.extractEnv(content, "DB_NAME");
    let dbUser = this.extractEnv(content, "DB_USER");
    let dbPassword = this.extractEnv(content, "DB_PASSWORD");
    let dbHost = this.extractEnv(content, "DB_HOST");

    // Fallback: parse DATABASE_URL when individual vars are incomplete
    if (!dbName) {
      const fromUrl = this.parseDatabaseUrl(content);
      if (fromUrl) {
        dbName = dbName ?? fromUrl.dbName;
        dbUser = dbUser ?? fromUrl.dbUser;
        dbPassword = dbPassword ?? fromUrl.dbPassword;
        dbHost = dbHost ?? fromUrl.dbHost;
      }
    }

    if (!dbName || !dbUser || !dbPassword) {
      return null;
    }

    return {
      dbName,
      dbUser,
      dbPassword,
      dbHost: dbHost ?? "localhost",
    };
  }

  /**
   * Auto-detect format and parse. Tries wp-config.php format first,
   * falls back to .env format.
   */
  parse(content: string): WpDbCredentials | null {
    const wpResult = this.parseWpConfig(content);
    if (wpResult) return wpResult;
    return this.parseEnvFile(content);
  }

  /**
   * Extract a define('KEY', 'value') or define("KEY", "value") statement.
   *
   * Handles:
   *   define('DB_NAME', 'mydb');
   *   define( 'DB_NAME', 'mydb' );
   *   define("DB_NAME", "mydb");
   *   define ( "DB_NAME" , "mydb" ) ;
   *   Values with special chars: !, @, #, $, %, ^, &, *, (, ), -, _, +, =, [, ], {, }, |, ;, :, ', ", ,, ., <, >, ?, /, `, ~
   */
  private extractDefine(content: string, key: string): string | null {
    // Match: define( QUOTE KEY QUOTE , QUOTE VALUE QUOTE )
    // The value regex [^'"]* won't work for passwords with quotes.
    // We use a more careful approach: match everything up to the closing quote
    // that's followed by optional whitespace and ) or ,
    const singleQuotePattern = new RegExp(
      `define\\s*\\(\\s*'${key}'\\s*,\\s*'((?:[^'\\\\]|\\\\.)*)'\\s*\\)`,
      "i",
    );
    const doubleQuotePattern = new RegExp(
      `define\\s*\\(\\s*"${key}"\\s*,\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*\\)`,
      "i",
    );

    const singleMatch = content.match(singleQuotePattern);
    if (singleMatch?.[1] !== undefined) {
      return this.unescape(singleMatch[1]);
    }

    const doubleMatch = content.match(doubleQuotePattern);
    if (doubleMatch?.[1] !== undefined) {
      return this.unescape(doubleMatch[1]);
    }

    return null;
  }

  /**
   * Extract a KEY=value line from .env content.
   *
   * Handles:
   *   DB_NAME=mydb
   *   DB_NAME="mydb"
   *   DB_NAME='mydb'
   *   export DB_NAME=mydb
   *   export DB_NAME="mydb"
   *   DB_PASSWORD="it's-complex"  (single quote inside double-quoted value)
   *   DB_PASSWORD='say"hello"'    (double quote inside single-quoted value)
   *   Lines with # comments after value
   *
   * Uses separate single/double-quote patterns to avoid cross-quote
   * truncation (a shared [^'"] class stops at either quote type).
   */
  private extractEnv(content: string, key: string): string | null {
    // Optional `export ` prefix (common in shell-sourced .env files)
    const prefix = `(?:export\\s+)?${key}\\s*=\\s*`;

    // 1. Single-quoted value — stops only at unescaped single quote
    const singlePattern = new RegExp(`^${prefix}'((?:[^'\\\\]|\\\\.)*)'`, "im");
    const singleMatch = content.match(singlePattern);
    if (singleMatch?.[1] !== undefined) {
      return this.unescape(singleMatch[1]);
    }

    // 2. Double-quoted value — stops only at unescaped double quote
    const doublePattern = new RegExp(`^${prefix}"((?:[^"\\\\]|\\\\.)*)"`, "im");
    const doubleMatch = content.match(doublePattern);
    if (doubleMatch?.[1] !== undefined) {
      return this.unescape(doubleMatch[1]);
    }

    // 3. Unquoted value — match line content, strip trailing whitespace and comments preceded by whitespace
    const unquotedPattern = new RegExp(`^${prefix}([^\\r\\n]+)`, "im");
    const unquotedMatch = content.match(unquotedPattern);
    if (unquotedMatch?.[1] !== undefined) {
      let rawVal = unquotedMatch[1].trim();
      // Comments in dotenv are # preceded by whitespace (e.g., `value # comment`)
      rawVal = rawVal.replace(/\s+#.*$/, "").trim();
      if (
        (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
        (rawVal.startsWith("'") && rawVal.endsWith("'"))
      ) {
        rawVal = rawVal.slice(1, -1);
      }
      return rawVal ? this.unescape(rawVal) : null;
    }

    return null;
  }

  /**
   * Parse DATABASE_URL from .env content.
   *
   * Supports:
   *   DATABASE_URL=mysql://user:pass@host/dbname
   *   DATABASE_URL=mysql://user:pass@host:3306/dbname
   *   DATABASE_URL='mysql://user:p%40ss@host/dbname'
   *   DATABASE_URL="mysql://user:pass@host/dbname"
   *
   * URL-decodes user/password components to handle encoded special chars.
   * Returns null when DATABASE_URL is absent, commented out, or malformed.
   */
  private parseDatabaseUrl(content: string): WpDbCredentials | null {
    const raw = this.extractEnv(content, "DATABASE_URL");
    if (!raw) return null;

    try {
      const url = new URL(raw);
      const dbName = url.pathname.replace(/^\//, "");
      const dbUser = decodeURIComponent(url.username);
      const dbPassword = decodeURIComponent(url.password);
      const dbHost = url.port
        ? `${url.hostname}:${url.port}`
        : url.hostname || "localhost";

      if (!dbName || !dbUser) return null;

      return { dbName, dbUser, dbPassword, dbHost };
    } catch {
      return null;
    }
  }

  /**
   * Unescape backslash-escaped characters in PHP string values.
   * PHP single-quoted strings only escape \\ and \'.
   * PHP double-quoted strings escape \\, \", \n, \t, \r, \$, \0.
   */
  private unescape(value: string): string {
    return value
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

// Singleton export for convenience
export const credentialParser = new CredentialParserService();

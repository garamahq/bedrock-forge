import { CredentialParserService } from "../credential-parser.service";

describe("CredentialParserService", () => {
  const parser = new CredentialParserService();

  // ─── wp-config.php: standard single-quote format ──────────────────────────

  it("parses standard single-quoted wp-config.php", () => {
    const content = `
<?php
define('DB_NAME', 'my_database');
define('DB_USER', 'wp_user');
define('DB_PASSWORD', 'secret123');
define('DB_HOST', 'localhost');
    `;
    expect(parser.parseWpConfig(content)).toEqual({
      dbName: "my_database",
      dbUser: "wp_user",
      dbPassword: "secret123",
      dbHost: "localhost",
    });
  });

  // ─── wp-config.php: double-quote format ───────────────────────────────────

  it("parses double-quoted wp-config.php", () => {
    const content = `
define("DB_NAME", "my_database");
define("DB_USER", "wp_user");
define("DB_PASSWORD", "secret123");
define("DB_HOST", "localhost");
    `;
    expect(parser.parseWpConfig(content)).toEqual({
      dbName: "my_database",
      dbUser: "wp_user",
      dbPassword: "secret123",
      dbHost: "localhost",
    });
  });

  // ─── wp-config.php: extra whitespace ──────────────────────────────────────

  it("handles whitespace variations", () => {
    const content = `
define( 'DB_NAME' , 'spaced_db' );
define( 'DB_USER' , 'spaced_user' );
define( 'DB_PASSWORD' , 'spaced_pass' );
define( 'DB_HOST' , '127.0.0.1' );
    `;
    const result = parser.parseWpConfig(content);
    expect(result?.dbName).toBe("spaced_db");
    expect(result?.dbHost).toBe("127.0.0.1");
  });

  // ─── wp-config.php: special characters in password ────────────────────────

  it("handles passwords with special characters", () => {
    const content = `
define('DB_NAME', 'forge_db');
define('DB_USER', 'forge_user');
define('DB_PASSWORD', 'P@$$w0rd!#&*()-_+=[]{}|;:,.<>?/\`~');
define('DB_HOST', 'db.example.com:3306');
    `;
    const result = parser.parseWpConfig(content);
    expect(result?.dbPassword).toBe("P@$$w0rd!#&*()-_+=[]{}|;:,.<>?/`~");
    expect(result?.dbHost).toBe("db.example.com:3306");
  });

  // ─── wp-config.php: escaped single quote in password ─────────────────────

  it("handles escaped single quote in password", () => {
    const content = `
define('DB_NAME', 'mydb');
define('DB_USER', 'myuser');
define('DB_PASSWORD', 'it\\'s-a-pass');
define('DB_HOST', 'localhost');
    `;
    const result = parser.parseWpConfig(content);
    expect(result?.dbPassword).toBe("it's-a-pass");
  });

  // ─── wp-config.php: mixing define order ───────────────────────────────────

  it("handles defines in any order", () => {
    const content = `
define('DB_HOST', 'localhost');
define('DB_PASSWORD', 'pass');
define('DB_NAME', 'db');
define('DB_USER', 'user');
    `;
    const result = parser.parseWpConfig(content);
    expect(result?.dbName).toBe("db");
    expect(result?.dbUser).toBe("user");
  });

  // ─── wp-config.php: missing credential ───────────────────────────────────

  it("returns null if any credential is missing", () => {
    const content = `
define('DB_NAME', 'mydb');
define('DB_USER', 'user');
    `;
    expect(parser.parseWpConfig(content)).toBeNull();
  });

  // ─── wp-config.php: missing DB_HOST defaults to localhost ─────────────────

  it("defaults DB_HOST to localhost when not defined in wp-config", () => {
    const content = `
define('DB_NAME', 'mydb');
define('DB_USER', 'user');
define('DB_PASSWORD', 'pass');
    `;
    expect(parser.parseWpConfig(content)).toEqual({
      dbName: "mydb",
      dbUser: "user",
      dbPassword: "pass",
      dbHost: "localhost",
    });
  });

  // ─── .env format: unquoted ────────────────────────────────────────────────

  it("parses unquoted .env file", () => {
    const content = `
DB_NAME=mydb
DB_USER=myuser
DB_PASSWORD=mypassword
DB_HOST=localhost
    `;
    expect(parser.parseEnvFile(content)).toEqual({
      dbName: "mydb",
      dbUser: "myuser",
      dbPassword: "mypassword",
      dbHost: "localhost",
    });
  });

  // ─── .env format: quoted values ───────────────────────────────────────────

  it("parses quoted .env file", () => {
    const content = `
DB_NAME="my_database"
DB_USER="wp_user"
DB_PASSWORD="s3cr3t!@#"
DB_HOST="127.0.0.1"
    `;
    const result = parser.parseEnvFile(content);
    expect(result?.dbPassword).toBe("s3cr3t!@#");
    expect(result?.dbHost).toBe("127.0.0.1");
  });

  // ─── .env format: with comments ───────────────────────────────────────────

  it("ignores inline comments in .env", () => {
    const content = `
DB_NAME=mydb # primary database
DB_USER=myuser
DB_PASSWORD=mypass
DB_HOST=localhost
    `;
    const result = parser.parseEnvFile(content);
    expect(result?.dbName).toBe("mydb");
  });

  it("handles unquoted passwords containing # without whitespace", () => {
    const content = `
DB_NAME=mydb
DB_USER=myuser
DB_PASSWORD=secret#123!pass
DB_HOST=localhost
    `;
    const result = parser.parseEnvFile(content);
    expect(result?.dbPassword).toBe("secret#123!pass");
  });

  // ─── .env format: DB_HOST commented out ─────────────────────────────────

  it("defaults DB_HOST to localhost when DB_HOST is commented out", () => {
    const content = `
DB_NAME='test_db'
DB_USER='test_db'
DB_PASSWORD='TestP@ssw0rd123'

# Optional database variables
# DB_HOST='localhost'
DB_PREFIX='wp0m_'

WP_HOME='https://test.example.com'
    `;
    expect(parser.parseEnvFile(content)).toEqual({
      dbName: "test_db",
      dbUser: "test_db",
      dbPassword: "TestP@ssw0rd123",
      dbHost: "localhost",
    });
  });

  // ─── .env format: full Bedrock .env ─────────────────────────────────────

  it("parses a full Bedrock .env file", () => {
    const content = `
DB_NAME='test_db'
DB_USER='test_db'
DB_PASSWORD='TestP@ssw0rd123'

# Optionally, you can use a data source name (DSN)
# When using a DSN, you can remove the DB_NAME, DB_USER, DB_PASSWORD, and DB_HOST variables
# DATABASE_URL='mysql://database_user:database_password@database_host:database_port/database_name'

# Optional database variables
# DB_HOST='localhost'
DB_PREFIX='wp0m_'

WP_ENV=development
WP_HOME='https://test.example.com'
WP_DEBUG=false
WP_DEBUG_DISPLAY=false
WP_DEBUG_LOG=false

AUTH_KEY='kgsX^yzyR;D)3e>rP0]G@$>Om;>725\`i]7_>H.}:&i{+0di(dT9Qw_prT1t*$gQa'
NONCE_KEY='5YGt%VcB=k=={ai]YZA.P7H>jlifP\`RC&Gp.vM{7]crers!9bA(xZ+HE:-$g,D*%'
    `;
    expect(parser.parseEnvFile(content)).toEqual({
      dbName: "test_db",
      dbUser: "test_db",
      dbPassword: "TestP@ssw0rd123",
      dbHost: "localhost",
    });
  });

  // ─── .env format: mixed quotes ────────────────────────────────────────────

  it("handles password with single quote inside double-quoted value", () => {
    const content = `
DB_NAME="mydb"
DB_USER="user"
DB_PASSWORD="it's-a-pass"
DB_HOST="localhost"
    `;
    const result = parser.parseEnvFile(content);
    expect(result?.dbPassword).toBe("it's-a-pass");
  });

  it("handles password with double quote inside single-quoted value", () => {
    const content = `
DB_NAME='mydb'
DB_USER='user'
DB_PASSWORD='say"hello"world'
DB_HOST='localhost'
    `;
    const result = parser.parseEnvFile(content);
    expect(result?.dbPassword).toBe('say"hello"world');
  });

  // ─── .env format: export prefix ───────────────────────────────────────────

  it("handles export prefix in .env files", () => {
    const content = `
export DB_NAME=mydb
export DB_USER=myuser
export DB_PASSWORD=mypassword
export DB_HOST=localhost
    `;
    expect(parser.parseEnvFile(content)).toEqual({
      dbName: "mydb",
      dbUser: "myuser",
      dbPassword: "mypassword",
      dbHost: "localhost",
    });
  });

  it("handles export prefix with quoted values", () => {
    const content = `
export DB_NAME='mydb'
export DB_USER="myuser"
export DB_PASSWORD='P@$$w0rd'
export DB_HOST="localhost"
    `;
    expect(parser.parseEnvFile(content)).toEqual({
      dbName: "mydb",
      dbUser: "myuser",
      dbPassword: "P@$$w0rd",
      dbHost: "localhost",
    });
  });

  // ─── DATABASE_URL format ─────────────────────────────────────────────────

  it("parses DATABASE_URL when individual vars are absent", () => {
    const content = `
DATABASE_URL=mysql://wp_user:secret123@db.example.com:3306/wp_database

WP_HOME='https://example.com'
    `;
    expect(parser.parseEnvFile(content)).toEqual({
      dbName: "wp_database",
      dbUser: "wp_user",
      dbPassword: "secret123",
      dbHost: "db.example.com:3306",
    });
  });

  it("parses DATABASE_URL with URL-encoded password", () => {
    const content = `DATABASE_URL='mysql://user:p%40%24%24w0rd@localhost/mydb'`;
    expect(parser.parseEnvFile(content)).toEqual({
      dbName: "mydb",
      dbUser: "user",
      dbPassword: "p@$$w0rd",
      dbHost: "localhost",
    });
  });

  it("parses DATABASE_URL without port", () => {
    const content = `DATABASE_URL="mysql://admin:pass@localhost/wp_db"`;
    expect(parser.parseEnvFile(content)).toEqual({
      dbName: "wp_db",
      dbUser: "admin",
      dbPassword: "pass",
      dbHost: "localhost",
    });
  });

  it("prefers individual DB vars over DATABASE_URL", () => {
    const content = `
DB_NAME=individual_db
DB_USER=individual_user
DB_PASSWORD=individual_pass
DB_HOST=individual_host
DATABASE_URL=mysql://url_user:url_pass@url_host/url_db
    `;
    expect(parser.parseEnvFile(content)).toEqual({
      dbName: "individual_db",
      dbUser: "individual_user",
      dbPassword: "individual_pass",
      dbHost: "individual_host",
    });
  });

  it("ignores commented-out DATABASE_URL", () => {
    const content = `
DB_NAME='mydb'
DB_USER='user'
DB_PASSWORD='pass'
# DATABASE_URL='mysql://other_user:other_pass@other_host/other_db'
    `;
    expect(parser.parseEnvFile(content)).toEqual({
      dbName: "mydb",
      dbUser: "user",
      dbPassword: "pass",
      dbHost: "localhost",
    });
  });

  // ─── auto-detect ─────────────────────────────────────────────────────────

  it("auto-detects wp-config.php format", () => {
    const content = `define('DB_NAME', 'd'); define('DB_USER', 'u'); define('DB_PASSWORD', 'p'); define('DB_HOST', 'h');`;
    const result = parser.parse(content);
    expect(result?.dbName).toBe("d");
  });

  it("auto-detects .env format fallback", () => {
    const content = `DB_NAME=d\nDB_USER=u\nDB_PASSWORD=p\nDB_HOST=h`;
    const result = parser.parse(content);
    expect(result?.dbName).toBe("d");
  });

  it("auto-detects .env with missing DB_HOST", () => {
    const content = `DB_NAME=d\nDB_USER=u\nDB_PASSWORD=p`;
    expect(parser.parse(content)).toEqual({
      dbName: "d",
      dbUser: "u",
      dbPassword: "p",
      dbHost: "localhost",
    });
  });
});

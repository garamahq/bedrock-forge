#!/usr/bin/env php
<?php
/**
 * backup.php — Bedrock Forge remote backup script
 * Usage: php backup.php --docroot=/var/www/site --type=full|database|files [--output=/tmp/backup.tar.gz]
 * Outputs JSON: {"filename":"/path/to/file","size":12345}
 */

// PHP 7.0+ required (null coalescing operator, scalar type hints, return types)
if (PHP_VERSION_ID < 70000) {
    fwrite(STDERR, "ERROR: PHP 7.0 or newer is required (this server runs PHP " . PHP_VERSION . ")\n");
    exit(1);
}

error_reporting(E_ALL);
set_time_limit(0);

$opts = getopt('', ['docroot:', 'type:', 'output:', 'restore', 'file:', 'db-name:', 'db-user:', 'db-pass:', 'db-host:', 'site-url:', 'mycnf:']);

$docroot = $opts['docroot'] ?? null;
$type    = $opts['type'] ?? 'full';
$output  = $opts['output'] ?? '/tmp/forge_backup_' . time() . '.tar.gz';
$restore = isset($opts['restore']);
$file    = $opts['file'] ?? null;
// Stored credential overrides — used as fallback when on-disk parsing fails
$cliDbName = $opts['db-name'] ?? null;
$cliDbUser = $opts['db-user'] ?? null;
// db-pass is read from the FORGE_DB_PASS environment variable (set by the worker
// as a shell env var prefix, not as argv) to prevent exposure in `ps aux` output.
// Fall back to --db-pass CLI arg for backward compatibility only.
$cliDbPass = (getenv('FORGE_DB_PASS') !== false ? getenv('FORGE_DB_PASS') : null) ?? ($opts['db-pass'] ?? null);
$cliDbHost = $opts['db-host'] ?? null;
$cliSiteUrl = $opts['site-url'] ?? null;

// Parse mycnf override if supplied to avoid command-line argument exposure
$mycnf = $opts['mycnf'] ?? null;
if ($mycnf && file_exists($mycnf)) {
    $ini = parse_ini_file($mycnf, true);
    $section = isset($ini['client']) ? $ini['client'] : (isset($ini['mysql']) ? $ini['mysql'] : $ini);
    if (!empty($section['user'])) $cliDbUser = $section['user'];
    if (!empty($section['password'])) $cliDbPass = $section['password'];
    if (!empty($section['host'])) $cliDbHost = $section['host'];
    if (!empty($section['database'])) $cliDbName = $section['database'];
}

if (!$docroot || !is_dir($docroot)) {
    fwrite(STDERR, "ERROR: Invalid or missing --docroot\n");
    exit(1);
}

if ($restore) {
    if (!$file || !file_exists($file)) {
        fwrite(STDERR, "ERROR: --file must point to an existing backup archive\n");
        exit(1);
    }

    // ── Wipe the existing docroot before extracting ────────────────────────
    // Deleting the docroot first guarantees the result is an exact mirror of
    // the backup. We only delete AFTER confirming the archive file exists.
    if (is_dir($docroot)) {
        // Step 0: remove any immutable or append-only attributes that may have been set for security
        exec('chattr -R -i -a ' . escapeshellarg($docroot) . ' 2>/dev/null || true');
        // Step 1: ensure all directories and files are writable by current user
        exec('find ' . escapeshellarg($docroot) . ' -type d -exec chmod 755 {} + 2>/dev/null; find ' . escapeshellarg($docroot) . ' -type f -exec chmod 644 {} + 2>/dev/null; chmod -R u+w ' . escapeshellarg($docroot) . ' 2>/dev/null || true');
        $rmOut  = [];
        $rmCode = 0;
        exec('rm -rf ' . escapeshellarg($docroot) . ' 2>&1', $rmOut, $rmCode);
        if ($rmCode !== 0) {
            // Secondary attempt: wipe contents inside if docroot folder itself is locked
            exec('rm -rf ' . escapeshellarg($docroot) . '/* ' . escapeshellarg($docroot) . '/.[!.]* 2>/dev/null || true');
            fwrite(STDERR, "WARNING: could not completely wipe docroot before restore (exit {$rmCode}) — will overwrite during extraction.\n");
        } else {
            fwrite(STDERR, "Cleaned docroot before restore: {$docroot}\n");
        }
    }

    // Extract to the PARENT of docroot.
    // Archives are created with: tar -C dirname(docroot) basename(docroot)
    // so every file inside is stored as  basename/path/to/file.php
    // Extracting to dirname(docroot) restores files to the correct location.
    $extractTo = dirname($docroot);
    // Flags explanation:
    // --no-same-owner: do not try to chown to archived UID/GID (prevents exit 2 on non-root or differing server UIDs)
    // --no-same-permissions: do not copy restrictive file modes from archive
    // --touch: do not fail on timestamp updates (prevents utime: Operation not permitted)
    // --unlink-first: remove each existing file before writing to prevent EPERM/EACCES on 0440 files (mutually exclusive with --overwrite in tar)
    // --warning=no-timestamp: suppress timestamp warnings
    $tarFlags = '--no-same-owner --no-same-permissions --touch --unlink-first --warning=no-timestamp';
    $cmd = "tar -xzf " . escapeshellarg($file) . " -C " . escapeshellarg($extractTo) . " " . $tarFlags . " 2>&1";
    exec($cmd, $out, $code);
    if ($code > 0) {
        $nonFatal = true;
        foreach ($out as $line) {
            $line = trim($line);
            if (empty($line)) continue;
            if (stripos($line, 'Cannot utime') !== false ||
                stripos($line, 'Cannot change ownership') !== false ||
                stripos($line, 'Cannot change mode') !== false ||
                stripos($line, 'time stamp') !== false ||
                stripos($line, 'Exiting with failure status') !== false) {
                continue;
            }
            $nonFatal = false;
            break;
        }

        if ($nonFatal && is_dir($docroot)) {
            fwrite(STDERR, "WARNING: tar exited {$code} with non-fatal attribute warnings — proceeding with restore: " . implode(" | ", array_slice($out, 0, 5)) . "\n");
        } else {
            fwrite(STDERR, "ERROR: restore (files) failed (exit {$code}): " . implode("\n", $out) . "\n");
            exit($code);
        }
    }

    // ── Database import ────────────────────────────────────────────────────
    // The archive places forge_db_*.sql at the $extractTo level (same level
    // as the docroot directory itself).  Import it if found.
    $dbImported = false;
    $sqlFiles   = glob($extractTo . '/forge_db_*.sql');

    if (!empty($sqlFiles)) {
        $sqlFile = $sqlFiles[0];

        // Resolve credentials: CLI inputs override on-disk config during restore.
        $creds = parseWpConfig($docroot);
        if ($cliDbName && $cliDbUser && $cliDbPass && $cliDbHost) {
            $creds['DB_NAME']     = $cliDbName;
            $creds['DB_USER']     = $cliDbUser;
            $creds['DB_PASSWORD'] = $cliDbPass;
            $creds['DB_HOST']     = $cliDbHost;

            // Write back to config files — unlock write permission first
            $envFile = $docroot . '/.env';
            if (file_exists($envFile)) {
                @chmod($envFile, 0644);
                $envContent = file_get_contents($envFile);
                $envContent = preg_replace("/^DB_NAME\s*=.*/m", "DB_NAME='{$cliDbName}'", $envContent);
                $envContent = preg_replace("/^DB_USER\s*=.*/m", "DB_USER='{$cliDbUser}'", $envContent);
                $envContent = preg_replace("/^DB_PASSWORD\s*=.*/m", "DB_PASSWORD='{$cliDbPass}'", $envContent);
                $envContent = preg_replace("/^DB_HOST\s*=.*/m", "DB_HOST='{$cliDbHost}'", $envContent);
                if ($cliSiteUrl) {
                    $envContent = preg_replace("/^WP_HOME\s*=.*/m", "WP_HOME='{$cliSiteUrl}'", $envContent);
                    $envContent = preg_replace("/^WP_SITEURL\s*=.*/m", "WP_SITEURL='{$cliSiteUrl}/wp'", $envContent);
                }
                file_put_contents($envFile, $envContent);
            } else {
                $configFile = $docroot . '/wp-config.php';
                if (!file_exists($configFile)) {
                    $configFile = $docroot . '/config/application.php';
                }
                if (file_exists($configFile)) {
                    @chmod($configFile, 0644);
                    $configContent = file_get_contents($configFile);
                    $configContent = preg_replace("/define\s*\(\s*['\"]DB_NAME['\"]\s*,\s*['\"][^'\"]*['\"]\s*\)/", "define('DB_NAME', '{$cliDbName}')", $configContent);
                    $configContent = preg_replace("/define\s*\(\s*['\"]DB_USER['\"]\s*,\s*['\"][^'\"]*['\"]\s*\)/", "define('DB_USER', '{$cliDbUser}')", $configContent);
                    $configContent = preg_replace("/define\s*\(\s*['\"]DB_PASSWORD['\"]\s*,\s*['\"][^'\"]*['\"]\s*\)/", "define('DB_PASSWORD', '{$cliDbPass}')", $configContent);
                    $configContent = preg_replace("/define\s*\(\s*['\"]DB_HOST['\"]\s*,\s*['\"][^'\"]*['\"]\s*\)/", "define('DB_HOST', '{$cliDbHost}')", $configContent);

                    $configContent = preg_replace("/Config::define\s*\(\s*['\"]DB_NAME['\"]\s*,\s*['\"][^'\"]*['\"]\s*\)/", "Config::define('DB_NAME', '{$cliDbName}')", $configContent);
                    $configContent = preg_replace("/Config::define\s*\(\s*['\"]DB_USER['\"]\s*,\s*['\"][^'\"]*['\"]\s*\)/", "Config::define('DB_USER', '{$cliDbUser}')", $configContent);
                    $configContent = preg_replace("/Config::define\s*\(\s*['\"]DB_PASSWORD['\"]\s*,\s*['\"][^'\"]*['\"]\s*\)/", "Config::define('DB_PASSWORD', '{$cliDbPass}')", $configContent);
                    $configContent = preg_replace("/Config::define\s*\(\s*['\"]DB_HOST['\"]\s*,\s*['\"][^'\"]*['\"]\s*\)/", "Config::define('DB_HOST', '{$cliDbHost}')", $configContent);
                    file_put_contents($configFile, $configContent);
                }
            }
        }

        $canImport = !empty($creds['DB_NAME']) && !empty($creds['DB_USER'])
            && !empty($creds['DB_PASSWORD']) && !empty($creds['DB_HOST']);

        if ($canImport) {
            $dbHost = $creds['DB_HOST'];
            $dbPort = '';
            if (strpos($dbHost, ':') !== false) {
                [$dbHost, $hostPort] = explode(':', $dbHost, 2);
                $dbPort = ' --port=' . (int)$hostPort;
            } elseif (!empty($creds['DB_PORT'])) {
                $dbPort = ' --port=' . (int)$creds['DB_PORT'];
            }

            // Write temp .my.cnf — avoids all shell-quoting issues with passwords
            $mycnfFile = tempnam(sys_get_temp_dir(), 'forge_rstore_mycnf_');
            file_put_contents($mycnfFile, "[client]\nuser={$creds['DB_USER']}\npassword={$creds['DB_PASSWORD']}\nhost={$dbHost}\n");
            chmod($mycnfFile, 0600);

            $importCmd = sprintf(
                'mysql --defaults-extra-file=%s%s %s < %s 2>&1',
                escapeshellarg($mycnfFile),
                $dbPort,
                escapeshellarg($creds['DB_NAME']),
                escapeshellarg($sqlFile)
            );
            exec($importCmd, $importOut, $importCode);
            @unlink($mycnfFile);

            if ($importCode !== 0) {
                fwrite(STDERR, "ERROR: DB import failed (exit {$importCode}): " . implode("\n", $importOut) . "\n");
                @unlink($sqlFile);
                exit($importCode);
            } else {
                $dbImported = true;
                fwrite(STDERR, "DB imported: {$creds['DB_NAME']} from " . basename($sqlFile) . "\n");
            }
        } else {
            fwrite(STDERR, "WARNING: SQL dump found but DB credentials could not be resolved — skipping DB import\n");
        }

        @unlink($sqlFile); // clean up extracted dump regardless of import success
    }

    // ── Fix file ownership (CyberPanel pattern) ────────────────────────────
    // CyberPanel expects:
    //   - docroot folder itself → user:nogroup  mode 750  (drwxr-x---)
    // ── Fix file ownership & permissions ──────────────────────────────────
    fixSiteOwnershipAndPermissions($docroot);

    echo json_encode(['status' => 'restored', 'file' => $file, 'db_imported' => $dbImported]);
    exit(0);
}

/**
 * Robustly detect site user and web server group, unlock immutable attributes,
 * and enforce secure file ownership and permissions across WordPress/Bedrock.
 */
function fixSiteOwnershipAndPermissions(string $docroot): array {
    $root = rtrim($docroot, '/');
    $parentDir = dirname($root);

    // 1. Detect Owner (parentDir -> docroot -> path user -> inner files -> common fallback)
    $owner = null;
    exec('stat -c %U ' . escapeshellarg($parentDir) . ' 2>/dev/null', $pOut, $pCode);
    if ($pCode === 0 && !empty($pOut[0]) && trim($pOut[0]) !== 'root' && preg_match('/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/', trim($pOut[0]))) {
        $owner = trim($pOut[0]);
    }
    if (!$owner) {
        exec('stat -c %U ' . escapeshellarg($root) . ' 2>/dev/null', $sOut, $sCode);
        if ($sCode === 0 && !empty($sOut[0]) && trim($sOut[0]) !== 'root' && preg_match('/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/', trim($sOut[0]))) {
            $owner = trim($sOut[0]);
        }
    }
    if (!$owner && preg_match('#/home/([^/]+)#', $root, $m)) {
        $cand = $m[1];
        if (preg_match('/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/', $cand)) {
            exec('id -u ' . escapeshellarg($cand) . ' 2>/dev/null', $uOut, $uCode);
            if ($uCode === 0) {
                $owner = $cand;
            }
        }
    }
    if (!$owner) {
        exec('find ' . escapeshellarg($root) . ' -maxdepth 3 ! -user root -printf "%u\n" 2>/dev/null | head -1', $fOut, $fCode);
        if ($fCode === 0 && !empty($fOut[0]) && trim($fOut[0]) !== 'root' && preg_match('/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/', trim($fOut[0]))) {
            $owner = trim($fOut[0]);
        }
    }
    if (!$owner) {
        foreach (['www-data', 'nginx', 'apache'] as $fallbackUser) {
            exec('id -u ' . escapeshellarg($fallbackUser) . ' 2>/dev/null', $fbOut, $fbCode);
            if ($fbCode === 0) {
                $owner = $fallbackUser;
                break;
            }
        }
    }

    // 2. Detect Web Group (nogroup on Debian/Ubuntu OLS, nobody on RHEL/CentOS/AlmaLinux OLS, www-data, etc.)
    $webGroup = $owner ?: 'nogroup';
    exec('for g in nogroup nobody www-data nginx apache; do if getent group "$g" >/dev/null 2>&1; then echo "$g"; exit 0; fi; done; echo ' . escapeshellarg($owner ?: 'root'), $gOut, $gCode);
    if ($gCode === 0 && !empty($gOut[0]) && trim($gOut[0])) {
        $webGroup = trim($gOut[0]);
    }

    // 3. Unlock & apply standard directory / file permissions
    exec('chattr -R -i -a ' . escapeshellarg($root) . ' 2>/dev/null || true');
    exec('chmod -R u+w ' . escapeshellarg($root) . ' 2>/dev/null || true');
    exec('find ' . escapeshellarg($root) . ' -type d -exec chmod 755 {} + 2>/dev/null');
    exec('find ' . escapeshellarg($root) . ' -type f -exec chmod 644 {} + 2>/dev/null');

    if ($owner) {
        // Step 1: inner contents -> owner:owner (recursive)
        exec('chown -R ' . escapeshellarg($owner . ':' . $owner) . ' ' . escapeshellarg($root) . ' 2>&1');
        // Step 2: docroot folder -> owner:webGroup (non-recursive)
        exec('chown ' . escapeshellarg($owner . ':' . $webGroup) . ' ' . escapeshellarg($root) . ' 2>&1');
        // Step 3: enforce 750 on docroot
        exec('chmod 750 ' . escapeshellarg($root) . ' 2>&1');
    }

    // Step 4: Secure sensitive config files (chmod 440)
    $sensitiveConfigs = [
        $root . '/wp-config.php',
        $root . '/web/wp-config.php',
        $root . '/.env',
        $root . '/web/.env',
        $root . '/.env.local',
        $root . '/web/.env.local',
        $root . '/config/application.php',
    ];
    foreach ($sensitiveConfigs as $cfg) {
        if (file_exists($cfg)) {
            if ($owner) {
                exec('chown ' . escapeshellarg($owner . ':' . $webGroup) . ' ' . escapeshellarg($cfg) . ' 2>/dev/null || true');
            }
            exec('chmod 440 ' . escapeshellarg($cfg) . ' 2>/dev/null || true');
        }
    }

    // Step 5: Ensure uploads & cache directories are 755 and owned by user
    foreach ([$root . '/wp-content/uploads', $root . '/web/app/uploads', $root . '/wp-content/cache', $root . '/web/app/cache', $root . '/storage'] as $upDir) {
        if (is_dir($upDir)) {
            exec('chmod 755 ' . escapeshellarg($upDir) . ' 2>/dev/null || true');
            if ($owner) {
                exec('chown -R ' . escapeshellarg($owner . ':' . $owner) . ' ' . escapeshellarg($upDir) . ' 2>/dev/null || true');
            }
        }
    }

    if ($owner) {
        fwrite(STDERR, "Fixed ownership: {$owner}:{$webGroup} on {$root}, {$owner}:{$owner} on contents (755/644), 440 on configs\n");
    } else {
        fwrite(STDERR, "Applied safe permissions on {$root} (750 docroot, 755 dirs, 644 files, 440 configs)\n");
    }

    return ['owner' => $owner, 'webGroup' => $webGroup];
}

// Parse DB credentials — tries Bedrock .env first, then wp-config.php, then config/application.php
function parseWpConfig(string $docroot): array {
    // 1. Bedrock .env (most common for this tool)
    $envFile = $docroot . '/.env';
    if (file_exists($envFile)) {
        $creds = parseEnvFile($envFile);
        if (!empty($creds['DB_NAME'])) return $creds;
    }

    // 2. Standard wp-config.php
    $configFile = $docroot . '/wp-config.php';
    if (!file_exists($configFile)) {
        // 3. Bedrock config/application.php
        $configFile = $docroot . '/config/application.php';
    }
    if (!file_exists($configFile)) return [];

    $content = file_get_contents($configFile);
    $creds = [];
    foreach (['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST'] as $const) {
        if (preg_match("/define\s*\(\s*['\"]" . $const . "['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)/", $content, $m)) {
            // Standard wp-config.php: define('DB_NAME', 'value')
            $creds[$const] = $m[1];
        } elseif (preg_match("/Config::define\s*\(\s*['\"]" . $const . "['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)/", $content, $m)) {
            // Bedrock config/application.php: Config::define('DB_NAME', 'value')
            $creds[$const] = $m[1];
        } elseif (preg_match("/" . $const . "\s*=\s*['\"]([^'\"]+)['\"]/", $content, $m)) {
            // Assignment style: DB_NAME = 'value'
            $creds[$const] = $m[1];
        }
    }
    return $creds;
}

/**
 * Parse a .env file for DB credentials.
 * Handles KEY=value, KEY='value', KEY="value" formats.
 */
function parseEnvFile(string $path): array {
    $creds = [];
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines === false) return [];
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#') continue;
        if (strpos($line, '=') === false) continue;
        // Strip optional `export ` prefix (common in some shell-sourced .env files)
        if (strncasecmp($line, 'export ', 7) === 0) {
            $line = ltrim(substr($line, 7));
        }
        list($key, $value) = explode('=', $line, 2);
        $key   = trim($key);
        $value = trim($value);
        // Strip surrounding quotes
        if (strlen($value) >= 2) {
            $first = $value[0];
            $last  = $value[strlen($value) - 1];
            if (($first === '"' && $last === '"') || ($first === "'" && $last === "'")) {
                $value = substr($value, 1, -1);
            }
        }
        if (in_array($key, ['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST', 'DB_PORT'], true)) {
            $creds[$key] = $value;
        }
    }
    // Fallback: parse DATABASE_URL (mysql://user:pass@host/dbname) when individual vars are absent
    if (empty($creds['DB_NAME'])) {
        $rawLines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if ($rawLines !== false) {
            foreach ($rawLines as $rawLine) {
                $rawLine = trim($rawLine);
                if (strncmp($rawLine, 'DATABASE_URL=', 13) === 0) {
                    $url    = trim(substr($rawLine, 13), " \t\"'");
                    $parsed = parse_url($url);
                    if ($parsed !== false && isset($parsed['path'])) {
                        if (!empty($parsed['user'])) $creds['DB_USER']     = urldecode($parsed['user']);
                        if (!empty($parsed['pass'])) $creds['DB_PASSWORD'] = urldecode($parsed['pass']);
                        if (!empty($parsed['host'])) $creds['DB_HOST']     = $parsed['host'];
                        if (!empty($parsed['path'])) $creds['DB_NAME']     = ltrim($parsed['path'], '/');
                        if (!empty($parsed['port'])) $creds['DB_PORT']     = (string)$parsed['port'];
                    }
                    break;
                }
            }
        }
    }
    // Default DB_HOST to localhost if not set
    if (!empty($creds['DB_NAME']) && empty($creds['DB_HOST'])) {
        $creds['DB_HOST'] = 'localhost';
    }
    return $creds;
}

$parts        = [];
$dbDumpFile   = null;
$isIncremental = ($type === 'incremental');

if ($type === 'full' || $type === 'db_only' || $isIncremental) {
    $creds = parseWpConfig($docroot);

    // Determine credential source for diagnostic logging
    $credSource = 'filesystem';

    // If filesystem parsing is incomplete and CLI credential overrides were supplied
    // (passed by the worker from stored encrypted credentials), use them as fallback.
    $missingCred = false;
    foreach (['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST'] as $required) {
        if (empty($creds[$required])) { $missingCred = true; break; }
    }
    if ($missingCred && $cliDbName && $cliDbUser && $cliDbPass && $cliDbHost) {
        $creds['DB_NAME']     = $cliDbName;
        $creds['DB_USER']     = $cliDbUser;
        $creds['DB_PASSWORD'] = $cliDbPass;
        $creds['DB_HOST']     = $cliDbHost;
        $credSource = 'stored (CLI fallback)';
    }

    // Validate all required credentials are present before attempting mysqldump
    foreach (['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST'] as $required) {
        if (empty($creds[$required])) {
            fwrite(STDERR, "ERROR: Missing or empty credential '{$required}'. Checked .env, wp-config.php, and config/application.php under {$docroot}\n");
            exit(1);
        }
    }

    // Log credential source and identity for diagnostics (never log the password)
    fwrite(STDERR, "DB creds source={$credSource} user={$creds['DB_USER']} db={$creds['DB_NAME']} host={$creds['DB_HOST']}\n");

    $dbDumpFile = sys_get_temp_dir() . '/forge_db_' . time() . '.sql';
    $stderrFile = sys_get_temp_dir() . '/forge_db_err_' . time() . '.txt';

    // Handle DB_HOST containing an embedded port (e.g. localhost:3307).
    $dbHost = $creds['DB_HOST'];
    $dbPort = '';
    if (strpos($dbHost, ':') !== false) {
        [$dbHost, $hostPort] = explode(':', $dbHost, 2);
        $dbPort = ' --port=' . (int)$hostPort;
    } elseif (!empty($creds['DB_PORT'])) {
        $dbPort = ' --port=' . (int)$creds['DB_PORT'];
    }

    // ── Use --defaults-extra-file to pass credentials to mysqldump ──────────
    // Writing credentials to a temporary .my.cnf avoids ALL shell escaping
    // issues with special characters (!@^$`" etc.) in passwords. The file is
    // read directly by the mysqldump binary — no shell interpretation, no
    // MYSQL_PWD env var leaking into the process list.
    $mycnfFile = tempnam(sys_get_temp_dir(), 'forge_mycnf_');
    $mycnfContent = "[client]\n"
        . "user=" . $creds['DB_USER'] . "\n"
        . "password=" . $creds['DB_PASSWORD'] . "\n"
        . "host=" . $dbHost . "\n";
    file_put_contents($mycnfFile, $mycnfContent);
    chmod($mycnfFile, 0600);

    $cmd = sprintf(
        'mysqldump --defaults-extra-file=%s%s --single-transaction --quick %s > %s 2>%s',
        escapeshellarg($mycnfFile),
        $dbPort,
        escapeshellarg($creds['DB_NAME']),
        escapeshellarg($dbDumpFile),
        escapeshellarg($stderrFile)
    );
    exec($cmd, $out, $code);
    @unlink($mycnfFile);  // always clean up credentials file
    if ($code !== 0) {
        $errDetail = file_exists($stderrFile) ? trim(file_get_contents($stderrFile)) : implode("\n", $out);
        @unlink($stderrFile);
        fwrite(STDERR, "ERROR: mysqldump failed (exit {$code}): {$errDetail}\n");
        exit($code);
    }
    @unlink($stderrFile);
    $parts[] = $dbDumpFile;
}

$basename = basename($docroot);
$cacheDir = null;

if ($isIncremental) {
    $parentDir = dirname($docroot);
    $cacheDir = $parentDir . '/.forge_backup_cache';
    if (!is_dir($cacheDir)) {
        if (!mkdir($cacheDir, 0755, true)) {
            fwrite(STDERR, "ERROR: Could not create incremental backup cache directory: {$cacheDir}\n");
            exit(1);
        }
    }

    $latestDir = $cacheDir . '/latest/' . $basename;
    $currentDir = $cacheDir . '/current/' . $basename;

    @mkdir($cacheDir . '/latest', 0755, true);
    @mkdir($cacheDir . '/current', 0755, true);

    $rsyncFlags = '-a --delete';
    if (is_dir($latestDir)) {
        $rsyncFlags .= ' --link-dest=' . escapeshellarg($latestDir);
    }

    $rsyncCmd = "rsync {$rsyncFlags} " . escapeshellarg($docroot . '/') . ' ' . escapeshellarg($currentDir . '/');
    fwrite(STDERR, "Executing incremental rsync: {$rsyncCmd}\n");
    exec($rsyncCmd . ' 2>&1', $rsyncOut, $rsyncCode);
    if ($rsyncCode !== 0) {
        fwrite(STDERR, "ERROR: Incremental rsync failed (exit {$rsyncCode}): " . implode("\n", $rsyncOut) . "\n");
        exec('rm -rf ' . escapeshellarg($cacheDir . '/current'));
        exit($rsyncCode);
    }
}

// Exclude volatile cache and temporary directories from backup archive
$tarExcludes = [
    '--exclude="*/cache/*"',
    '--exclude="*/et-cache/*"',
    '--exclude="*/et_temp/*"',
    '--exclude="*/elementor/css/*"',
    '--exclude="*/litespeed/*"',
    '--exclude="*/node_modules/*"',
    '--exclude="*/storage/framework/cache/*"',
    '--exclude="*/.forge_backup_cache/*"',
];
$excludeFlags = ' ' . implode(' ', $tarExcludes) . ' ';

// Use pigz (parallel gzip) when available for faster compression on multi-core
// servers. Falls back to standard gzip transparently.
$pigz = trim(shell_exec('which pigz 2>/dev/null') ?? '');
if ($pigz) {
    $tarCmd = 'tar --use-compress-program=' . escapeshellarg($pigz) . $excludeFlags . '-cf ' . escapeshellarg($output);
} else {
    $tarCmd = 'tar -czf ' . escapeshellarg($output) . $excludeFlags;
}

if ($type === 'full' || $type === 'files_only') {
    $tarCmd .= ' -C ' . escapeshellarg(dirname($docroot)) . ' ' . escapeshellarg(basename($docroot));
} elseif ($isIncremental) {
    $tarCmd .= ' -C ' . escapeshellarg($cacheDir . '/current') . ' ' . escapeshellarg(basename($docroot));
}

foreach ($parts as $part) {
    $tarCmd .= ' -C ' . escapeshellarg(dirname($part)) . ' ' . escapeshellarg(basename($part));
}

exec($tarCmd . ' 2>&1', $out, $code);

// Cleanup temp SQL dump
if ($dbDumpFile && file_exists($dbDumpFile)) {
    unlink($dbDumpFile);
}

// tar exit code 1 = "file changed as we read it" — a harmless warning that
// occurs when the site receives traffic during the backup. The archive is still
// valid and complete. Only exit codes >= 2 indicate a real failure.
if ($code > 1) {
    if ($isIncremental && $cacheDir) {
        exec('rm -rf ' . escapeshellarg($cacheDir . '/current'));
    }
    fwrite(STDERR, "ERROR: tar failed (exit {$code}): " . implode("\n", $out) . "\n");
    exit($code);
}
if ($code === 1) {
    fwrite(STDERR, "WARNING: tar exited 1 (file changed during read) — backup archive is still valid\n");
}

if ($isIncremental && $cacheDir) {
    // Promote current to latest
    exec('rm -rf ' . escapeshellarg($cacheDir . '/latest'));
    @mkdir($cacheDir . '/latest', 0755, true);
    exec('mv ' . escapeshellarg($cacheDir . '/current/' . $basename) . ' ' . escapeshellarg($cacheDir . '/latest/' . $basename));
    exec('rm -rf ' . escapeshellarg($cacheDir . '/current'));
}

$size = file_exists($output) ? filesize($output) : 0;
echo json_encode(['filename' => $output, 'size' => $size]);
exit(0);

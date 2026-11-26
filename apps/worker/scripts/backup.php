#!/usr/bin/env php
<?php
/**
 * backup.php — Bedrock Forge remote backup script
 * Usage: php backup.php --docroot=/var/www/site --type=full|database|files [--output=/tmp/backup.tar.gz] [--staging-dir=/tmp]
 * Outputs JSON: {"filename":"/path/to/file","size":12345,"archive_verified":true,"consistent":true,"warnings":{"benign_files":[],"critical_files":[]}}
 */

// PHP 7.0+ required (null coalescing operator, scalar type hints, return types)
if (PHP_VERSION_ID < 70000) {
    fwrite(STDERR, "ERROR: PHP 7.0 or newer is required (this server runs PHP " . PHP_VERSION . ")\n");
    exit(1);
}

error_reporting(E_ALL);
@ini_set('display_errors', 'stderr');
@ini_set('log_errors', '1');
set_time_limit(0);

// Keep STDOUT clean for machine-parsed JSON output by forwarding any PHP warnings/notices to STDERR.
set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    fwrite(STDERR, "[PHP notice/warning] {$message} in {$file}:{$line}\n");
    return true;
});

$opts = getopt('', [
    'docroot:',
    'type:',
    'output:',
    'staging-dir:',
    'restore',
    'file:',
    'db-name:',
    'db-user:',
    'db-pass:',
    'db-host:',
    'site-url:',
    'mycnf:',
]);

$runToken = date('Ymd_His') . '_' . bin2hex(random_bytes(8));

$docroot = $opts['docroot'] ?? null;
$type    = $opts['type'] ?? 'full';
$hasExplicitOutput = !empty($opts['output']) && is_string($opts['output']);
$output  = $hasExplicitOutput
    ? $opts['output']
    : rtrim(sys_get_temp_dir(), '/') . '/forge_backup_' . $runToken . '.tar.gz';

$stagingBase = (!empty($opts['staging-dir']) && is_string($opts['staging-dir']))
    ? rtrim($opts['staging-dir'], '/')
    : rtrim(sys_get_temp_dir(), '/');
if ($stagingBase === '' || $stagingBase[0] !== '/') {
    fwrite(STDERR, "ERROR: --staging-dir must be an absolute path\n");
    exit(1);
}
if (!is_dir($stagingBase) && !@mkdir($stagingBase, 0700, true)) {
    fwrite(STDERR, "ERROR: Unable to create staging directory: {$stagingBase}\n");
    exit(1);
}

$runStageDir = $stagingBase . '/forge_stage_' . $runToken;
if (!@mkdir($runStageDir, 0700, true)) {
    fwrite(STDERR, "ERROR: Unable to create private run staging directory: {$runStageDir}\n");
    exit(1);
}
@chmod($runStageDir, 0700);

$forgeCleanupState = [
    'stageDir' => $runStageDir,
    'mycnf' => null,
    'runCacheRoot' => null,
    'output' => $hasExplicitOutput ? $output : null,
    'succeeded' => false,
];

register_shutdown_function(static function () use (&$forgeCleanupState): void {
    if (!empty($forgeCleanupState['mycnf']) && file_exists($forgeCleanupState['mycnf'])) {
        @unlink($forgeCleanupState['mycnf']);
    }
    if (!empty($forgeCleanupState['stageDir']) && is_dir($forgeCleanupState['stageDir'])) {
        exec('rm -rf ' . escapeshellarg($forgeCleanupState['stageDir']) . ' 2>/dev/null || true');
    }
    if (!$forgeCleanupState['succeeded']) {
        if (!empty($forgeCleanupState['runCacheRoot']) && is_dir($forgeCleanupState['runCacheRoot'])) {
            exec('rm -rf ' . escapeshellarg($forgeCleanupState['runCacheRoot']) . ' 2>/dev/null || true');
        }
        if (!empty($forgeCleanupState['output']) && file_exists($forgeCleanupState['output'])) {
            @unlink($forgeCleanupState['output']);
        }
    }
});

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

$docrootTrimmed = is_string($docroot) ? rtrim($docroot, '/') : '';
$isSymlinkDocroot = false;
$resolvedDocroot = $docrootTrimmed;
$logicalBasename = '';
$physicalBasename = '';

if (!$restore) {
    if (!$docrootTrimmed || $docrootTrimmed[0] !== '/') {
        fwrite(STDERR, "ERROR: Invalid or missing --docroot\n");
        exit(1);
    }
    if (is_link($docrootTrimmed)) {
        $real = realpath($docrootTrimmed);
        if ($real === false || !is_dir($real)) {
            fwrite(STDERR, "ERROR: --docroot is a broken symlink ({$docrootTrimmed})\n");
            exit(1);
        }
        $isSymlinkDocroot = true;
        $resolvedDocroot = $real;
    } elseif (!is_dir($docrootTrimmed)) {
        fwrite(STDERR, "ERROR: Invalid or missing --docroot (directory does not exist)\n");
        exit(1);
    } else {
        $resolvedDocroot = realpath($docrootTrimmed) ?: $docrootTrimmed;
    }
    $logicalBasename = basename($docrootTrimmed);
    $physicalBasename = basename($resolvedDocroot);
} else {
    if (!$docroot || !is_string($docroot) || strlen(trim($docroot)) < 2 || $docroot[0] !== '/') {
        fwrite(STDERR, "ERROR: Invalid or missing --docroot (must be an absolute path)\n");
        exit(1);
    }
    $extractTo = dirname($docrootTrimmed);
    if (!is_dir($extractTo)) {
        @mkdir($extractTo, 0755, true);
    }
    if (!is_dir($extractTo)) {
        fwrite(STDERR, "ERROR: Parent directory {$extractTo} does not exist and could not be created\n");
        exit(1);
    }
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
    $extractTo = dirname($docrootTrimmed);
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

            // Write temp .my.cnf inside private 0700 stage dir with 0600 permissions
            $mycnfFile = $runStageDir . '/forge_restore_mycnf_' . $runToken . '.cnf';
            file_put_contents($mycnfFile, "[client]\nuser={$creds['DB_USER']}\npassword={$creds['DB_PASSWORD']}\nhost={$dbHost}\n");
            chmod($mycnfFile, 0600);
            $forgeCleanupState['mycnf'] = $mycnfFile;

            $importCmd = sprintf(
                'mysql --defaults-extra-file=%s%s %s < %s 2>&1',
                escapeshellarg($mycnfFile),
                $dbPort,
                escapeshellarg($creds['DB_NAME']),
                escapeshellarg($sqlFile)
            );
            exec($importCmd, $importOut, $importCode);
            @unlink($mycnfFile);
            $forgeCleanupState['mycnf'] = null;

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

        @unlink($sqlFile);
    }

    fixSiteOwnershipAndPermissions($docroot);

    $forgeCleanupState['succeeded'] = true;
    echo json_encode(['status' => 'restored', 'file' => $file, 'db_imported' => $dbImported]) . "\n";
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

    // 2. Detect Web Group
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
        exec('chown -R ' . escapeshellarg($owner . ':' . $owner) . ' ' . escapeshellarg($root) . ' 2>&1');
        exec('chown ' . escapeshellarg($owner . ':' . $webGroup) . ' ' . escapeshellarg($root) . ' 2>&1');
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
    $envFile = $docroot . '/.env';
    if (file_exists($envFile)) {
        $creds = parseEnvFile($envFile);
        if (!empty($creds['DB_NAME'])) return $creds;
    }

    $configFile = $docroot . '/wp-config.php';
    if (!file_exists($configFile)) {
        $configFile = $docroot . '/config/application.php';
    }
    if (!file_exists($configFile)) return [];

    $content = file_get_contents($configFile);
    $creds = [];
    foreach (['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST'] as $const) {
        if (preg_match("/define\s*\(\s*['\"]" . $const . "['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)/", $content, $m)) {
            $creds[$const] = $m[1];
        } elseif (preg_match("/Config::define\s*\(\s*['\"]" . $const . "['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)/", $content, $m)) {
            $creds[$const] = $m[1];
        } elseif (preg_match("/" . $const . "\s*=\s*['\"]([^'\"]+)['\"]/", $content, $m)) {
            $creds[$const] = $m[1];
        }
    }
    return $creds;
}

/**
 * Parse a .env file for DB credentials.
 */
function parseEnvFile(string $path): array {
    $creds = [];
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines === false) return [];
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#') continue;
        if (strpos($line, '=') === false) continue;
        if (strncasecmp($line, 'export ', 7) === 0) {
            $line = ltrim(substr($line, 7));
        }
        list($key, $value) = explode('=', $line, 2);
        $key   = trim($key);
        $value = trim($value);
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
    if (!empty($creds['DB_NAME']) && empty($creds['DB_HOST'])) {
        $creds['DB_HOST'] = 'localhost';
    }
    return $creds;
}

function estimateMysqlBytes(string $mycnfFile, string $dbPort, string $dbName): int {
    $query = sprintf(
        "SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.TABLES WHERE table_schema='%s'",
        str_replace("'", "''", $dbName)
    );
    $cmd = sprintf(
        'mysql --defaults-extra-file=%s%s -N -s -e %s 2>/dev/null',
        escapeshellarg($mycnfFile),
        $dbPort,
        escapeshellarg($query)
    );
    exec($cmd, $qOut, $qCode);
    if ($qCode === 0 && isset($qOut[0]) && is_numeric(trim($qOut[0]))) {
        return (int)trim($qOut[0]);
    }
    return 0;
}

function estimateDirectoryBytes(string $path): int {
    exec('du -sk ' . escapeshellarg($path) . ' 2>/dev/null', $dOut, $dCode);
    if ($dCode === 0 && !empty($dOut[0]) && preg_match('/^(\d+)/', trim($dOut[0]), $m)) {
        return ((int)$m[1]) * 1024;
    }
    return 0;
}

function assertDiskFreeSpace(string $targetPath, int $requiredBytes, string $stageLabel): void {
    $probeDir = is_dir($targetPath) ? $targetPath : dirname($targetPath);
    if (!is_dir($probeDir)) {
        return;
    }
    $free = @disk_free_space($probeDir);
    if ($free !== false && $free < $requiredBytes) {
        $freeMb = round($free / 1048576, 1);
        $reqMb = round($requiredBytes / 1048576, 1);
        fwrite(STDERR, "ERROR: ENOSPC: Insufficient disk space during {$stageLabel} in {$probeDir} ({$freeMb} MB available, {$reqMb} MB required)\n");
        exit(1);
    }
}

function classifyTarWarnings(array $tarLines): array {
    $benign = [];
    $critical = [];
    $benignPattern = '/(?:^|\/)(?:cache|et-cache|et_temp|litespeed|uploads\/elementor\/css|storage\/framework\/cache)(?:\/|$)|\.log(?:\.\d+)?$|\/sess_[a-zA-Z0-9]+$/i';

    foreach ($tarLines as $line) {
        $trimmed = trim($line);
        if ($trimmed === '') continue;
        if (preg_match('/^tar:\s*(.+?):\s*(?:file changed as we read it|File removed before we read it|file shrank by)/i', $trimmed, $m)) {
            $changedPath = trim($m[1]);
            if (preg_match($benignPattern, $changedPath)) {
                $benign[] = $changedPath;
            } else {
                $critical[] = $changedPath;
            }
        }
    }

    return [
        'benign_files' => array_values(array_unique($benign)),
        'critical_files' => array_values(array_unique($critical)),
    ];
}

function sedEscapeRegex(string $value): string {
    return preg_replace('/([.\[\]^$*|\\\\\/])/', '\\\\$1', $value) ?? $value;
}

$parts        = [];
$dbDumpFile   = null;
$isIncremental = ($type === 'incremental');

if ($type === 'full' || $type === 'db_only' || $isIncremental) {
    $creds = parseWpConfig($resolvedDocroot);
    $credSource = 'filesystem';

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

    foreach (['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST'] as $required) {
        if (empty($creds[$required])) {
            fwrite(STDERR, "ERROR: Missing or empty credential '{$required}'. Checked .env, wp-config.php, and config/application.php under {$resolvedDocroot}\n");
            exit(1);
        }
    }

    fwrite(STDERR, "DB creds source={$credSource} user={$creds['DB_USER']} db={$creds['DB_NAME']} host={$creds['DB_HOST']}\n");

    $dbDumpFile = $runStageDir . '/forge_db_' . $runToken . '.sql';
    $stderrFile = $runStageDir . '/forge_db_err_' . $runToken . '.txt';
    @touch($dbDumpFile);
    @chmod($dbDumpFile, 0600);

    $dbHost = $creds['DB_HOST'];
    $dbPort = '';
    if (strpos($dbHost, ':') !== false) {
        [$dbHost, $hostPort] = explode(':', $dbHost, 2);
        $dbPort = ' --port=' . (int)$hostPort;
    } elseif (!empty($creds['DB_PORT'])) {
        $dbPort = ' --port=' . (int)$creds['DB_PORT'];
    }

    $mycnfFile = $runStageDir . '/forge_mycnf_' . $runToken . '.cnf';
    $mycnfContent = "[client]\n"
        . "user=" . $creds['DB_USER'] . "\n"
        . "password=" . $creds['DB_PASSWORD'] . "\n"
        . "host=" . $dbHost . "\n";
    file_put_contents($mycnfFile, $mycnfContent);
    chmod($mycnfFile, 0600);
    $forgeCleanupState['mycnf'] = $mycnfFile;

    $estDbBytes = estimateMysqlBytes($mycnfFile, $dbPort, $creds['DB_NAME']);
    if ($estDbBytes > 0) {
        $requiredDbSpace = (int)ceil($estDbBytes * 1.2) + (32 * 1048576);
        assertDiskFreeSpace($runStageDir, $requiredDbSpace, 'mysqldump staging');
    }

    $cmd = sprintf(
        'mysqldump --defaults-extra-file=%s%s --single-transaction --quick %s > %s 2>%s',
        escapeshellarg($mycnfFile),
        $dbPort,
        escapeshellarg($creds['DB_NAME']),
        escapeshellarg($dbDumpFile),
        escapeshellarg($stderrFile)
    );
    exec($cmd, $out, $code);
    @unlink($mycnfFile);
    $forgeCleanupState['mycnf'] = null;
    if ($code !== 0) {
        $errDetail = file_exists($stderrFile) ? trim(file_get_contents($stderrFile)) : implode("\n", $out);
        @unlink($stderrFile);
        @unlink($dbDumpFile);
        fwrite(STDERR, "ERROR: mysqldump failed (exit {$code}): {$errDetail}\n");
        exit($code);
    }
    @unlink($stderrFile);
    $parts[] = $dbDumpFile;
}

$basename = $logicalBasename;
$cacheDir = null;
$runCacheRoot = null;
$currentDir = null;

if ($isIncremental) {
    $parentDir = dirname($docrootTrimmed);
    $cacheBaseRoot = $parentDir . '/.forge_backup_cache';
    if (!is_dir($cacheBaseRoot) && !@mkdir($cacheBaseRoot, 0700, true)) {
        fwrite(STDERR, "ERROR: Could not create incremental backup cache root: {$cacheBaseRoot}\n");
        exit(1);
    }
    @chmod($cacheBaseRoot, 0700);

    $envKey = hash('sha256', $resolvedDocroot);
    $cacheDir = $cacheBaseRoot . '/' . $envKey;
    $latestParent = $cacheDir . '/latest';
    $latestDir = $latestParent . '/' . $basename;
    $runCacheRoot = $cacheDir . '/runs/' . $runToken;
    $currentDir = $runCacheRoot . '/' . $basename;
    $forgeCleanupState['runCacheRoot'] = $runCacheRoot;

    @mkdir($cacheDir, 0700, true);
    @chmod($cacheDir, 0700);
    @mkdir($latestParent, 0700, true);
    @mkdir($runCacheRoot, 0700, true);
    @mkdir($currentDir, 0755, true);

    $rsyncFlags = '-a --delete';
    if (is_dir($latestDir)) {
        $rsyncFlags .= ' --link-dest=' . escapeshellarg($latestDir);
    }

    $rsyncCmd = "rsync {$rsyncFlags} " . escapeshellarg($resolvedDocroot . '/') . ' ' . escapeshellarg($currentDir . '/');
    fwrite(STDERR, "Executing incremental rsync: {$rsyncCmd}\n");
    exec($rsyncCmd . ' 2>&1', $rsyncOut, $rsyncCode);
    if ($rsyncCode !== 0) {
        fwrite(STDERR, "ERROR: Incremental rsync failed (exit {$rsyncCode}): " . implode("\n", $rsyncOut) . "\n");
        exec('rm -rf ' . escapeshellarg($runCacheRoot));
        exit($rsyncCode);
    }
}

$outputDir = dirname($output);
if (!is_dir($outputDir)) {
    @mkdir($outputDir, 0700, true);
}

$rawFilesBytes = ($type === 'db_only') ? 0 : estimateDirectoryBytes($resolvedDocroot);
$sqlDumpBytes = ($dbDumpFile && file_exists($dbDumpFile)) ? (int)filesize($dbDumpFile) : 0;
$estimatedRawTotal = $rawFilesBytes + $sqlDumpBytes;
if ($estimatedRawTotal > 0) {
    $requiredTarSpace = (int)ceil($estimatedRawTotal * 0.75) + (32 * 1048576);
    assertDiskFreeSpace($outputDir, $requiredTarSpace, 'archive creation');
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

$transformFlag = '';
if ($isSymlinkDocroot && ($type === 'full' || $type === 'files_only') && $physicalBasename !== $logicalBasename) {
    $tarVersion = shell_exec('tar --version 2>/dev/null') ?? '';
    if (stripos($tarVersion, 'GNU tar') !== false) {
        $srcEsc = sedEscapeRegex($physicalBasename);
        $dstEsc = str_replace('/', '\\/', $logicalBasename);
        $transformExpr = "flags=r;s|^" . $srcEsc . "/|" . $dstEsc . "/|;s|^" . $srcEsc . "$|" . $dstEsc . "|";
        $transformFlag = ' --transform=' . escapeshellarg($transformExpr) . ' ';
    } else {
        fwrite(STDERR, "WARNING: Non-GNU tar detected with symlinked docroot name mismatch ({$logicalBasename} -> {$physicalBasename}); archiving resolved directory name\n");
    }
}

$pigz = trim(shell_exec('which pigz 2>/dev/null') ?? '');
if ($pigz) {
    $tarCmd = 'tar --use-compress-program=' . escapeshellarg($pigz) . $excludeFlags . $transformFlag . '-cf ' . escapeshellarg($output);
} else {
    $tarCmd = 'tar -czf ' . escapeshellarg($output) . $excludeFlags . $transformFlag;
}

if ($type === 'full' || $type === 'files_only') {
    if ($isSymlinkDocroot) {
        $tarCmd .= ' -C ' . escapeshellarg(dirname($resolvedDocroot)) . ' ' . escapeshellarg($physicalBasename);
    } else {
        $tarCmd .= ' -C ' . escapeshellarg(dirname($docrootTrimmed)) . ' ' . escapeshellarg($logicalBasename);
    }
} elseif ($isIncremental) {
    $tarCmd .= ' -C ' . escapeshellarg($runCacheRoot) . ' ' . escapeshellarg($logicalBasename);
}

foreach ($parts as $part) {
    $tarCmd .= ' -C ' . escapeshellarg(dirname($part)) . ' ' . escapeshellarg(basename($part));
}

$tarAttempts = 0;
$warnings = ['benign_files' => [], 'critical_files' => []];
$out = [];
$code = 0;

do {
    $tarAttempts++;
    $out = [];
    $code = 0;
    @touch($output);
    @chmod($output, 0600);
    exec($tarCmd . ' 2>&1', $out, $code);

    if ($code > 1) {
        @unlink($output);
        if ($isIncremental && $runCacheRoot) {
            exec('rm -rf ' . escapeshellarg($runCacheRoot));
        }
        fwrite(STDERR, "ERROR: tar failed (exit {$code}): " . implode("\n", $out) . "\n");
        exit($code);
    }

    $warnings = ($code === 1)
        ? classifyTarWarnings($out)
        : ['benign_files' => [], 'critical_files' => []];

    if ($code === 1 && !empty($warnings['critical_files']) && $tarAttempts < 2) {
        fwrite(STDERR, "WARNING: tar exited 1 on critical files (" . implode(', ', $warnings['critical_files']) . ") — retrying once for clean snapshot\n");
        @unlink($output);
        continue;
    }
    break;
} while ($tarAttempts < 2);

// Cleanup temp SQL dump now that archive is written
if ($dbDumpFile && file_exists($dbDumpFile)) {
    @unlink($dbDumpFile);
}

if ($code === 1 && !empty($warnings['critical_files'])) {
    @unlink($output);
    if ($isIncremental && $runCacheRoot) {
        exec('rm -rf ' . escapeshellarg($runCacheRoot));
    }
    fwrite(STDERR, "ERROR: Backup inconsistent — critical application files changed during tar after retry: " . implode(', ', $warnings['critical_files']) . "\n");
    exit(1);
}

// Verify archive structural integrity before reporting success
$verifyCode = 0;
$verifyOut = [];
exec('tar -tzf ' . escapeshellarg($output) . ' >/dev/null 2>&1', $verifyOut, $verifyCode);
$size = file_exists($output) ? (int)filesize($output) : 0;
if ($verifyCode !== 0 || $size <= 0) {
    @unlink($output);
    if ($isIncremental && $runCacheRoot) {
        exec('rm -rf ' . escapeshellarg($runCacheRoot));
    }
    fwrite(STDERR, "ERROR: Backup archive failed tar -tzf verification (exit {$verifyCode}, size={$size})\n");
    exit(1);
}

@chmod($output, 0600);

if ($code === 1) {
    fwrite(STDERR, "WARNING: tar exited 1 on benign volatile files (" . implode(', ', $warnings['benign_files']) . ") — verified via tar -tzf\n");
}

if ($isIncremental && $cacheDir && $runCacheRoot) {
    $latestDir = $cacheDir . '/latest/' . $basename;
    $prevLatest = $cacheDir . '/latest/' . $basename . '.prev_' . $runToken;
    if (is_dir($latestDir)) {
        @rename($latestDir, $prevLatest);
    }
    if (@rename($currentDir, $latestDir)) {
        if (is_dir($prevLatest)) {
            exec('rm -rf ' . escapeshellarg($prevLatest));
        }
    } else {
        exec('rm -rf ' . escapeshellarg($latestDir));
        @mkdir($cacheDir . '/latest', 0700, true);
        exec('mv ' . escapeshellarg($currentDir) . ' ' . escapeshellarg($latestDir));
        if (is_dir($prevLatest)) {
            exec('rm -rf ' . escapeshellarg($prevLatest));
        }
    }
    exec('rm -rf ' . escapeshellarg($runCacheRoot));
}

$forgeCleanupState['succeeded'] = true;
echo json_encode([
    'filename' => $output,
    'size' => $size,
    'archive_verified' => true,
    'consistent' => empty($warnings['critical_files']),
    'warnings' => $warnings,
]) . "\n";
exit(0);

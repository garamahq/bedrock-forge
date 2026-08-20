<?php
/**
 * wp-actions.php — WordPress quick fix/action runner
 *
 * Args:
 *   --docroot   Absolute path to site root
 *   --wp-path   Optional absolute WordPress core path for WP-CLI (Bedrock: web/wp)
 *   --action    flush_rewrite | clear_cache | fix_permissions | disable_plugins | enable_plugins
 *
 * Output: JSON { success, action, message, details }
 */

error_reporting(E_ALL);
set_time_limit(0);

$opts = getopt('', ['docroot:', 'wp-path::', 'action:']);
$docroot  = rtrim($opts['docroot'] ?? '', '/');
$wpPath   = rtrim($opts['wp-path'] ?? $docroot, '/');
$action   = $opts['action'] ?? '';

if (!$docroot || !$action) {
    out(false, $action, 'Missing --docroot or --action');
}

if (!is_dir($docroot)) {
    out(false, $action, "Docroot not found: $docroot");
}

if (!$wpPath || !is_dir($wpPath)) {
    out(false, $action, "WP path not found: $wpPath");
}

switch ($action) {
    case 'flush_rewrite':
        flushRewrite($docroot, $wpPath);
        break;
    case 'clear_cache':
        clearCache($docroot, $wpPath);
        break;
    case 'fix_permissions':
        fixPermissions($docroot);
        break;
    case 'disable_plugins':
        togglePlugins($docroot, false);
        break;
    case 'enable_plugins':
        togglePlugins($docroot, true);
        break;
    default:
        out(false, $action, "Unknown action: $action");
}

// ─── Action implementations ──────────────────────────────────────────────────

function flushRewrite(string $docroot, string $wpPath): void {
    $details = [];

    // Try WP-CLI first
    $wpCli = findWpCli($wpPath);
    if ($wpCli) {
        $cmd = wpCliCommand($wpCli, 'rewrite flush --skip-plugins --path=' . escapeshellarg($wpPath));
        exec($cmd, $wpcliOut, $rc);
        if ($rc === 0) {
            out(true, 'flush_rewrite', 'Rewrite rules flushed via WP-CLI', implode("\n", $wpcliOut));
        }
        $details[] = 'WP-CLI flush failed (rc=' . $rc . '): ' . implode(' ', $wpcliOut);
    }

    // Fallback: SQL — NULL out rewrite_rules option + delete transients
    $db = loadDb($docroot);
    if (!$db) {
        out(false, 'flush_rewrite', 'WP-CLI unavailable and could not load DB credentials', implode('; ', $details));
    }
    $prefix = $db['prefix'];
    $pdo = connectPdo($db);
    $pdo->exec("UPDATE `{$prefix}options` SET option_value = NULL WHERE option_name = 'rewrite_rules'");
    $pdo->exec("DELETE FROM `{$prefix}options` WHERE option_name LIKE '_transient_rewrite_%'");
    $details[] = 'SQL fallback: cleared rewrite_rules + transients';
    out(true, 'flush_rewrite', 'Rewrite rules flushed via SQL fallback', implode('; ', $details));
}

function clearCache(string $docroot, string $wpPath): void {
    $details = [];

    $wpCli = findWpCli($wpPath);
    if ($wpCli) {
        $cmd = wpCliCommand($wpCli, 'cache flush --skip-plugins --path=' . escapeshellarg($wpPath));
        exec($cmd, $wpcliOut, $rc);
        if ($rc === 0) {
            out(true, 'clear_cache', 'Object cache flushed via WP-CLI', implode("\n", $wpcliOut));
        }
        $details[] = 'WP-CLI cache flush failed: ' . implode(' ', $wpcliOut);
    }

    // SQL fallback — delete all _transient_* and _site_transient_* options
    $db = loadDb($docroot);
    if (!$db) {
        out(false, 'clear_cache', 'WP-CLI unavailable and could not load DB credentials', implode('; ', $details));
    }
    $prefix = $db['prefix'];
    $pdo = connectPdo($db);
    $stmt = $pdo->exec("DELETE FROM `{$prefix}options` WHERE option_name LIKE '_transient_%' OR option_name LIKE '_site_transient_%'");
    $details[] = "SQL fallback: deleted {$stmt} transient rows";
    out(true, 'clear_cache', 'Cache cleared via SQL fallback', implode('; ', $details));
}

function fixPermissions(string $docroot): void {
    $parentForOwner = dirname($docroot);
    exec('stat -c %U ' . escapeshellarg($parentForOwner) . ' 2>/dev/null', $parentOwnerOut, $parentOwnerCode);
    $ownerDetected = ($parentOwnerCode === 0 && !empty($parentOwnerOut[0]) && trim($parentOwnerOut[0]) !== 'root')
        ? trim($parentOwnerOut[0])
        : null;

    if (!$ownerDetected) {
        exec('stat -c %U ' . escapeshellarg($docroot) . ' 2>/dev/null', $selfOwnerOut, $selfOwnerCode);
        if ($selfOwnerCode === 0 && !empty($selfOwnerOut[0]) && trim($selfOwnerOut[0]) !== 'root') {
            $ownerDetected = trim($selfOwnerOut[0]);
        }
    }

    $ownerName = $ownerDetected ?: 'www-data';

    $cmds = [
        "find " . escapeshellarg($docroot) . " -type d -exec chmod 755 {} + 2>/dev/null",
        "find " . escapeshellarg($docroot) . " -type f -exec chmod 644 {} + 2>/dev/null",
        "chmod 750 " . escapeshellarg($docroot) . " 2>/dev/null || true",
        "chmod 440 " . escapeshellarg($docroot) . "/wp-config.php 2>/dev/null || true",
        "chmod 440 " . escapeshellarg($docroot) . "/web/wp-config.php 2>/dev/null || true",
        "chmod 440 " . escapeshellarg($docroot) . "/.env 2>/dev/null || true",
        "chmod 440 " . escapeshellarg($docroot) . "/web/.env 2>/dev/null || true",
    ];

    $details = [];
    foreach ($cmds as $cmd) {
        exec($cmd . ' 2>&1', $out, $rc);
        $details[] = ($rc === 0 ? 'OK' : 'ERR') . ': ' . $cmd;
    }

    // Step 1: inner files → user:user (recursive)
    $chown1 = "chown -R {$ownerName}:{$ownerName} " . escapeshellarg($docroot) . " 2>&1";
    exec($chown1, $chownOut1, $chownRc1);
    $details[] = ($chownRc1 === 0 ? 'OK' : 'ERR(chown inner)') . ': ' . implode(' ', $chownOut1);

    // Step 2: docroot itself → user:nogroup for LiteSpeed/OLS access
    $chown2 = "chown {$ownerName}:nogroup " . escapeshellarg($docroot) . " 2>&1";
    exec($chown2, $chownOut2, $chownRc2);
    $details[] = ($chownRc2 === 0 ? 'OK' : 'ERR(chown docroot)') . ': ' . implode(' ', $chownOut2);

    out(true, 'fix_permissions', "Permissions and ownership fixed for owner {$ownerName}", implode("\n", $details));
}

function togglePlugins(string $docroot, bool $enable): void {
    $base = (is_dir($docroot . '/web/app/plugins') || is_dir($docroot . '/web/app/plugins-disabled'))
        ? $docroot . '/web/app'
        : $docroot . '/wp-content';

    $pluginsDir  = $base . '/plugins';
    $disabledDir = $base . '/plugins-disabled';

    if ($enable) {
        if (!is_dir($disabledDir)) {
            out(false, 'enable_plugins', 'No disabled plugins directory found');
        }
        rename($disabledDir, $pluginsDir);
        out(true, 'enable_plugins', 'Plugins re-enabled', "Moved $disabledDir → $pluginsDir");
    } else {
        if (!is_dir($pluginsDir)) {
            out(false, 'disable_plugins', 'Plugins directory not found');
        }
        rename($pluginsDir, $disabledDir);
        out(true, 'disable_plugins', 'All plugins disabled', "Moved $pluginsDir → $disabledDir");
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findWpCli(string $docroot): ?string {
    $candidates = [
        $docroot . '/vendor/bin/wp',
        '/usr/local/bin/wp',
        '/usr/bin/wp',
    ];
    foreach ($candidates as $c) {
        if (is_executable($c)) return $c;
    }
    $which = trim(shell_exec('which wp 2>/dev/null') ?? '');
    return $which ?: null;
}

function wpCliCommand(string $wpCli, string $args): string {
    $wpCliPhp = getenv('WP_CLI_PHP') ?: '';
    if ($wpCliPhp !== '') {
        return escapeshellarg($wpCliPhp) . ' ' . escapeshellarg($wpCli) . ' ' . $args . ' 2>&1';
    }

    return escapeshellarg($wpCli) . ' ' . $args . ' 2>&1';
}

function loadDb(string $docroot): ?array {
    // Bedrock-style .env
    foreach (['.env', '.env.local'] as $f) {
        $envPath = $docroot . '/' . $f;
        if (file_exists($envPath)) {
            $lines = file($envPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
            $vars = [];
            foreach ($lines as $line) {
                if (str_starts_with(trim($line), '#')) continue;
                [$k, $v] = array_pad(explode('=', $line, 2), 2, '');
                $vars[trim($k)] = trim($v, " \t\n\r\"'");
            }
            if (!empty($vars['DB_NAME'])) {
                return [
                    'host'   => $vars['DB_HOST'] ?? '127.0.0.1',
                    'port'   => $vars['DB_PORT'] ?? '3306',
                    'user'   => $vars['DB_USER'] ?? $vars['DB_USERNAME'] ?? 'root',
                    'pass'   => $vars['DB_PASSWORD'] ?? $vars['DB_PASS'] ?? '',
                    'name'   => $vars['DB_NAME'],
                    'prefix' => $vars['table_prefix'] ?? 'wp_',
                ];
            }
        }
    }
    // Legacy wp-config.php
    $wpConfig = $docroot . '/wp-config.php';
    if (file_exists($wpConfig)) {
        $content = file_get_contents($wpConfig);
        preg_match("/define\s*\(\s*['\"]DB_NAME['\"]\s*,\s*['\"]([^'\"]+)['\"]/", $content, $nm);
        preg_match("/define\s*\(\s*['\"]DB_USER['\"]\s*,\s*['\"]([^'\"]+)['\"]/", $content, $usr);
        preg_match("/define\s*\(\s*['\"]DB_PASSWORD['\"]\s*,\s*['\"]([^'\"]+)['\"]/", $content, $pw);
        preg_match("/define\s*\(\s*['\"]DB_HOST['\"]\s*,\s*['\"]([^'\"]+)['\"]/", $content, $host);
        preg_match("/\\\$table_prefix\s*=\s*['\"]([^'\"]+)['\"]/", $content, $pfx);
        if (!empty($nm[1])) {
            $hostVal = $host[1] ?? '127.0.0.1';
            $port    = '3306';
            if (str_contains($hostVal, ':')) [$hostVal, $port] = explode(':', $hostVal, 2);
            return [
                'host'   => $hostVal,
                'port'   => $port,
                'user'   => $usr[1]  ?? 'root',
                'pass'   => $pw[1]   ?? '',
                'name'   => $nm[1],
                'prefix' => $pfx[1]  ?? 'wp_',
            ];
        }
    }
    return null;
}

function connectPdo(array $db): PDO {
    $dsn = "mysql:host={$db['host']};port={$db['port']};dbname={$db['name']};charset=utf8mb4";
    return new PDO($dsn, $db['user'], $db['pass'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_TIMEOUT => 10,
    ]);
}

function out(bool $success, string $action, string $message, string $details = ''): never {
    echo json_encode(['success' => $success, 'action' => $action, 'message' => $message, 'details' => $details]);
    exit($success ? 0 : 1);
}

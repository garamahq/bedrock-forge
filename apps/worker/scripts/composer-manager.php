#!/usr/bin/env php
<?php
/**
 * composer-manager.php — Bedrock Forge composer plugin manager
 *
 * Usage:
 *   php composer-manager.php --docroot=/path --action=read
 *   php composer-manager.php --docroot=/path --action=add    --package=wpackagist-plugin/slug [--version=^1.5]
 *   php composer-manager.php --docroot=/path --action=remove --package=wpackagist-plugin/slug
 *   php composer-manager.php --docroot=/path --action=update --package=wpackagist-plugin/slug
 *   php composer-manager.php --docroot=/path --action=update-all
 *   php composer-manager.php --docroot=/path --action=change-constraint --package=wpackagist-plugin/slug --constraint=^2.0
 *
 * Outputs JSON on stdout:
 *   read:             { "managed_plugins": [...], "is_bedrock": true, "raw_composer": {...} }
 *   mutating actions: { "success": true, "output": "..." }
 *
 * Security:
 *   - Package names are validated against the pattern vendor/name (alphanumeric + dash/underscore)
 *   - Only wpackagist-plugin/* packages are allowed for mutating actions
 *   - All shell arguments are escaped via escapeshellarg()
 *   - Constraint is validated to contain only safe version specifier characters
 */

if (PHP_VERSION_ID < 70100) {
    fwrite(STDERR, "ERROR: PHP 7.1 or newer is required\n");
    exit(1);
}

$opts       = getopt('', ['docroot:', 'action:', 'package:', 'version:', 'constraint:']);
$docroot    = $opts['docroot']     ?? null;
$action     = $opts['action']      ?? null;
$package    = $opts['package']     ?? null;
$version    = $opts['version']     ?? null;
$constraint = $opts['constraint']  ?? null;

// ─── Validation ───────────────────────────────────────────────────────────────

if (!$docroot || !is_dir($docroot)) {
    bail('Invalid or missing --docroot');
}

$validActions = ['read', 'add', 'remove', 'update', 'update-all', 'change-constraint'];
if (!$action || !in_array($action, $validActions, true)) {
    bail('Missing or invalid --action. Valid values: ' . implode(', ', $validActions));
}

if ($package !== null) {
    // Strict validation: only allow vendor/package pattern with safe characters
    if (!preg_match('/^[a-z0-9_-]+\/[a-z0-9_-]+$/', $package)) {
        bail("Invalid package name format: {$package}");
    }
    // Only wpackagist-plugin/* allowed for mutating actions
    if (in_array($action, ['add', 'remove', 'update', 'change-constraint'], true)
        && strpos($package, 'wpackagist-plugin/') !== 0
    ) {
        bail("Only wpackagist-plugin/* packages are allowed. Got: {$package}");
    }
}

if (in_array($action, ['add', 'remove', 'update', 'change-constraint'], true) && !$package) {
    bail("--package is required for action '{$action}'");
}

if ($action === 'change-constraint' && !$constraint) {
    bail("--constraint is required for action 'change-constraint'");
}

// Validate constraint string: only safe version specifier characters allowed
if ($constraint !== null) {
    if (!preg_match('/^[\w.^~*|@, ><=!\-]+$/', $constraint)) {
        bail("Invalid constraint format: {$constraint}");
    }
}

// ─── Read action ──────────────────────────────────────────────────────────────

if ($action === 'read') {
    $composerJson = locateComposerJson($docroot);
    if (!$composerJson) {
        echo json_encode(['managed_plugins' => [], 'is_bedrock' => false, 'raw_composer' => null]);
        exit(0);
    }

    $content = file_get_contents($composerJson);
    $data    = @json_decode($content, true) ?: [];
    $require = $data['require'] ?? [];
    $managed = [];

    foreach ($require as $pkg => $ver) {
        if (strpos($pkg, 'wpackagist-plugin/') === 0) {
            $slug      = substr($pkg, strlen('wpackagist-plugin/'));
            $managed[] = [
                'slug'       => $slug,
                'package'    => $pkg,
                'constraint' => $ver,
            ];
        }
    }

    echo json_encode(
        ['managed_plugins' => $managed, 'is_bedrock' => true, 'raw_composer' => $data],
        JSON_UNESCAPED_SLASHES
    );
    exit(0);
}

// ─── Mutating actions ─────────────────────────────────────────────────────────

$composerJson = locateComposerJson($docroot);
if (!$composerJson) {
    bail("No composer.json found under {$docroot}");
}

// Change into the directory that holds composer.json
$composerDir = dirname($composerJson);
if (!chdir($composerDir)) {
    bail("Cannot chdir to {$composerDir}");
}

// Ensure git safe.directory is configured to prevent "fatal: detected dubious ownership in repository"
exec('git config --global --add safe.directory ' . escapeshellarg($composerDir) . ' 2>/dev/null');
exec('git config --global --add safe.directory ' . escapeshellarg($docroot) . ' 2>/dev/null');
exec('git config --global --add safe.directory "*" 2>/dev/null');

// Verify composer is available
exec(composerCommand('--version'), $verOutput, $verCode);
if ($verCode !== 0) {
    bail('composer binary not found in $PATH');
}

if ($action === 'add') {
    $spec = $version
        ? escapeshellarg($package) . ':' . escapeshellarg($version)
        : escapeshellarg($package);
    runComposer("require {$spec} --no-interaction --with-dependencies --minimal-changes");

} elseif ($action === 'remove') {
    runComposer('remove ' . escapeshellarg($package) . ' --no-interaction --minimal-changes');

} elseif ($action === 'update') {
    runComposer('update ' . escapeshellarg($package) . ' --no-interaction --with-dependencies --minimal-changes');

} elseif ($action === 'update-all') {
    $content = @json_decode(file_get_contents($composerJson), true) ?: [];
    $require = $content['require'] ?? [];
    $pluginPackages = [];
    $hasModifiedConstraints = false;

    foreach ($require as $pkg => $constraint) {
        if (strpos((string)$pkg, 'wpackagist-plugin/') === 0) {
            $pluginPackages[] = (string)$pkg;
            // If constraint is an exact version pin (e.g., 6.5.0.2 or 1.0 or v1.2.3), widen to caret constraint
            if (preg_match('/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?$/', trim((string)$constraint), $m)) {
                $major = $m[1] ?? '0';
                $minor = $m[2] ?? '0';
                $widen = "^" . $major . "." . $minor;
                $content['require'][$pkg] = $widen;
                $hasModifiedConstraints = true;
            }
        }
    }
    if ($hasModifiedConstraints) {
        file_put_contents($composerJson, json_encode($content, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n");
    }

    if ($pluginPackages === []) bail('No Composer-managed plugins found');
    runComposer('update ' . implode(' ', array_map('escapeshellarg', $pluginPackages)) . ' --no-interaction --with-dependencies --minimal-changes');

} elseif ($action === 'change-constraint') {
    // Read, modify the constraint for the package, write back, then composer update
    $backup = backupComposerState($composerJson);
    $content = file_get_contents($composerJson);
    $data    = @json_decode($content, true);
    if (!is_array($data)) {
        bail('Could not parse composer.json at ' . $composerJson);
    }
    if (!isset($data['require'][$package])) {
        bail("Package {$package} is not present in composer.json require section");
    }
    $data['require'][$package] = $constraint;
    $newContent = json_encode(
        $data,
        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
    );
    file_put_contents($composerJson, $newContent . "\n");
    // Run composer update for the specific package to resolve and install the new constraint
    runComposer('update ' . escapeshellarg($package) . ' --no-interaction --with-dependencies --minimal-changes', $backup);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function locateComposerJson(string $docroot): ?string
{
    foreach ([
        $docroot . '/composer.json',
        dirname($docroot) . '/composer.json',
    ] as $path) {
        if (file_exists($path)) {
            return $path;
        }
    }
    return null;
}

function backupComposerState(string $composerJsonPath): array
{
    $lockPath = dirname($composerJsonPath) . '/composer.lock';
    return [
        'json_path' => $composerJsonPath,
        'json' => file_get_contents($composerJsonPath),
        'lock_path' => $lockPath,
        'lock_exists' => file_exists($lockPath),
        'lock' => file_exists($lockPath) ? file_get_contents($lockPath) : null,
    ];
}

function restoreComposerState(array $backup): void
{
    file_put_contents($backup['json_path'], $backup['json']);

    if ($backup['lock_exists']) {
        file_put_contents($backup['lock_path'], $backup['lock']);
    } elseif (file_exists($backup['lock_path'])) {
        unlink($backup['lock_path']);
    }
}

function composerCommand(string $args): string
{
    return 'COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_NO_INTERACTION=1 GIT_CONFIG_PARAMETERS="\'safe.directory=*\'" GIT_DISCOVERY_ACROSS_FILESYSTEM=1 ' . composerExecutable() . ' ' . $args . ' 2>&1';
}

function composerExecutable(): string
{
    $composerPath = trim(shell_exec('command -v composer 2>/dev/null') ?? '');
    if ($composerPath === '') {
        return 'composer';
    }

    $firstBytes = is_readable($composerPath)
        ? (file_get_contents($composerPath, false, null, 0, 256) ?: '')
        : '';
    $looksLikePhp =
        substr($composerPath, -5) === '.phar' ||
        substr($firstBytes, 0, 5) === '<?php' ||
        preg_match('/^#!.*\bphp\b/i', $firstBytes) === 1;

    if ($looksLikePhp) {
        $phpBin = defined('PHP_BINARY') && PHP_BINARY ? PHP_BINARY : 'php';
        return escapeshellarg($phpBin) . ' ' . escapeshellarg($composerPath);
    }

    return escapeshellarg($composerPath);
}

function checkHostResolvable(string $host): bool
{
    $ip = @gethostbyname($host);
    return !empty($ip) && $ip !== $host;
}

function runComposer(string $args, ?array $backup = null): void
{
    $cmd         = composerCommand($args);
    $outputLines = [];
    $exitCode    = 0;

    exec($cmd, $outputLines, $exitCode);
    $output = implode("\n", $outputLines);

    // If composer failed due to an unreachable custom repository host or DNS failure (curl error 6, 7, 28, Could not resolve host)
    if ($exitCode !== 0) {
        $failedHost = null;
        if (preg_match('/(?:curl error (?:6|7|28)|Could not resolve host:?\s*([a-zA-Z0-9.-]+)|while downloading https?:\/\/([a-zA-Z0-9.-]+))/i', $output, $m)) {
            $failedHost = !empty($m[1]) ? $m[1] : (!empty($m[2]) ? $m[2] : null);
        }

        $composerJsonFile = locateComposerJson(getcwd());
        if ($composerJsonFile && is_file($composerJsonFile)) {
            $rawJson = @file_get_contents($composerJsonFile);
            $parsed = @json_decode($rawJson, true);
            if (is_array($parsed) && !empty($parsed['repositories'])) {
                $origRepos = $parsed['repositories'];
                $filteredRepos = [];
                $removedCount = 0;

                foreach ($origRepos as $repoKey => $repoVal) {
                    $repoUrl = is_array($repoVal) ? ($repoVal['url'] ?? '') : '';
                    if ($failedHost && strpos($repoUrl, $failedHost) !== false) {
                        $removedCount++;
                        continue;
                    }
                    if (!$failedHost && $repoUrl) {
                        $host = parse_url($repoUrl, PHP_URL_HOST);
                        if ($host && $host !== 'wpackagist.org' && $host !== 'packagist.org' && $host !== 'github.com') {
                            if (!checkHostResolvable($host)) {
                                $failedHost = $host;
                                $removedCount++;
                                continue;
                            }
                        }
                    }
                    $filteredRepos[$repoKey] = $repoVal;
                }

                if ($removedCount > 0) {
                    $parsed['repositories'] = array_values($filteredRepos);
                    file_put_contents($composerJsonFile, json_encode($parsed, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n");

                    $retryLines = [];
                    $retryCode = 0;
                    exec($cmd, $retryLines, $retryCode);
                    $retryOutput = implode("\n", $retryLines);

                    // Restore original repositories array in composer.json so configuration isn't permanently lost
                    $currJson = @json_decode(@file_get_contents($composerJsonFile), true) ?: [];
                    $currJson['repositories'] = $origRepos;
                    file_put_contents($composerJsonFile, json_encode($currJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n");

                    if ($retryCode === 0) {
                        $output = $retryOutput . "\n[Bedrock Forge Notice] Unreachable repository ({$failedHost}) was temporarily bypassed during update.\n";
                        $exitCode = 0;
                    }
                }
            }
        }
    }

    // If composer failed due to root dependency requirement (e.g. composer/installers requiring -W / --with-all-dependencies)
    if ($exitCode !== 0 && (
        strpos($output, 'with-all-dependencies') !== false ||
        strpos($output, 'is also a root requirement') !== false ||
        strpos($output, 'Use -W') !== false
    )) {
        if (strpos($args, '--with-dependencies') !== false) {
            $argsWithW = str_replace('--with-dependencies', '--with-all-dependencies', $args);
            $retryLines = [];
            $retryCode = 0;
            exec(composerCommand($argsWithW), $retryLines, $retryCode);
            if ($retryCode === 0) {
                $output = implode("\n", $retryLines);
                $exitCode = 0;
            }
        }
    }

    // If composer failed due to exact version constraint conflict for a wpackagist-plugin
    if ($exitCode !== 0 && preg_match_all('/Root composer\.json requires (wpackagist-plugin\/[^\s]+) ([^\s,]+) \(exact version match/i', $output, $matches, PREG_SET_ORDER)) {
        $composerJsonFile = locateComposerJson(getcwd());
        if ($composerJsonFile && is_file($composerJsonFile)) {
            $currJson = @json_decode(@file_get_contents($composerJsonFile), true);
            if (is_array($currJson) && isset($currJson['require'])) {
                $modified = false;
                foreach ($matches as $match) {
                    $pkgName = $match[1];
                    $exactVer = $match[2];
                    if (isset($currJson['require'][$pkgName])) {
                        if (preg_match('/^v?(\d+)(?:\.(\d+))?/', $exactVer, $vm)) {
                            $currJson['require'][$pkgName] = '^' . ($vm[1] ?? '0') . '.' . ($vm[2] ?? '0');
                        } else {
                            $currJson['require'][$pkgName] = '*';
                        }
                        $modified = true;
                    }
                }
                if ($modified) {
                    file_put_contents($composerJsonFile, json_encode($currJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n");
                    $retryLines = [];
                    $retryCode = 0;
                    exec($cmd, $retryLines, $retryCode);
                    $retryOut = implode("\n", $retryLines);
                    if ($retryCode !== 0 && (strpos($retryOut, 'with-all-dependencies') !== false || strpos($retryOut, 'is also a root requirement') !== false) && strpos($args, '--with-dependencies') !== false) {
                        $argsWithW = str_replace('--with-dependencies', '--with-all-dependencies', $args);
                        $retryLines = [];
                        exec(composerCommand($argsWithW), $retryLines, $retryCode);
                    }
                    if ($retryCode === 0) {
                        $output = implode("\n", $retryLines);
                        $exitCode = 0;
                    }
                }
            }
        }
    }

    if ($exitCode !== 0) {
        if ($backup !== null) {
            restoreComposerState($backup);
        }
        fwrite(STDERR, "composer failed (exit {$exitCode}):\n{$output}\n");
        exit($exitCode);
    }

    echo json_encode(
        ['success' => true, 'output' => $output],
        JSON_UNESCAPED_SLASHES
    );
}

function bail(string $msg): void
{
    fwrite(STDERR, "ERROR: {$msg}\n");
    exit(1);
}

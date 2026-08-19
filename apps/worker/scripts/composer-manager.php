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

$themeGuard = createThemeGuard($composerDir);

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
    $pluginPackages = array_keys(array_filter(
        $content['require'] ?? [],
        static fn($constraint, $name): bool => strpos((string) $name, 'wpackagist-plugin/') === 0,
        ARRAY_FILTER_USE_BOTH
    ));
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

    if ($exitCode !== 0) {
        restoreThemeGuard($GLOBALS['themeGuard'] ?? null);
        if ($backup !== null) {
            restoreComposerState($backup);
        }
        fwrite(STDERR, "composer failed (exit {$exitCode}):\n{$output}\n");
        exit($exitCode);
    }

    if (!themeGuardUnchanged($GLOBALS['themeGuard'] ?? null)) {
        restoreThemeGuard($GLOBALS['themeGuard'] ?? null);
        if ($backup !== null) restoreComposerState($backup);
        fwrite(STDERR, "composer changed the themes directory; themes were restored and the operation was rejected\n");
        exit(9);
    }

    cleanupThemeGuard($GLOBALS['themeGuard'] ?? null);

    echo json_encode(
        ['success' => true, 'output' => $output],
        JSON_UNESCAPED_SLASHES
    );
}

function createThemeGuard(string $composerDir): ?array
{
    $themeDir = is_dir($composerDir . '/web/app/themes')
        ? $composerDir . '/web/app/themes'
        : $composerDir . '/wp-content/themes';
    if (!is_dir($themeDir)) return null;
    $archive = tempnam(sys_get_temp_dir(), 'forge-themes-');
    if ($archive === false) bail('Could not create theme safety archive');
    @unlink($archive);
    $archive .= '.tar';
    $cmd = 'tar -C ' . escapeshellarg(dirname($themeDir)) . ' -cpf ' . escapeshellarg($archive) . ' ' . escapeshellarg(basename($themeDir)) . ' 2>&1';
    exec($cmd, $out, $code);
    if ($code !== 0) bail('Could not snapshot themes: ' . implode("\n", $out));
    return ['dir' => $themeDir, 'archive' => $archive, 'hash' => themeTreeHash($themeDir)];
}

function themeTreeHash(string $path): string
{
    $rows = [];
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
    foreach ($it as $file) {
        $rel = substr($file->getPathname(), strlen($path) + 1);
        $mode = sprintf('%o', $file->getPerms() & 0777);
        $rows[] = $mode . ':' . ($file->isLink() ? 'L:' . readlink($file->getPathname()) : ($file->isDir() ? 'D' : 'F:' . hash_file('sha256', $file->getPathname()))) . ':' . $rel;
    }
    sort($rows);
    return hash('sha256', implode("\n", $rows));
}

function themeGuardUnchanged(?array $guard): bool
{
    return $guard === null || (is_dir($guard['dir']) && themeTreeHash($guard['dir']) === $guard['hash']);
}

function restoreThemeGuard(?array $guard): void
{
    if ($guard === null || !is_file($guard['archive'])) return;
    if (is_dir($guard['dir'])) exec('rm -rf ' . escapeshellarg($guard['dir']));
    @mkdir(dirname($guard['dir']), 0755, true);
    exec('tar -C ' . escapeshellarg(dirname($guard['dir'])) . ' -xpf ' . escapeshellarg($guard['archive']) . ' 2>&1');
    cleanupThemeGuard($guard);
}

function cleanupThemeGuard(?array $guard): void
{
    if ($guard !== null && is_file($guard['archive'])) @unlink($guard['archive']);
}

function bail(string $msg): void
{
    fwrite(STDERR, "ERROR: {$msg}\n");
    exit(1);
}

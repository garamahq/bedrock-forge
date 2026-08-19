#!/usr/bin/env php
<?php
/**
 * custom-plugin-manager.php — Bedrock Forge custom GitHub plugin manager
 *
 * Manages installation, update, and removal of custom GitHub-hosted plugins/themes via
 * the satusdev/monorepo-fetcher Composer plugin. Manipulates the site's
 * composer.json directly so that monorepo-fetcher can pull the correct files
 * on the next `composer install`.
 *
 * Usage:
 *   php custom-plugin-manager.php \
 *     --action=add \
 *     --docroot=/path/to/site \
 *     --slug=my-plugin \
 *     --repo-url=git@github.com:org/repo.git \
 *     --repo-path=. \
 *     --type=plugin \
 *     [--github-token=ghp_xxx]
 *
 *   php custom-plugin-manager.php \
 *     --action=remove \
 *     --docroot=/path/to/site \
 *     --slug=my-plugin \
 *     --repo-url=git@github.com:org/repo.git \
 *     --repo-path=.
 *
 * Outputs JSON on stdout:
 *   { "success": true, "output": "..." }
 *   { "success": false, "error": "..." }   (also writes to stderr, exit 1)
 *
 * Security:
 *   - slug validated against /^[a-z0-9_-]+$/
 *   - repo-url validated as a recognised git URL pattern
 *   - repo-path validated against /^[.a-z0-9\/_-]+$/
 *   - All shell arguments escaped via escapeshellarg()
 */

if (PHP_VERSION_ID < 70400) {
    fwrite(STDERR, "ERROR: PHP 7.4 or newer is required\n");
    exit(1);
}

$opts      = getopt('', ['action:', 'docroot:', 'slug:', 'repo-url:', 'repo-path::', 'type::', 'github-token::']);
$action    = $opts['action']        ?? null;
$docroot   = $opts['docroot']       ?? null;
$slug      = $opts['slug']          ?? null;
$repoUrl   = $opts['repo-url']      ?? null;
$repoPath  = $opts['repo-path']     ?? '.';
$type      = $opts['type']          ?? 'plugin';
$ghToken   = $opts['github-token']  ?? null;

// ─── Validation ───────────────────────────────────────────────────────────────

if (!in_array($action, ['add', 'remove', 'update'], true)) {
    bail("Invalid or missing --action. Valid values: add, remove, update");
}

if (!$docroot || !is_dir($docroot)) {
    bail("Invalid or missing --docroot: " . ($docroot ?? '(empty)'));
}

if (!$slug || !preg_match('/^[a-z0-9_-]+$/', $slug)) {
    bail("Invalid or missing --slug. Must match /^[a-z0-9_-]+$/");
}

if (!$repoUrl || !preg_match(
    '/^(git@[a-zA-Z0-9._-]+:[a-zA-Z0-9._\/-]+\.git|https?:\/\/[a-zA-Z0-9._\/-]+\.git|https?:\/\/github\.com\/[a-zA-Z0-9._\/-]+)$/',
    $repoUrl
)) {
    bail("Invalid or missing --repo-url. Must be a valid git URL.");
}

// Convert SSH git URL to HTTPS format to bypass firewall/SSH key restrictions
if (preg_match('/^git@([a-zA-Z0-9._-]+):([a-zA-Z0-9._\/-]+?)(?:\.git)?$/', $repoUrl, $matches)) {
    $host = $matches[1];
    $path = $matches[2];
    $repoUrl = "https://{$host}/{$path}.git";
}

if (!preg_match('/^[.a-zA-Z0-9\/_-]+$/', $repoPath)) {
    bail("Invalid --repo-path. Must match /^[.a-zA-Z0-9\\/_-]+$/");
}

if (!in_array($type, ['plugin', 'theme'], true)) {
    bail("Invalid --type. Must be 'plugin' or 'theme'.");
}

// ─── Locate composer.json ─────────────────────────────────────────────────────

$composerJsonPath = locateComposerJson($docroot);
if (!$composerJsonPath) {
    bail("No composer.json found in {$docroot} or its parent directory.");
}

$composerDir = dirname($composerJsonPath);
if (!chdir($composerDir)) {
    bail("Cannot chdir to {$composerDir}");
}

// Ensure git safe.directory is configured to prevent "fatal: detected dubious ownership in repository"
exec('git config --global --add safe.directory ' . escapeshellarg($composerDir) . ' 2>/dev/null');
exec('git config --global --add safe.directory ' . escapeshellarg($docroot) . ' 2>/dev/null');
exec('git config --global --add safe.directory "*" 2>/dev/null');

// ─── Detect Bedrock and determine target dir ──────────────────────────────────

$content = file_get_contents($composerJsonPath);
$composer = @json_decode($content, true);
if (!is_array($composer)) {
    bail("Could not parse composer.json at {$composerJsonPath}");
}

$isBedrock = false;
$installerPaths = $composer['extra']['installer-paths'] ?? [];
foreach (array_keys($installerPaths) as $path) {
    if (strpos($path, 'web/app/') !== false) {
        $isBedrock = true;
        break;
    }
}

$targetDir = ($type === 'theme')
    ? ($isBedrock ? 'web/app/themes' : 'wp-content/themes')
    : ($isBedrock ? 'web/app/plugins' : 'wp-content/plugins');

// ─── Handle add ───────────────────────────────────────────────────────────────

if ($action === 'add' || $action === 'update') {
    // Ensure satusdev/repo-fetcher is in require
    if (!isset($composer['require']['satusdev/repo-fetcher'])) {
        $composer['require']['satusdev/repo-fetcher'] = 'dev-main';
    }
    // Clean up legacy package name if present
    if (isset($composer['require']['satusdev/monorepo-fetcher'])) {
        unset($composer['require']['satusdev/monorepo-fetcher']);
    }

    // Ensure repositories entry for vcs source
    $repos = $composer['repositories'] ?? [];
    $hasRepo = false;
    foreach ($repos as $repo) {
        if (
            isset($repo['type'], $repo['url']) &&
            $repo['type'] === 'vcs' &&
            $repo['url'] === 'https://github.com/satusdev/monorepo-fetcher'
        ) {
            $hasRepo = true;
            break;
        }
    }
    if (!$hasRepo) {
        $repos[] = [
            'type' => 'vcs',
            'url'  => 'https://github.com/satusdev/monorepo-fetcher',
        ];
        $composer['repositories'] = $repos;
    }

    // minimum-stability: dev is required for dev-main
    if (!isset($composer['minimum-stability'])) {
        $composer['minimum-stability'] = 'dev';
    }
    if (!isset($composer['prefer-stable'])) {
        $composer['prefer-stable'] = true;
    }

    // Disable use-symlinks to ensure files are copied and readable by the web server
    if (!isset($composer['extra'])) {
        $composer['extra'] = [];
    }
    $composer['extra']['use-symlinks'] = false;

    // Ensure allow-plugins config allows satusdev/repo-fetcher and satusdev/monorepo-fetcher
    if (!isset($composer['config'])) {
        $composer['config'] = [];
    }
    if (!isset($composer['config']['allow-plugins'])) {
        $composer['config']['allow-plugins'] = [];
    }
    if (is_array($composer['config']['allow-plugins'])) {
        $composer['config']['allow-plugins']['satusdev/repo-fetcher'] = true;
        $composer['config']['allow-plugins']['satusdev/monorepo-fetcher'] = true;
    }

    // Find or create the matching monorepo-source entry.
    // Update is intentionally idempotent: if an existing site was adopted by
    // scan, this rewrites the expected source config before composer refreshes.
    $sources = $composer['extra']['monorepo-sources'] ?? [];
    $found = false;

    foreach ($sources as &$source) {
        if (
            isset($source['url'], $source['path']) &&
            normalizeGitUrl($source['url']) === normalizeGitUrl($repoUrl) &&
            $source['path'] === $repoPath
        ) {
            $require = $source['require'] ?? [];
            $foundSlug = false;
            foreach ($require as $req) {
                if (is_string($req) && $req === $slug) {
                    $foundSlug = true;
                    break;
                } elseif (is_array($req) && isset($req['as']) && $req['as'] === $slug) {
                    $foundSlug = true;
                    break;
                }
            }
            if (!$foundSlug) {
                $require[] = [
                    'src' => '.',
                    'as'  => $slug,
                ];
            }
            $source['require'] = array_values($require);
            $found = true;
            break;
        }
    }
    unset($source);

    if (!$found) {
        $sources[] = [
            'type'    => $type,
            'url'     => $repoUrl,
            'path'    => $repoPath,
            'target'  => $targetDir,
            'require' => [
                [
                    'src' => '.',
                    'as'  => $slug,
                ]
            ],
        ];
    }

    $composer['extra']['monorepo-sources'] = $sources;

    // Write github-token to auth.json if provided
    if ($ghToken) {
        $authPath = $composerDir . '/auth.json';
        $auth = [];
        if (file_exists($authPath)) {
            $auth = @json_decode(file_get_contents($authPath), true) ?: [];
        }
        $auth['github-oauth']['github.com'] = $ghToken;
        file_put_contents(
            $authPath,
            json_encode($auth, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n"
        );
    }

    $backup = backupComposerState($composerJsonPath);
    writeComposer($composerJsonPath, $composer);
    
    // Refresh only repo-fetcher in the lock file. Broad -W updates and --no-dev
    // installs can change or remove unrelated site packages, including themes.
    $out1 = runComposer('update satusdev/repo-fetcher --with-dependencies --minimal-changes --no-install --no-interaction', $backup, true);
    
    // Always trigger a follow-up install to guarantee that any new/updated plugins are fetched and copied by repo-fetcher
    $out2 = runComposer('install --no-interaction', $backup, true);
    
    restoreOwnership($composerJsonPath, $targetDir, $composerDir);
    echo json_encode(['success' => true, 'output' => $out1 . "\n" . $out2], JSON_UNESCAPED_SLASHES);
}

// ─── Handle remove ────────────────────────────────────────────────────────────

if ($action === 'remove') {
    $sources = $composer['extra']['monorepo-sources'] ?? [];
    $modified = false;

    foreach ($sources as $i => &$source) {
        if (
            isset($source['url'], $source['path']) &&
            normalizeGitUrl($source['url']) === normalizeGitUrl($repoUrl) &&
            $source['path'] === $repoPath
        ) {
            $require = $source['require'] ?? [];
            $filtered = [];
            foreach ($require as $req) {
                if (is_string($req)) {
                    if ($req !== $slug) {
                        $filtered[] = $req;
                    }
                } elseif (is_array($req)) {
                    $reqSlug = $req['as'] ?? $req['name'] ?? '';
                    if ($reqSlug !== $slug) {
                        $filtered[] = $req;
                    }
                }
            }
            if (count($filtered) === 0) {
                unset($sources[$i]);
            } else {
                $source['require'] = $filtered;
            }
            $modified = true;
            break;
        }
    }
    unset($source);

    if (!$modified) {
        // Source is already absent. Still delete leftover copied files so removal
        // is authoritative from the dashboard's point of view.
        $deleted = deleteManagedTarget($composerDir, $targetDir, $slug);
        echo json_encode(
            [
                'success' => true,
                'output' => 'Plugin was not registered in composer.json' . ($deleted ? "\nDeleted leftover target directory." : ''),
            ],
            JSON_UNESCAPED_SLASHES
        );
        exit(0);
    }

    $sources = array_values($sources);

    if (empty($sources)) {
        unset($composer['extra']['monorepo-sources']);
        if (isset($composer['extra']['use-symlinks'])) {
            unset($composer['extra']['use-symlinks']);
        }
        if (empty($composer['extra'])) {
            unset($composer['extra']);
        }
        if (isset($composer['require']['satusdev/repo-fetcher'])) {
            unset($composer['require']['satusdev/repo-fetcher']);
        }
        if (isset($composer['require']['satusdev/monorepo-fetcher'])) {
            unset($composer['require']['satusdev/monorepo-fetcher']);
        }
        // Clean up allow-plugins
        if (isset($composer['config']['allow-plugins']) && is_array($composer['config']['allow-plugins'])) {
            unset($composer['config']['allow-plugins']['satusdev/repo-fetcher']);
            unset($composer['config']['allow-plugins']['satusdev/monorepo-fetcher']);
            if (empty($composer['config']['allow-plugins'])) {
                unset($composer['config']['allow-plugins']);
            }
        }
        if (isset($composer['config']) && empty($composer['config'])) {
            unset($composer['config']);
        }
        // Clean up the repositories VCS entry if present
        if (isset($composer['repositories']) && is_array($composer['repositories'])) {
            foreach ($composer['repositories'] as $idx => $repo) {
                if (
                    isset($repo['type'], $repo['url']) &&
                    $repo['type'] === 'vcs' &&
                    $repo['url'] === 'https://github.com/satusdev/monorepo-fetcher'
                ) {
                    unset($composer['repositories'][$idx]);
                }
            }
            $composer['repositories'] = array_values($composer['repositories']);
            if (empty($composer['repositories'])) {
                unset($composer['repositories']);
            }
        }
    } else {
        $composer['extra']['monorepo-sources'] = $sources;
    }

    $backup = backupComposerState($composerJsonPath);
    writeComposer($composerJsonPath, $composer);
    $out = runComposer('install --no-dev --no-interaction', $backup, true);
    $deleted = deleteManagedTarget($composerDir, $targetDir, $slug);
    restoreOwnership($composerJsonPath, $targetDir, $composerDir);
    echo json_encode(
        [
            'success' => true,
            'output' => $out . ($deleted ? "\nDeleted target directory." : ''),
        ],
        JSON_UNESCAPED_SLASHES
    );
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

function writeComposer(string $path, array $data): void
{
    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false) {
        bail('Failed to encode composer.json: ' . json_last_error_msg());
    }
    file_put_contents($path, $json . "\n");
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
    global $ghToken;
    $prefix = 'COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_NO_INTERACTION=1 GIT_CONFIG_PARAMETERS="\'safe.directory=*\'" GIT_DISCOVERY_ACROSS_FILESYSTEM=1';
    if ($ghToken) {
        $prefix .= ' REPO_FETCHER_TOKEN=' . escapeshellarg($ghToken);
    }
    return $prefix . ' ' . composerExecutable() . ' ' . $args . ' 2>&1';
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

function runComposer(string $args, ?array $backup = null, bool $silentOnSuccess = false): string
{
    // Verify composer is available
    exec(composerCommand('--version'), $verOut, $verCode);
    if ($verCode !== 0) {
        bail('composer binary not found in $PATH');
    }

    $cmd         = composerCommand($args);
    $outputLines = [];
    $exitCode    = 0;
    exec($cmd, $outputLines, $exitCode);
    $output = implode("\n", $outputLines);

    if ($exitCode !== 0) {
        if ($backup !== null) {
            restoreComposerState($backup);
        }
        if (isset($GLOBALS['composerJsonPath'], $GLOBALS['targetDir'], $GLOBALS['composerDir'])) {
            restoreOwnership($GLOBALS['composerJsonPath'], $GLOBALS['targetDir'], $GLOBALS['composerDir']);
        }
        fwrite(STDERR, "ERROR: composer failed (exit {$exitCode}):\n{$output}\n");
        echo json_encode(['success' => false, 'error' => "composer failed (exit {$exitCode}): {$output}"], JSON_UNESCAPED_SLASHES);
        exit($exitCode);
    }

    if (!$silentOnSuccess) {
        echo json_encode(['success' => true, 'output' => $output], JSON_UNESCAPED_SLASHES);
    }
    
    return $output;
}

function restoreOwnership(string $composerJsonPath, string $targetDir, string $composerDir): void
{
    $stat = @stat($composerJsonPath);
    if (!$stat) {
        return;
    }
    $uid = $stat['uid'];
    $gid = $stat['gid'];

    $pathsToChown = [
        $composerJsonPath,
        $composerDir . '/composer.lock',
        $composerDir . '/auth.json',
    ];

    foreach ($pathsToChown as $path) {
        if (file_exists($path)) {
            @chown($path, $uid);
            @chgrp($path, $gid);
        }
    }

    $vendorDir = $composerDir . '/vendor';
    if (is_dir($vendorDir)) {
        exec(sprintf('chown -R %d:%d %s', $uid, $gid, escapeshellarg($vendorDir)));
    }

    $absTargetDir = $composerDir . '/' . $targetDir;
    if (is_dir($absTargetDir)) {
        exec(sprintf('chown -R %d:%d %s', $uid, $gid, escapeshellarg($absTargetDir)));
    }
}

function deleteManagedTarget(string $composerDir, string $targetDir, string $slug): bool
{
    if (!preg_match('/^[a-z0-9_-]+$/', $slug)) {
        bail("Refusing to delete invalid slug: {$slug}");
    }

    $allowedTargets = [
        'web/app/plugins',
        'wp-content/plugins',
        'web/app/themes',
        'wp-content/themes',
    ];
    if (!in_array($targetDir, $allowedTargets, true)) {
        bail("Refusing to delete outside managed plugin/theme directories: {$targetDir}");
    }

    $base = realpath($composerDir . '/' . $targetDir);
    if ($base === false || !is_dir($base)) {
        return false;
    }

    $target = $base . DIRECTORY_SEPARATOR . $slug;
    if (!is_dir($target)) {
        return false;
    }

    $realTarget = realpath($target);
    if ($realTarget === false || strpos($realTarget, $base . DIRECTORY_SEPARATOR) !== 0) {
        bail("Refusing to delete unsafe target path: {$target}");
    }

    exec('rm -rf ' . escapeshellarg($realTarget), $out, $code);
    if ($code !== 0) {
        bail("Failed to delete target directory: {$realTarget}");
    }

    return true;
}

function normalizeGitUrl(string $url): string
{
    if (preg_match('/^git@([a-zA-Z0-9._-]+):([a-zA-Z0-9._\/-]+?)(?:\.git)?$/', $url, $matches)) {
        $url = "https://{$matches[1]}/{$matches[2]}";
    }
    $parts = parse_url($url);
    $host = $parts['host'] ?? '';
    $path = $parts['path'] ?? '';
    $path = ltrim($path, '/');
    if (substr($path, -4) === '.git') {
        $path = substr($path, 0, -4);
    }
    $path = rtrim($path, '/');
    return $host . '/' . $path;
}

function bail(string $msg): void
{
    fwrite(STDERR, "ERROR: {$msg}\n");
    echo json_encode(['success' => false, 'error' => $msg], JSON_UNESCAPED_SLASHES);
    exit(1);
}

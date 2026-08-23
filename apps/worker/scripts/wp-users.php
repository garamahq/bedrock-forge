<?php
/**
 * Bedrock Forge — WP user scanner
 *
 * Usage (preferred — credentials pre-resolved by the API):
 *   php wp-users.php --creds-file=/tmp/bf-wp-creds-xxx.json [--docroot=/path/to/wp]
 *
 * Usage (fallback — script searches for .env / wp-config.php itself):
 *   php wp-users.php --docroot=/path/to/wp
 *
 * Outputs a JSON object:  { "users": [...] }
 * Never evals, requires, or sources any config file.
 */

declare(strict_types=1);

// ── Helper: extract a single key's value from a .env line ────────────────────
function parseEnvValue(string $line, string $key): ?string {
    $trimmed = ltrim($line);
    // Optional export prefix
    if (strpos($trimmed, 'export ') === 0) {
        $trimmed = ltrim(substr($trimmed, 7));
    }
    $klen = strlen($key);
    if (substr($trimmed, 0, $klen) !== $key) return null;
    $rest = ltrim(substr($trimmed, $klen));
    if ($rest === '' || $rest[0] !== '=') return null;
    $value = ltrim(substr($rest, 1));
    if ($value === '') return '';
    if ($value[0] === '"') {
        if (preg_match('/^"((?:[^"\\\\]|\\\\.)*)"/', $value, $m)) {
            return stripcslashes($m[1]);
        }
        return null;
    }
    if ($value[0] === "'") {
        $end = strpos($value, "'", 1);
        return $end !== false ? substr($value, 1, $end - 1) : null;
    }
    // Unquoted: comments start with # preceded by whitespace
    $clean = preg_replace('/\s+#.*$/', '', $value);
    $clean = trim((string)$clean);
    return $clean;
}

// ── Helper: search docroot for .env and wp-config.php and extract DB creds ───
function extractDbCredentialsFromDocroot(string $docroot): ?array {
    if ($docroot === '') return null;

    $envFile = '';
    $wpConfig = '';

    $searchDirs = [$docroot, $docroot . '/..', $docroot . '/../..'];
    foreach ($searchDirs as $dir) {
        $real = realpath($dir);
        if ($real === false) continue;
        if ($envFile === '' && file_exists($real . '/.env')) {
            $preview = (string)@file_get_contents($real . '/.env', false, null, 0, 512);
            if (str_contains($preview, 'DB_HOST') || str_contains($preview, 'DATABASE_URL') || str_contains($preview, 'DB_NAME')) {
                $envFile = $real . '/.env';
            }
        }
        if ($wpConfig === '' && file_exists($real . '/wp-config.php')) {
            $wpConfig = $real . '/wp-config.php';
        }
    }

    $dbHost = '';
    $dbUser = '';
    $dbPass = '';
    $dbName = '';
    $tablePrefix = 'wp_';

    if ($envFile !== '') {
        $lines = @file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if ($lines !== false) {
            foreach ($lines as $line) {
                $line = trim($line);
                if ($line === '' || $line[0] === '#') continue;
                if (($v = parseEnvValue($line, 'DB_HOST')) !== null) $dbHost = $v;
                if (($v = parseEnvValue($line, 'DB_USER')) !== null) $dbUser = $v;
                if (($v = parseEnvValue($line, 'DB_PASSWORD')) !== null) $dbPass = $v;
                if (($v = parseEnvValue($line, 'DB_NAME')) !== null) $dbName = $v;
                if (($v = parseEnvValue($line, 'DB_PREFIX')) !== null) $tablePrefix = $v;
                if (($v = parseEnvValue($line, 'table_prefix')) !== null) $tablePrefix = $v;

                if ($dbHost === '' && preg_match(
                    '/^(?:export\s+)?DATABASE_URL\s*=\s*["\']?mysql:\/\/([^:@\/\s]+):([^@\/\s]*)@([^\/:"\'#\s]+)(?::\d+)?\/([^"\'?#\s\/]+)/i',
                    $line, $m
                )) {
                    $dbUser = urldecode($m[1]);
                    $dbPass = urldecode($m[2]);
                    $dbHost = $m[3];
                    $dbName = $m[4];
                }
            }
        }
    }

    if (($dbHost === '' || $dbUser === '' || $dbName === '') && $wpConfig !== '') {
        $content = (string)@file_get_contents($wpConfig);
        if (preg_match("/define\s*\(\s*['\"]DB_HOST['\"]\s*,\s*['\"]([^'\"]+)['\"]/", $content, $m)) $dbHost = $m[1];
        if (preg_match("/define\s*\(\s*['\"]DB_USER['\"]\s*,\s*['\"]([^'\"]+)['\"]/", $content, $m)) $dbUser = $m[1];
        if (preg_match("/define\s*\(\s*['\"]DB_PASSWORD['\"]\s*,\s*['\"]([^'\"]+)['\"]/", $content, $m)) $dbPass = $m[1];
        if (preg_match("/define\s*\(\s*['\"]DB_NAME['\"]\s*,\s*['\"]([^'\"]+)['\"]/", $content, $m)) $dbName = $m[1];
        if (preg_match('/\$table_prefix\s*=\s*[\'"]([^\'"]+)[\'"]/', $content, $m)) $tablePrefix = $m[1];
    }

    if ($dbName === '' || $dbUser === '') {
        return null;
    }

    return [
        'dbHost' => $dbHost !== '' ? $dbHost : 'localhost',
        'dbUser' => $dbUser,
        'dbPassword' => $dbPass,
        'dbName' => $dbName,
        'tablePrefix' => $tablePrefix,
    ];
}

// ── Connect via PDO (with multi-tier host/socket fallback) ────────────────────
function tryPdoConnect(string $dbHost, string $dbUser, string $dbPass, string $dbName, ?string &$errorOut): ?PDO {
    if (!extension_loaded('pdo_mysql')) {
        $errorOut = 'pdo_mysql extension not loaded';
        return null;
    }

    $hostsToTry = [$dbHost];
    if ($dbHost === 'localhost') {
        $hostsToTry[] = '127.0.0.1';
    } elseif ($dbHost === '127.0.0.1') {
        $hostsToTry[] = 'localhost';
    }

    $socketPaths = ['/var/run/mysqld/mysqld.sock', '/tmp/mysql.sock', '/run/mysqld/mysqld.sock', '/var/lib/mysql/mysql.sock'];

    foreach ($hostsToTry as $h) {
        try {
            $dsn = "mysql:host={$h};dbname={$dbName};charset=utf8mb4";
            return new PDO($dsn, $dbUser, $dbPass, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_TIMEOUT => 5,
            ]);
        } catch (PDOException $e) {
            $errorOut = $e->getMessage();
        }
    }

    foreach ($socketPaths as $sock) {
        if (file_exists($sock)) {
            try {
                $dsn = "mysql:unix_socket={$sock};dbname={$dbName};charset=utf8mb4";
                return new PDO($dsn, $dbUser, $dbPass, [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                    PDO::ATTR_TIMEOUT => 5,
                ]);
            } catch (PDOException $e) {
                $errorOut = $e->getMessage();
            }
        }
    }

    return null;
}

// ── Fallback: Query MySQL via mysql CLI with temporary .my.cnf ────────────────
function tryMysqlCliQuery(string $dbHost, string $dbUser, string $dbPass, string $dbName, string $sql, ?string &$errorOut): array|false {
    $tmpDir = sys_get_temp_dir();
    $mycnf = tempnam($tmpDir, 'bf_wp_cnf_');
    if ($mycnf === false) {
        $errorOut = 'Could not create temp credentials file';
        return false;
    }

    $cnfContent = "[client]\nuser=" . addcslashes($dbUser, "\n\r\\") . "\npassword=" . addcslashes($dbPass, "\n\r\\") . "\nhost=" . addcslashes($dbHost, "\n\r\\") . "\n";
    file_put_contents($mycnf, $cnfContent);
    chmod($mycnf, 0600);

    $cmd = sprintf(
        'mysql --defaults-extra-file=%s %s -sN -e %s 2>&1',
        escapeshellarg($mycnf),
        escapeshellarg($dbName),
        escapeshellarg($sql)
    );

    exec($cmd, $output, $code);
    @unlink($mycnf);

    if ($code !== 0) {
        $errorOut = 'mysql CLI error: ' . implode("\n", $output);
        return false;
    }

    return $output;
}

// ── Query users via PDO ───────────────────────────────────────────────────────
function fetchUsersViaPdo(PDO $pdo, string $dbName, string $tablePrefix): array {
    try {
        $prefixQuery = "SELECT REPLACE(table_name, 'options', '') as prefix FROM information_schema.tables WHERE table_schema = :dbName AND table_name LIKE '%options' LIMIT 1";
        $prefixStmt = $pdo->prepare($prefixQuery);
        $prefixStmt->execute(['dbName' => $dbName]);
        $prefixRow = $prefixStmt->fetch();
        if ($prefixRow) {
            $prefixRow = array_change_key_case($prefixRow, CASE_LOWER);
            if (!empty($prefixRow['prefix'])) {
                $tablePrefix = $prefixRow['prefix'];
            }
        }
    } catch (Exception $e) {
        // Fallback to parsed table prefix
    }

    $usersTable = $tablePrefix . 'users';
    $metaTable = $tablePrefix . 'usermeta';
    $capsKey = $tablePrefix . 'capabilities';

    $stmt = $pdo->prepare(
        "SELECT u.ID AS id, u.user_login, u.user_email, u.display_name, u.user_registered,
                m.meta_value AS capabilities
         FROM `{$usersTable}` u
         LEFT JOIN `{$metaTable}` m ON m.user_id = u.ID AND (m.meta_key = :capsKey OR m.meta_key LIKE '%capabilities')
         ORDER BY u.ID ASC"
    );
    $stmt->execute(['capsKey' => $capsKey]);
    $rows = $stmt->fetchAll();

    $users = [];
    $seenIds = [];
    foreach ($rows as $rawRow) {
        if (!is_array($rawRow)) continue;
        $row = array_change_key_case($rawRow, CASE_LOWER);
        $id = (int)($row['id'] ?? 0);
        if ($id <= 0 || isset($seenIds[$id])) {
            continue;
        }
        $seenIds[$id] = true;

        $login = (string)($row['user_login'] ?? '');
        $email = (string)($row['user_email'] ?? '');
        $display = (string)($row['display_name'] ?? '');
        $reg = (string)($row['user_registered'] ?? '');

        $caps = @unserialize((string)($row['capabilities'] ?? ''));
        $roles = (is_array($caps)) ? array_keys(array_filter($caps)) : [];

        $users[] = [
            'id' => $id,
            'user_login' => $login,
            'user_email' => $email,
            'display_name' => $display !== '' ? $display : $login,
            'user_registered' => $reg,
            'roles' => array_values($roles),
        ];
    }
    return $users;
}

// ── Query users via MySQL CLI ─────────────────────────────────────────────────
function fetchUsersViaMysqlCli(string $dbHost, string $dbUser, string $dbPass, string $dbName, string $tablePrefix, ?string &$errorOut): ?array {
    // 1. Detect table prefix
    $prefixSql = "SELECT REPLACE(table_name, 'options', '') FROM information_schema.tables WHERE table_schema = '{$dbName}' AND table_name LIKE '%options' LIMIT 1;";
    $prefixRes = tryMysqlCliQuery($dbHost, $dbUser, $dbPass, $dbName, $prefixSql, $errorOut);
    if ($prefixRes !== false && !empty($prefixRes[0])) {
        $tablePrefix = trim($prefixRes[0]);
    }

    $usersTable = $tablePrefix . 'users';
    $metaTable = $tablePrefix . 'usermeta';
    $capsKey = $tablePrefix . 'capabilities';

    $querySql = "SELECT u.ID, COALESCE(u.user_login, ''), COALESCE(u.user_email, ''), COALESCE(u.display_name, ''), COALESCE(u.user_registered, ''), TO_BASE64(COALESCE(m.meta_value, '')) FROM `{$usersTable}` u LEFT JOIN `{$metaTable}` m ON m.user_id = u.ID AND (m.meta_key = '{$capsKey}' OR m.meta_key LIKE '%capabilities') ORDER BY u.ID ASC;";

    $res = tryMysqlCliQuery($dbHost, $dbUser, $dbPass, $dbName, $querySql, $errorOut);
    if ($res === false) {
        return null;
    }

    $users = [];
    $seenIds = [];
    foreach ($res as $line) {
        $line = trim($line);
        if ($line === '') continue;
        $cols = explode("\t", $line);
        $id = (int)($cols[0] ?? 0);
        if ($id <= 0 || isset($seenIds[$id])) {
            continue;
        }
        $seenIds[$id] = true;

        $login = (string)($cols[1] ?? '');
        $email = (string)($cols[2] ?? '');
        $display = (string)($cols[3] ?? '');
        $reg = (string)($cols[4] ?? '');
        $b64Caps = (string)($cols[5] ?? '');
        $capsRaw = $b64Caps !== '' ? (string)@base64_decode($b64Caps) : '';

        $caps = @unserialize($capsRaw);
        $roles = (is_array($caps)) ? array_keys(array_filter($caps)) : [];

        $users[] = [
            'id' => $id,
            'user_login' => $login,
            'user_email' => $email,
            'display_name' => $display !== '' ? $display : $login,
            'user_registered' => $reg,
            'roles' => array_values($roles),
        ];
    }
    return $users;
}

// ── WP-CLI fallback (supports --allow-root and common bin paths) ───────────────
function tryWpCli(string $docroot): ?array {
    if ($docroot === '') return null;

    $wpPaths = [$docroot, $docroot . '/web/wp', $docroot . '/wp'];
    $wpBins = [
        'wp',
        '/usr/local/bin/wp',
        '/usr/bin/wp',
        '/usr/local/lsws/lsphp83/bin/wp',
        '/usr/local/lsws/lsphp82/bin/wp',
        '/root/.wp-cli/builds/gh-pages/phar/wp-cli.phar',
    ];

    foreach ($wpPaths as $p) {
        if (!file_exists($p . '/wp-includes/version.php') && !file_exists($p . '/wp-config.php') && !file_exists($p . '/../config/application.php')) {
            continue;
        }

        foreach ($wpBins as $wpBin) {
            $cmd = sprintf(
                '%s user list --path=%s --fields=ID,user_login,user_email,display_name,user_registered,roles --format=json --allow-root 2>/dev/null',
                escapeshellcmd($wpBin),
                escapeshellarg($p)
            );
            $wpCliOut = @shell_exec($cmd);
            if ($wpCliOut) {
                $decoded = json_decode(trim($wpCliOut), true);
                if (is_array($decoded)) {
                    $users = [];
                    $seenIds = [];
                    foreach ($decoded as $rawRow) {
                        if (!is_array($rawRow)) continue;
                        $row = array_change_key_case($rawRow, CASE_LOWER);
                        $id = (int)($row['id'] ?? 0);
                        if ($id <= 0 || isset($seenIds[$id])) {
                            continue;
                        }
                        $seenIds[$id] = true;

                        $rolesRaw = $row['roles'] ?? null;
                        $roles = is_array($rolesRaw)
                            ? $rolesRaw
                            : array_filter(array_map('trim', explode(',', (string)($rolesRaw ?? ''))));
                        $login = (string)($row['user_login'] ?? '');
                        $email = (string)($row['user_email'] ?? '');
                        $display = (string)($row['display_name'] ?? '');
                        $reg = (string)($row['user_registered'] ?? '');

                        $users[] = [
                            'id' => $id,
                            'user_login' => $login,
                            'user_email' => $email,
                            'display_name' => $display !== '' ? $display : $login,
                            'user_registered' => $reg,
                            'roles' => array_values($roles),
                        ];
                    }
                    return $users;
                }
            }
        }
    }
    return null;
}

// ── Main Execution ────────────────────────────────────────────────────────────

$opts = getopt('', ['docroot:', 'creds-file:']);
$credsFile = (string)($opts['creds-file'] ?? '');
$docroot = rtrim((string)($opts['docroot'] ?? ''), '/');

$candidates = [];

// 1. Read passed creds file
if ($credsFile !== '') {
    if (file_exists($credsFile)) {
        $raw = @file_get_contents($credsFile);
        @unlink($credsFile);
        if ($raw !== false) {
            $c = json_decode($raw, true);
            if (is_array($c) && !empty($c['dbName']) && !empty($c['dbUser'])) {
                $candidates[] = [
                    'dbHost' => (string)($c['dbHost'] ?? 'localhost'),
                    'dbUser' => (string)($c['dbUser'] ?? ''),
                    'dbPassword' => (string)($c['dbPassword'] ?? ''),
                    'dbName' => (string)($c['dbName'] ?? ''),
                    'tablePrefix' => (string)($c['tablePrefix'] ?? 'wp_'),
                    'source' => 'creds-file',
                ];
            }
        }
    }
}

// 2. Also extract from docroot as candidate/fallback
if ($docroot !== '') {
    $fromDocroot = extractDbCredentialsFromDocroot($docroot);
    if ($fromDocroot) {
        $fromDocroot['source'] = 'docroot-env';
        // Avoid duplicate if identical
        $duplicate = false;
        foreach ($candidates as $cand) {
            if ($cand['dbUser'] === $fromDocroot['dbUser'] &&
                $cand['dbPassword'] === $fromDocroot['dbPassword'] &&
                $cand['dbName'] === $fromDocroot['dbName'] &&
                $cand['dbHost'] === $fromDocroot['dbHost']) {
                $duplicate = true;
                break;
            }
        }
        if (!$duplicate) {
            $candidates[] = $fromDocroot;
        }
    }
}

$lastError = '';

// Try each credential set
foreach ($candidates as $cred) {
    $dbHost = $cred['dbHost'];
    $dbUser = $cred['dbUser'];
    $dbPass = $cred['dbPassword'];
    $dbName = $cred['dbName'];
    $tablePrefix = $cred['tablePrefix'] ?? 'wp_';

    // Tier 1: Try PDO
    $pdo = tryPdoConnect($dbHost, $dbUser, $dbPass, $dbName, $lastError);
    if ($pdo !== null) {
        try {
            $users = fetchUsersViaPdo($pdo, $dbName, $tablePrefix);
            echo json_encode(['users' => $users], JSON_PRETTY_PRINT);
            exit(0);
        } catch (Exception $e) {
            $lastError = $e->getMessage();
        }
    }

    // Tier 2: Try MySQL CLI with temporary .my.cnf
    $cliUsers = fetchUsersViaMysqlCli($dbHost, $dbUser, $dbPass, $dbName, $tablePrefix, $lastError);
    if ($cliUsers !== null) {
        echo json_encode(['users' => $cliUsers], JSON_PRETTY_PRINT);
        exit(0);
    }
}

// Tier 3: Try WP-CLI
if ($docroot !== '') {
    $wpCliUsers = tryWpCli($docroot);
    if ($wpCliUsers !== null) {
        echo json_encode(['users' => $wpCliUsers], JSON_PRETTY_PRINT);
        exit(0);
    }
}

// If no candidates found at all
if (empty($candidates)) {
    echo json_encode([
        'users' => [],
        'error' => 'No DB credentials provided or found in docroot (.env / wp-config.php)',
    ], JSON_PRETTY_PRINT);
    exit(0);
}

// All tiers failed
echo json_encode([
    'users' => [],
    'error' => 'DB connection failed: ' . ($lastError ?: 'Unknown error'),
], JSON_PRETTY_PRINT);
exit(0);

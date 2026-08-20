#!/usr/bin/env php
<?php
/**
 * Serialization-aware search-replace for WordPress databases.
 *
 * Uses the `mysql` CLI binary for all database access — no PHP database
 * extensions required.  Works on CyberPanel/LiteSpeed servers where the
 * default PHP CLI has no mysqli or pdo_mysql module.
 *
 * Usage (preferred — pass a pre-built .my.cnf):
 *   php search-replace.php \
 *     --mycnf=/tmp/forge_sr.cnf --db-name=mydb \
 *     --search='https://old.example.com' --replace='https://new.example.com' \
 *     [--prefix=wp_] [--skip-tables=wp_posts,wp_ct_registrations] [--dry-run]
 *
 * Usage (backward-compat — script creates a temp .my.cnf internally):
 *   php search-replace.php \
 *     --db-host=localhost --db-user=x --db-pass=x --db-name=x \
 *     --search='https://old.example.com' --replace='https://new.example.com'
 *
 * Exit codes: 0 = success, 1 = error
 * Output: JSON { tables_scanned, rows_affected, errors }
 */

error_reporting(E_ALL);
set_time_limit(0);

// ── Parse CLI arguments ─────────────────────────────────────────────────

$opts = [];
foreach ($argv as $i => $arg) {
    if ($i === 0) continue;
    if (preg_match('/^--([a-z0-9_-]+)=(.*)$/i', $arg, $m)) {
        $opts[$m[1]] = $m[2];
    } elseif (preg_match('/^--([a-z0-9_-]+)$/i', $arg, $m)) {
        $opts[$m[1]] = true;
    }
}

// --db-name, --search, --replace always required
foreach (['db-name', 'search', 'replace'] as $key) {
    if (!isset($opts[$key])) {
        fwrite(STDERR, "Missing required argument: --$key\n");
        exit(1);
    }
}
// Either --mycnf or all three of --db-host/--db-user/--db-pass
if (!isset($opts['mycnf']) && (!isset($opts['db-host'], $opts['db-user'], $opts['db-pass']))) {
    fwrite(STDERR, "Provide either --mycnf=<path> or all of --db-host, --db-user, --db-pass\n");
    exit(1);
}

$dbName = $opts['db-name'];
$search = $opts['search'];
$replace = $opts['replace'];
$prefix  = $opts['prefix'] ?? 'wp_';
$dryRun  = isset($opts['dry-run']);
$skipTables = [];
if (isset($opts['skip-tables']) && trim((string) $opts['skip-tables']) !== '') {
    foreach (explode(',', (string) $opts['skip-tables']) as $table) {
        $table = trim($table);
        if ($table !== '' && preg_match('/^[A-Za-z0-9_$]+$/', $table)) {
            $skipTables[$table] = true;
        }
    }
}

// ── Credentials (.my.cnf) ────────────────────────────────────────────────

$ownedMycnf = false; // did we create the temp file? must delete at end
if (isset($opts['mycnf'])) {
    $mycnf = $opts['mycnf'];
} else {
    $mycnf = tempnam(sys_get_temp_dir(), 'forge_sr_mycnf_');
    file_put_contents($mycnf,
        "[client]\nuser={$opts['db-user']}\npassword={$opts['db-pass']}\nhost={$opts['db-host']}\n"
    );
    chmod($mycnf, 0600);
    $ownedMycnf = true;
}

// ── MySQL helpers ────────────────────────────────────────────────────────

/**
 * Run a single SQL statement via the mysql CLI.
 * Returns array of output lines on success, false on failure.
 */
function db_query(string $mycnf, string $dbName, string $sql): array|false {
    $cmd = sprintf(
        'mysql --defaults-extra-file=%s %s -sN -e %s 2>&1',
        escapeshellarg($mycnf),
        escapeshellarg($dbName),
        escapeshellarg($sql)
    );
    exec($cmd, $output, $code);
    if ($code !== 0) {
        fwrite(STDERR, 'mysql error: ' . implode("\n", $output) . "\n");
        return false;
    }
    return $output;
}

/**
 * Execute SQL from a file (avoids shell-quoting limits for large batches).
 * Returns true on success, false on failure.
 */
function db_exec_file(string $mycnf, string $dbName, string $filePath): bool {
    $cmd = sprintf(
        'mysql --defaults-extra-file=%s %s < %s 2>&1',
        escapeshellarg($mycnf),
        escapeshellarg($dbName),
        escapeshellarg($filePath)
    );
    exec($cmd, $output, $code);
    if ($code !== 0) {
        fwrite(STDERR, 'mysql batch error: ' . implode("\n", $output) . "\n");
        return false;
    }
    return true;
}

/**
 * Quote a scalar PK value for safe use in a generated SQL literal.
 * Only call this on values read back from the database (trusted source).
 * For row data written back we always use UNHEX().
 */
function sql_literal(string $val): string {
    // Numeric (covers INT/BIGINT PKs — the vast majority of WP tables)
    if (ctype_digit($val) || (strlen($val) > 1 && $val[0] === '-' && ctype_digit(substr($val, 1)))) {
        return $val;
    }
    // String: escape backslashes and single quotes
    return "'" . str_replace(['\\', "'"], ['\\\\', "\\'"], $val) . "'";
}

// ── Discover tables and text columns ────────────────────────────────────

$dbn = str_replace(['\\', "'"], ['\\\\', "\\'"], $dbName);
$pfx = str_replace(['\\', "'"], ['\\\\', "\\'"], $prefix);

$colRows = db_query($mycnf, $dbName,
    "SELECT TABLE_NAME, COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = '$dbn'
       AND TABLE_NAME LIKE '$pfx%'
       AND DATA_TYPE IN ('varchar','text','mediumtext','longtext')
     ORDER BY TABLE_NAME, ORDINAL_POSITION"
);

if ($colRows === false) {
    if ($ownedMycnf) @unlink($mycnf);
    fwrite(STDERR, "Failed to query information_schema\n");
    exit(1);
}

$tableColumns = [];
foreach ($colRows as $line) {
    $parts = explode("\t", $line, 2);
    if (count($parts) === 2) {
        $table = trim($parts[0]);
        if (isset($skipTables[$table])) {
            continue;
        }
        $tableColumns[$table][] = trim($parts[1]);
    }
}

// ── Serialization-aware replacement ─────────────────────────────────────

/**
 * Recursively walk a PHP value, replacing $search with $replace across raw,
 * JSON-escaped slashes (\/), and URL-encoded variants.
 */
function sr_deep_replace($data, string $search, string $replace) {
    if (is_string($data)) {
        $val = str_replace($search, $replace, $data);
        $jsonSearch = str_replace('/', '\/', $search);
        if ($jsonSearch !== $search) {
            $jsonReplace = str_replace('/', '\/', $replace);
            $val = str_replace($jsonSearch, $jsonReplace, $val);
        }
        $urlEncSearch = rawurlencode($search);
        if ($urlEncSearch !== $search) {
            $urlEncReplace = rawurlencode($replace);
            $val = str_replace($urlEncSearch, $urlEncReplace, $val);
        }
        return $val;
    }
    if (is_array($data)) {
        $out = [];
        foreach ($data as $key => $value) {
            $newKey = is_string($key) ? sr_deep_replace($key, $search, $replace) : $key;
            $out[$newKey] = sr_deep_replace($value, $search, $replace);
        }
        return $out;
    }
    if (is_object($data)) {
        return (object) sr_deep_replace((array) $data, $search, $replace);
    }
    return $data;
}

/**
 * Perform search-replace on a single DB value, handling PHP serialized data.
 * Returns [new_value, changed].
 */
function sr_replace_value(string $value, string $search, string $replace): array {
    $jsonSearch = str_replace('/', '\/', $search);
    $urlEncSearch = rawurlencode($search);

    $hasMatch = (strpos($value, $search) !== false) ||
                ($jsonSearch !== $search && strpos($value, $jsonSearch) !== false) ||
                ($urlEncSearch !== $search && strpos($value, $urlEncSearch) !== false);

    if (!$hasMatch) {
        return [$value, false];
    }

    $unserialized = @unserialize($value);
    if ($unserialized !== false || $value === 'b:0;') {
        $replaced = sr_deep_replace($unserialized, $search, $replace);
        $newValue = serialize($replaced);
        return [$newValue, $newValue !== $value];
    }

    $newValue = sr_deep_replace($value, $search, $replace);
    return [$newValue, $newValue !== $value];
}

// ── Process tables ──────────────────────────────────────────────────────

$totalAffected = 0;
$tablesScanned = 0;
$errors        = [];

$searchVariants = array_values(array_unique(array_filter([
    $search,
    str_replace('/', '\/', $search),
    rawurlencode($search),
])));
$replaceVariants = [
    $replace,
    str_replace('/', '\/', $replace),
    rawurlencode($replace),
];
$searchHexes = array_map('bin2hex', $searchVariants);

foreach ($tableColumns as $table => $columns) {
    $tablesScanned++;
    $tbl = str_replace(['\\', "'"], ['\\\\', "\\'"], $table);

    // Discover primary key columns
    $pkRows = db_query($mycnf, $dbName,
        "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = '$dbn'
           AND TABLE_NAME = '$tbl'
           AND CONSTRAINT_NAME = 'PRIMARY'
         ORDER BY ORDINAL_POSITION"
    );
    $pkCols = [];
    if ($pkRows !== false) {
        foreach ($pkRows as $pk) {
            $pk = trim($pk);
            if ($pk !== '') $pkCols[] = $pk;
        }
    }

    if (empty($pkCols)) {
        // No primary key — fall back to plain SQL REPLACE (no serialization fix)
        foreach ($columns as $col) {
            if (!$dryRun) {
                foreach ($searchVariants as $idx => $sVar) {
                    $rVar = $replaceVariants[$idx] ?? $replace;
                    $sHex = bin2hex($sVar);
                    $rHex = bin2hex($rVar);
                    $sql = "UPDATE `$table` SET `$col` = REPLACE(`$col`, UNHEX('$sHex'), UNHEX('$rHex'))"
                         . " WHERE LOCATE(UNHEX('$sHex'), `$col`) > 0";
                    db_query($mycnf, $dbName, $sql);
                }
            }
        }
        continue;
    }

    // SELECT: PK cols as-is, text cols HEX()-encoded for safe transport of
    // serialized PHP data (which may contain tabs, newlines, binary chars).
    $pkSelects  = array_map(fn($c) => "`$c`", $pkCols);
    $hexSelects = array_map(fn($c) => "HEX(`$c`) AS `$c`", $columns);
    $allSelects = array_merge($pkSelects, $hexSelects);

    // LOCATE() avoids LIKE wildcard issues for search strings that contain % or _
    $locateClauses = [];
    foreach ($columns as $c) {
        foreach ($searchHexes as $sHex) {
            $locateClauses[] = "LOCATE(UNHEX('$sHex'), `$c`) > 0";
        }
    }

    $query = "SELECT " . implode(', ', $allSelects) . " FROM `$table`"
           . " WHERE " . implode(' OR ', $locateClauses);
    $rows = db_query($mycnf, $dbName, $query);
    if ($rows === false) {
        $errors[] = "SELECT on $table failed";
        continue;
    }

    $pkCount  = count($pkCols);
    $colCount = count($columns);
    $updateStatements = [];

    foreach ($rows as $line) {
        if (trim($line) === '') continue;
        $parts = explode("\t", $line);
        // Pad to expected length (mysql outputs NULL as literal "NULL")
        while (count($parts) < $pkCount + $colCount) {
            $parts[] = 'NULL';
        }

        $pkValues  = array_slice($parts, 0, $pkCount);
        $colValues = array_slice($parts, $pkCount, $colCount);

        $setClauses = [];
        foreach ($columns as $i => $col) {
            $hexVal = $colValues[$i] ?? 'NULL';
            if ($hexVal === 'NULL' || $hexVal === '') continue;
            $rawVal = hex2bin($hexVal);
            if ($rawVal === false) continue;
            [$newVal, $changed] = sr_replace_value($rawVal, $search, $replace);
            if ($changed) {
                $setClauses[] = "`$col` = UNHEX('" . bin2hex($newVal) . "')";
            }
        }
        if (empty($setClauses)) continue;
        if ($dryRun) { $totalAffected++; continue; }

        $whereClauses = [];
        foreach ($pkCols as $j => $pk) {
            $whereClauses[] = "`$pk` = " . sql_literal($pkValues[$j] ?? '0');
        }
        $updateStatements[] = "UPDATE `$table` SET " . implode(', ', $setClauses)
                            . " WHERE " . implode(' AND ', $whereClauses) . " LIMIT 1;";
        $totalAffected++;
    }

    if (!empty($updateStatements)) {
        $tmpSql = tempnam(sys_get_temp_dir(), 'forge_sr_upd_');
        file_put_contents($tmpSql, implode("\n", $updateStatements) . "\n");
        if (!db_exec_file($mycnf, $dbName, $tmpSql)) {
            $errors[] = "UPDATE batch on $table failed";
        }
        @unlink($tmpSql);
    }
}

if ($ownedMycnf) @unlink($mycnf);

echo json_encode([
    'tables_scanned' => $tablesScanned,
    'rows_affected'  => $totalAffected,
    'errors'         => $errors,
], JSON_UNESCAPED_SLASHES);
exit(0);

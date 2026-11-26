#!/usr/bin/env php
<?php
/**
 * Serialization-aware search-replace for WordPress databases.
 *
 * Uses the `mysql` CLI binary for all database access — no PHP database
 * extensions required. Works on CyberPanel/LiteSpeed servers where the
 * default PHP CLI has no mysqli or pdo_mysql module.
 *
 * Rewrites serialized PHP values via a pure byte-accurate stream scanner so
 * custom plugin classes (which become __PHP_Incomplete_Class outside WordPress)
 * keep their exact class names, visibility prefixes, and recalculated byte
 * lengths without instantiating objects or coercing to stdClass (#64).
 *
 * Exit codes: 0 = success (zero errors), 1 = error or partial failure (#60)
 * Output: JSON { tables_scanned, rows_affected, skipped_serialized, errors }
 */

error_reporting(E_ALL);
set_time_limit(0);

/**
 * Quote a scalar PK value for safe use in a generated SQL literal.
 */
function sql_literal(string $val): string {
    if (ctype_digit($val) || (strlen($val) > 1 && $val[0] === '-' && ctype_digit(substr($val, 1)))) {
        return $val;
    }
    return "'" . str_replace(['\\', "'"], ['\\\\', "\\'"], $val) . "'";
}

/**
 * Replace $search with $replace across raw, JSON-escaped (\/), and URL-encoded forms.
 */
function sr_replace_plain(string $data, string $search, string $replace): string {
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

function sr_contains_target(string $value, string $search): bool {
    if (strpos($value, $search) !== false) return true;
    $jsonSearch = str_replace('/', '\/', $search);
    if ($jsonSearch !== $search && strpos($value, $jsonSearch) !== false) return true;
    $urlEncSearch = rawurlencode($search);
    if ($urlEncSearch !== $search && strpos($value, $urlEncSearch) !== false) return true;
    return false;
}

/**
 * Parse a `s:<len>:"<bytes>";` token starting at $pos.
 * Returns raw decoded string bytes on success, or null on syntax mismatch.
 */
function sr_consume_string_token(string $str, int &$pos): ?string {
    $lenAll = strlen($str);
    if ($pos + 5 >= $lenAll || $str[$pos] !== 's' || $str[$pos + 1] !== ':') {
        return null;
    }
    $colonPos = strpos($str, ':', $pos + 2);
    if ($colonPos === false) return null;
    $lenStr = substr($str, $pos + 2, $colonPos - ($pos + 2));
    if ($lenStr === '' || !ctype_digit($lenStr)) return null;
    if ($colonPos + 1 >= $lenAll || $str[$colonPos + 1] !== '"') return null;

    $byteLen = (int) $lenStr;
    $dataStart = $colonPos + 2;
    $dataEnd = $dataStart + $byteLen;
    if ($dataEnd + 2 > $lenAll) return null;
    if ($str[$dataEnd] !== '"' || $str[$dataEnd + 1] !== ';') return null;

    $rawBytes = substr($str, $dataStart, $byteLen);
    $pos = $dataEnd + 2;
    return $rawBytes;
}

/**
 * Recursively rewrite serialized PHP stream without calling unserialize()/serialize()
 * into stdClass (#64). Preserves custom class headers, property visibility prefixes,
 * integers, doubles, booleans, nulls, enums, and references.
 */
function sr_rewrite_serialized(
    string $str,
    string $search,
    string $replace,
    int &$pos,
    bool $allowStringRewrite,
    bool &$skipped
): ?string {
    $lenAll = strlen($str);
    if ($pos >= $lenAll) return null;

    $type = $str[$pos];

    // N;
    if ($type === 'N') {
        if ($pos + 1 >= $lenAll || $str[$pos + 1] !== ';') return null;
        $pos += 2;
        return 'N;';
    }

    // b:0; / b:1;
    if ($type === 'b') {
        if ($pos + 3 >= $lenAll || $str[$pos + 1] !== ':' || ($str[$pos + 2] !== '0' && $str[$pos + 2] !== '1') || $str[$pos + 3] !== ';') {
            return null;
        }
        $tok = substr($str, $pos, 4);
        $pos += 4;
        return $tok;
    }

    // i:<n>; d:<n>; r:<n>; R:<n>;
    if ($type === 'i' || $type === 'd' || $type === 'r' || $type === 'R') {
        if ($pos + 1 >= $lenAll || $str[$pos + 1] !== ':') return null;
        $semi = strpos($str, ';', $pos + 2);
        if ($semi === false) return null;
        $tok = substr($str, $pos, $semi - $pos + 1);
        $pos = $semi + 1;
        return $tok;
    }

    // E:<len>:"<Class::Case>"; (PHP 8.1+ backed/unit enum)
    if ($type === 'E') {
        if ($pos + 1 >= $lenAll || $str[$pos + 1] !== ':') return null;
        $fake = 's' . substr($str, $pos + 1);
        $fakePos = 0;
        $raw = sr_consume_string_token($fake, $fakePos);
        if ($raw === null) return null;
        $tok = substr($str, $pos, $fakePos);
        $pos += $fakePos;
        return $tok;
    }

    // s:<len>:"<bytes>";
    if ($type === 's') {
        $raw = sr_consume_string_token($str, $pos);
        if ($raw === null) return null;

        if (!$allowStringRewrite || strncmp($raw, "\0", 1) === 0) {
            return 's:' . strlen($raw) . ':"' . $raw . '";';
        }

        if (!sr_contains_target($raw, $search)) {
            return 's:' . strlen($raw) . ':"' . $raw . '";';
        }

        // Handle double-serialized PHP payloads cleanly if inner value parses completely
        if (preg_match('/^(?:s:\d+:|a:\d+:|O:\d+:|C:\d+:|r:\d+:|R:\d+:)/', $raw)) {
            $innerPos = 0;
            $innerSkipped = false;
            $innerRewritten = sr_rewrite_serialized($raw, $search, $replace, $innerPos, true, $innerSkipped);
            if ($innerRewritten !== null && $innerPos === strlen($raw) && !$innerSkipped) {
                return 's:' . strlen($innerRewritten) . ':"' . $innerRewritten . '";';
            }
            if ($innerSkipped) {
                $skipped = true;
                return null;
            }
        }

        $newRaw = sr_replace_plain($raw, $search, $replace);
        return 's:' . strlen($newRaw) . ':"' . $newRaw . '";';
    }

    // a:<count>:{...}
    if ($type === 'a') {
        if ($pos + 1 >= $lenAll || $str[$pos + 1] !== ':') return null;
        $colon2 = strpos($str, ':', $pos + 2);
        if ($colon2 === false) return null;
        $countStr = substr($str, $pos + 2, $colon2 - ($pos + 2));
        if ($countStr === '' || !ctype_digit($countStr)) return null;
        if ($colon2 + 1 >= $lenAll || $str[$colon2 + 1] !== '{') return null;

        $count = (int) $countStr;
        $pos = $colon2 + 2;
        $out = 'a:' . $count . ':{';
        for ($i = 0; $i < $count; $i++) {
            $k = sr_rewrite_serialized($str, $search, $replace, $pos, true, $skipped);
            if ($k === null) return null;
            $v = sr_rewrite_serialized($str, $search, $replace, $pos, true, $skipped);
            if ($v === null) return null;
            $out .= $k . $v;
        }
        if ($pos >= $lenAll || $str[$pos] !== '}') return null;
        $pos++;
        return $out . '}';
    }

    // O:<clsLen>:"<clsName>":<propCount>:{...}
    if ($type === 'O') {
        if ($pos + 1 >= $lenAll || $str[$pos + 1] !== ':') return null;
        $colonCls = strpos($str, ':', $pos + 2);
        if ($colonCls === false) return null;
        $clsLenStr = substr($str, $pos + 2, $colonCls - ($pos + 2));
        if ($clsLenStr === '' || !ctype_digit($clsLenStr)) return null;
        if ($colonCls + 1 >= $lenAll || $str[$colonCls + 1] !== '"') return null;

        $clsLen = (int) $clsLenStr;
        $clsStart = $colonCls + 2;
        $clsEnd = $clsStart + $clsLen;
        if ($clsEnd + 2 >= $lenAll || $str[$clsEnd] !== '"' || $str[$clsEnd + 1] !== ':') {
            return null;
        }
        $clsName = substr($str, $clsStart, $clsLen);

        $colonProp = strpos($str, ':', $clsEnd + 2);
        if ($colonProp === false) return null;
        $propCountStr = substr($str, $clsEnd + 2, $colonProp - ($clsEnd + 2));
        if ($propCountStr === '' || !ctype_digit($propCountStr)) return null;
        if ($colonProp + 1 >= $lenAll || $str[$colonProp + 1] !== '{') return null;

        $propCount = (int) $propCountStr;
        $pos = $colonProp + 2;
        $out = 'O:' . $clsLen . ':"' . $clsName . '":' . $propCount . ':{';
        for ($i = 0; $i < $propCount; $i++) {
            // Preserve property names and visibility prefixes (\0Class\0prop / \0*\0prop)
            $k = sr_rewrite_serialized($str, $search, $replace, $pos, false, $skipped);
            if ($k === null) return null;
            $v = sr_rewrite_serialized($str, $search, $replace, $pos, true, $skipped);
            if ($v === null) return null;
            $out .= $k . $v;
        }
        if ($pos >= $lenAll || $str[$pos] !== '}') return null;
        $pos++;
        return $out . '}';
    }

    // C:<clsLen>:"<clsName>":<payloadLen>:{<bytes>} (custom Serializable)
    if ($type === 'C') {
        if ($pos + 1 >= $lenAll || $str[$pos + 1] !== ':') return null;
        $colonCls = strpos($str, ':', $pos + 2);
        if ($colonCls === false) return null;
        $clsLenStr = substr($str, $pos + 2, $colonCls - ($pos + 2));
        if ($clsLenStr === '' || !ctype_digit($clsLenStr)) return null;
        if ($colonCls + 1 >= $lenAll || $str[$colonCls + 1] !== '"') return null;

        $clsLen = (int) $clsLenStr;
        $clsStart = $colonCls + 2;
        $clsEnd = $clsStart + $clsLen;
        if ($clsEnd + 2 >= $lenAll || $str[$clsEnd] !== '"' || $str[$clsEnd + 1] !== ':') {
            return null;
        }
        $clsName = substr($str, $clsStart, $clsLen);

        $colonPayload = strpos($str, ':', $clsEnd + 2);
        if ($colonPayload === false) return null;
        $payloadLenStr = substr($str, $clsEnd + 2, $colonPayload - ($clsEnd + 2));
        if ($payloadLenStr === '' || !ctype_digit($payloadLenStr)) return null;
        if ($colonPayload + 1 >= $lenAll || $str[$colonPayload + 1] !== '{') return null;

        $payloadLen = (int) $payloadPayload = (int) $payloadLenStr;
        $payloadStart = $colonPayload + 2;
        $payloadEnd = $payloadStart + $payloadLen;
        if ($payloadEnd >= $lenAll || $str[$payloadEnd] !== '}') return null;

        $payloadBytes = substr($str, $payloadStart, $payloadLen);
        $pos = $payloadEnd + 1;

        if (sr_contains_target($payloadBytes, $search)) {
            // Custom Serializable payloads have class-owned binary/internal invariants;
            // skip modifying them safely instead of risking corruption or class coercion.
            $skipped = true;
            return null;
        }

        return 'C:' . $clsLen . ':"' . $clsName . '":' . $payloadLen . ':{' . $payloadBytes . '}';
    }

    return null;
}

/**
 * Perform search-replace on a single DB value, preserving serialized PHP structure
 * without executing untrusted plugin classes or coercing objects into stdClass (#64).
 *
 * Returns [new_value, changed, skipped_serialized].
 */
function sr_replace_value(string $value, string $search, string $replace): array {
    if (!sr_contains_target($value, $search)) {
        return [$value, false, 0];
    }

    $looksSerialized = preg_match('/^(?:s:\d+:|a:\d+:|O:\d+:|C:\d+:|E:\d+:)/', $value) === 1;
    if ($looksSerialized || @unserialize($value, ['allowed_classes' => false]) !== false || $value === 'b:0;') {
        $pos = 0;
        $skipped = false;
        $rewritten = sr_rewrite_serialized($value, $search, $replace, $pos, true, $skipped);
        if ($rewritten === null || $pos !== strlen($value) || $skipped) {
            return [$value, false, 1];
        }
        $roundtripOk = $rewritten === 'b:0;' || @unserialize($rewritten, ['allowed_classes' => false]) !== false;
        if (!$roundtripOk) {
            return [$value, false, 1];
        }
        return [$rewritten, $rewritten !== $value, 0];
    }

    $newValue = sr_replace_plain($value, $search, $replace);
    return [$newValue, $newValue !== $value, 0];
}

if (defined('SEARCH_REPLACE_LIB_ONLY')) {
    return;
}

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

foreach (['db-name', 'search', 'replace'] as $key) {
    if (!isset($opts[$key])) {
        fwrite(STDERR, "Missing required argument: --$key\n");
        exit(1);
    }
}
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

$ownedMycnf = false;
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

// ── Process tables ──────────────────────────────────────────────────────

$totalAffected = 0;
$tablesScanned = 0;
$totalSkippedSerialized = 0;
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

    $pkRows = db_query($mycnf, $dbName,
        "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = '$dbn'
           AND TABLE_NAME = '$tbl'
           AND CONSTRAINT_NAME = 'PRIMARY'
         ORDER BY ORDINAL_POSITION"
    );
    if ($pkRows === false) {
        $errors[] = "PRIMARY KEY lookup on $table failed";
        continue;
    }

    $pkCols = [];
    foreach ($pkRows as $pk) {
        $pk = trim($pk);
        if ($pk !== '') $pkCols[] = $pk;
    }

    if (empty($pkCols)) {
        // Keyless table: check every query result and count real ROW_COUNT() only on success (#60)
        foreach ($columns as $col) {
            if ($dryRun) {
                $cntSql = "SELECT COUNT(*) FROM `$table` WHERE LOCATE(UNHEX('" . bin2hex($searchVariants[0]) . "'), `$col`) > 0";
                $cntRes = db_query($mycnf, $dbName, $cntSql);
                if ($cntRes === false) {
                    $errors[] = "DRY-RUN count on $table.$col failed";
                } elseif (!empty($cntRes)) {
                    $totalAffected += (int) trim((string) end($cntRes));
                }
                continue;
            }
            foreach ($searchVariants as $idx => $sVar) {
                $rVar = $replaceVariants[$idx] ?? $replace;
                $sHex = bin2hex($sVar);
                $rHex = bin2hex($rVar);
                $sql = "UPDATE `$table` SET `$col` = REPLACE(`$col`, UNHEX('$sHex'), UNHEX('$rHex'))"
                     . " WHERE LOCATE(UNHEX('$sHex'), `$col`) > 0; SELECT ROW_COUNT();";
                $updRes = db_query($mycnf, $dbName, $sql);
                if ($updRes === false) {
                    $errors[] = "UPDATE on keyless table $table.$col failed";
                } elseif (!empty($updRes)) {
                    $totalAffected += max(0, (int) trim((string) end($updRes)));
                }
            }
        }
        continue;
    }

    $pkSelects  = array_map(fn($c) => "`$c`", $pkCols);
    $hexSelects = array_map(fn($c) => "HEX(`$c`) AS `$c`", $columns);
    $allSelects = array_merge($pkSelects, $hexSelects);

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
    $tableAffected = 0;

    foreach ($rows as $line) {
        if (trim($line) === '') continue;
        $parts = explode("\t", $line);
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
            [$newVal, $changed, $skippedRow] = sr_replace_value($rawVal, $search, $replace);
            if ($skippedRow > 0) {
                $totalSkippedSerialized += $skippedRow;
                $errors[] = "Skipped unsupported serialized object in $table.$col to avoid class coercion";
            }
            if ($changed) {
                $setClauses[] = "`$col` = UNHEX('" . bin2hex($newVal) . "')";
            }
        }
        if (empty($setClauses)) continue;

        $tableAffected++;
        if ($dryRun) continue;

        $whereClauses = [];
        foreach ($pkCols as $j => $pk) {
            $whereClauses[] = "`$pk` = " . sql_literal($pkValues[$j] ?? '0');
        }
        $updateStatements[] = "UPDATE `$table` SET " . implode(', ', $setClauses)
                            . " WHERE " . implode(' AND ', $whereClauses) . " LIMIT 1;";
    }

    if ($dryRun) {
        $totalAffected += $tableAffected;
    } elseif (!empty($updateStatements)) {
        $tmpSql = tempnam(sys_get_temp_dir(), 'forge_sr_upd_');
        file_put_contents($tmpSql, implode("\n", $updateStatements) . "\n");
        $batchOk = db_exec_file($mycnf, $dbName, $tmpSql);
        @unlink($tmpSql);
        if (!$batchOk) {
            $errors[] = "UPDATE batch on $table failed";
        } else {
            // Only count rows after SQL execution succeeds (#60)
            $totalAffected += $tableAffected;
        }
    }
}

if ($ownedMycnf) @unlink($mycnf);

echo json_encode([
    'tables_scanned'     => $tablesScanned,
    'rows_affected'      => $totalAffected,
    'skipped_serialized' => $totalSkippedSerialized,
    'errors'             => $errors,
], JSON_UNESCAPED_SLASHES);
exit(!empty($errors) ? 1 : 0);

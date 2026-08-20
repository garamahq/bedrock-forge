<?php
/**
 * wp-debug.php — Enable/disable WP_DEBUG in Bedrock .env or wp-config.php
 *
 * Args:
 *   --docroot   Absolute path to WordPress/Bedrock root
 *   --action    enable | disable | status
 *
 * Output: JSON { success, was_enabled, now_enabled, modified_file }
 */

$opts     = getopt('', ['docroot:', 'action:']);
$docroot  = rtrim($opts['docroot'] ?? '', '/');
$action   = $opts['action'] ?? 'status';

if (!$docroot || !is_dir($docroot)) {
    echo json_encode(['success' => false, 'error' => 'Missing or invalid --docroot']);
    exit(1);
}

[$file, $isBedrock] = detectFile($docroot);

if (!$file) {
    echo json_encode(['success' => false, 'error' => 'Could not find .env or wp-config.php']);
    exit(1);
}

$content = file_get_contents($file);
$wasEnabled = isDebugEnabled($content, $isBedrock);

if ($action === 'status') {
    echo json_encode(['success' => true, 'was_enabled' => $wasEnabled, 'now_enabled' => $wasEnabled, 'modified_file' => $file]);
    exit(0);
}

$setEnabled = ($action === 'enable');
$newContent = setDebug($content, $setEnabled, $isBedrock);

if ($newContent === $content) {
    // already in desired state
    echo json_encode(['success' => true, 'was_enabled' => $wasEnabled, 'now_enabled' => $setEnabled, 'modified_file' => $file]);
    exit(0);
}

exec('chattr -i -a ' . escapeshellarg($file) . ' 2>/dev/null || true');
@chmod($file, 0644);
file_put_contents($file, $newContent);
@chmod($file, 0440);
echo json_encode(['success' => true, 'was_enabled' => $wasEnabled, 'now_enabled' => $setEnabled, 'modified_file' => $file]);
exit(0);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function detectFile(string $docroot): array {
    // Bedrock .env
    foreach (['.env', '.env.local'] as $f) {
        $p = $docroot . '/' . $f;
        if (file_exists($p) && str_contains(file_get_contents($p), 'WP_ENV')) {
            return [$p, true];
        }
    }
    // Classic wp-config.php
    $wpc = $docroot . '/wp-config.php';
    if (file_exists($wpc)) return [$wpc, false];
    return [null, false];
}

function isDebugEnabled(string $content, bool $isBedrock): bool {
    if ($isBedrock) {
        if (preg_match('/^WP_DEBUG\s*=\s*(true|false|1|0)/mi', $content, $m)) {
            return in_array(strtolower($m[1]), ['true', '1'], true);
        }
        return false;
    }
    // wp-config.php
    if (preg_match("/define\s*\(\s*['\"]WP_DEBUG['\"]\s*,\s*(true|false|1|0)/i", $content, $m)) {
        return in_array(strtolower($m[1]), ['true', '1'], true);
    }
    return false;
}

function setDebug(string $content, bool $enable, bool $isBedrock): string {
    $val = $enable ? 'true' : 'false';
    if ($isBedrock) {
        if (preg_match('/^WP_DEBUG\s*=.*/mi', $content)) {
            return preg_replace('/^WP_DEBUG\s*=.*/mi', "WP_DEBUG=$val", $content);
        }
        return $content . "\nWP_DEBUG=$val\n";
    }
    // wp-config.php
    $pattern = "/define\s*\(\s*['\"]WP_DEBUG['\"]\s*,\s*(?:true|false|1|0)\s*\)/i";
    $replace  = "define('WP_DEBUG', $val)";
    if (preg_match($pattern, $content)) {
        return preg_replace($pattern, $replace, $content);
    }
    // Insert before "/* That's all" comment
    return str_replace("/* That's all", "$replace;\n\n/* That's all", $content);
}

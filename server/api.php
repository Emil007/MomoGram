<?php
// MomoGram server: accounts, synced saves and a shared shelf of puzzle packs for one household.
// One file, no dependencies. Needs PHP 7.4+ with PDO (MySQL/MariaDB or SQLite). Settings: config.php.
declare(strict_types=1);

const API_VERSION = 2;
const PART_MAX = 8 * 1024 * 1024; // the app uploads packs in 4 MB parts (below the usual post_max_size)
const MAX_USERS = 10; // one household or a few friends: high scores and layouts are made for up to ten players

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Momo-Token');
header('Access-Control-Max-Age: 86400');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') exit;

$cfg = require __DIR__ . '/config.php';

/** which game a puzzle id belongs to: Mega ("@mega"), Colour ("@color") or the plain one */
function modeOf(string $id): string { return substr($id, -5) === '@mega' ? 'mega' : (substr($id, -6) === '@color' ? 'color' : 'normal'); }

function out($data, int $code = 200): void {
  http_response_code($code);
  // the server's clock: the app uses it, so devices with a wrong clock can't win every merge
  if (is_array($data)) $data['now'] = gmdate('Y-m-d\TH:i:s\Z') ;
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}
function fail(string $error, int $code = 400, array $extra = []): void { out(['error' => $error] + $extra, $code); }
function body(): array { $b = json_decode((string)file_get_contents('php://input'), true); return is_array($b) ? $b : []; }

// details go to the server's error log only, never to the app
set_exception_handler(function (Throwable $e) { error_log('momogram: ' . $e); fail('server', 500); });

// ---- database (tables are made on first use) ----
// everything lives in a randomly named folder inside data_dir, so nothing can be fetched by guessing its address
// even where the host ignores .htaccess (nginx only)
$base = rtrim($cfg['data_dir'] ?? (__DIR__ . '/data'), '/');
if (!is_dir($base) && !@mkdir($base, 0770, true)) fail('setup', 500, ['message' => "can't create $base"]);
if (!is_file("$base/key.php")) {
  if (@file_put_contents("$base/key.php", "<?php return '" . bin2hex(random_bytes(16)) . "';\n") === false) fail('setup', 500, ['message' => "$base is not writable"]);
}
$dataDir = $base . '/' . (require "$base/key.php");
if (!is_dir("$dataDir/packs")) @mkdir("$dataDir/packs", 0770, true);
// the files of packs, stored once by their SHA-1 (the same title song in nine packs is one file here)
if (!is_dir("$dataDir/blobs")) @mkdir("$dataDir/blobs", 0770, true);
if (!is_file("$base/index.php")) @file_put_contents("$base/index.php", "<?php http_response_code(403);\n");
$dsn = ($cfg['dsn'] ?? '') !== '' ? $cfg['dsn'] : "sqlite:$dataDir/momogram.sqlite";
$db = new PDO($dsn, $cfg['user'] ?? '', $cfg['password'] ?? '', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
$mysql = $db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql';
$ai = $mysql ? 'INTEGER PRIMARY KEY AUTO_INCREMENT' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
$big = $mysql ? 'LONGTEXT' : 'TEXT';
$tail = $mysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
foreach ([
  "CREATE TABLE IF NOT EXISTS momo_users (id $ai, name VARCHAR(64) NOT NULL UNIQUE, pass VARCHAR(255) NOT NULL, admin INTEGER NOT NULL DEFAULT 0, created VARCHAR(32) NOT NULL)$tail",
  "CREATE TABLE IF NOT EXISTS momo_tokens (hash CHAR(64) PRIMARY KEY, user_id INTEGER NOT NULL, created VARCHAR(32) NOT NULL, used VARCHAR(32) NOT NULL)$tail",
  "CREATE TABLE IF NOT EXISTS momo_saves (user_id INTEGER PRIMARY KEY, rev INTEGER NOT NULL, data $big NOT NULL, updated VARCHAR(32) NOT NULL)$tail",
  "CREATE TABLE IF NOT EXISTS momo_packs (pack_id VARCHAR(190) PRIMARY KEY, file VARCHAR(80) NOT NULL, meta $big NOT NULL, size BIGINT NOT NULL, user_id INTEGER NOT NULL, updated VARCHAR(32) NOT NULL)$tail",
  "CREATE TABLE IF NOT EXISTS momo_uploads (id CHAR(32) PRIMARY KEY, pack_id VARCHAR(190) NOT NULL, meta $big NOT NULL, user_id INTEGER NOT NULL, parts INTEGER NOT NULL, created VARCHAR(32) NOT NULL)$tail",
  "CREATE TABLE IF NOT EXISTS momo_fails (ip VARCHAR(64) NOT NULL, at INTEGER NOT NULL)$tail",
] as $sql) $db->exec($sql);
// packs stored as pack.json + files by hash ("split") instead of one zip: their file list (name, hash, size, music)
try { $db->exec("ALTER TABLE momo_packs ADD COLUMN assets $big"); } catch (Throwable $e) { /* there already */ }

/** remove stored files no pack refers to any more */
function sweepBlobs(): void {
  global $dataDir;
  $used = [];
  foreach (q('SELECT assets FROM momo_packs WHERE assets IS NOT NULL')->fetchAll() as $r) foreach ((json_decode((string)$r['assets'], true) ?: []) as $f) $used[$f['hash'] ?? ''] = true;
  foreach (glob("$dataDir/blobs/*") ?: [] as $f) {
    $h = basename($f);
    if (substr($h, -5) === '.part') { if (filemtime($f) < time() - 86400) @unlink($f); continue; }
    if (!isset($used[$h])) @unlink($f);
  }
}
const HASH_RE = '/^[0-9a-f]{40}$/';

$now = gmdate('Y-m-d\TH:i:s\Z');
function q(string $sql, array $args = []): PDOStatement { global $db; $s = $db->prepare($sql); $s->execute($args); return $s; }

// ---- accounts ----
function tooManyFails(): bool {
  q('DELETE FROM momo_fails WHERE at < ?', [time() - 900]);
  return (int)q('SELECT COUNT(*) AS n FROM momo_fails WHERE ip = ?', [$_SERVER['REMOTE_ADDR'] ?? ''])->fetch()['n'] >= 20;
}
function noteFail(): void { q('INSERT INTO momo_fails (ip, at) VALUES (?, ?)', [$_SERVER['REMOTE_ADDR'] ?? '', time()]); }
function newToken(int $uid): string {
  global $now;
  $t = bin2hex(random_bytes(32));
  q('INSERT INTO momo_tokens (hash, user_id, created, used) VALUES (?, ?, ?, ?)', [hash('sha256', $t), $uid, $now, $now]);
  return $t;
}
function user(): array {
  global $now;
  $t = $_SERVER['HTTP_X_MOMO_TOKEN'] ?? '';
  if ($t === '') fail('login', 401);
  $u = q('SELECT u.id, u.name, u.admin, t.used FROM momo_tokens t JOIN momo_users u ON u.id = t.user_id WHERE t.hash = ?', [hash('sha256', $t)])->fetch();
  if (!$u) fail('login', 401);
  if (substr($u['used'], 0, 10) !== substr($now, 0, 10)) q('UPDATE momo_tokens SET used = ? WHERE hash = ?', [$now, hash('sha256', $t)]);
  return $u;
}
function userOut(array $u): array { return ['name' => $u['name'], 'admin' => (bool)$u['admin']]; }

$a = $_GET['a'] ?? 'info';
switch ($a) {
  case 'info':
    out(['app' => 'momogram', 'api' => API_VERSION, 'register' => ($cfg['invite'] ?? '') !== '']);

  case 'register': {
    $b = body();
    if (($cfg['invite'] ?? '') === '') fail('closed', 403);
    if (tooManyFails()) fail('slow', 429);
    if (!hash_equals((string)$cfg['invite'], (string)($b['invite'] ?? ''))) { noteFail(); fail('invite', 403); }
    $name = trim((string)($b['name'] ?? ''));
    $pass = (string)($b['password'] ?? '');
    if ($name === '' || mb_strlen($name) > 64) fail('name');
    if (strlen($pass) < 6) fail('password');
    if (q('SELECT id FROM momo_users WHERE LOWER(name) = LOWER(?)', [$name])->fetch()) fail('taken', 409);
    if ((int)q('SELECT COUNT(*) AS n FROM momo_users')->fetch()['n'] >= MAX_USERS) fail('full', 403, ['max' => MAX_USERS]);
    $first = !q('SELECT id FROM momo_users LIMIT 1')->fetch();
    q('INSERT INTO momo_users (name, pass, admin, created) VALUES (?, ?, ?, ?)', [$name, password_hash($pass, PASSWORD_DEFAULT), $first ? 1 : 0, $now]);
    $u = q('SELECT * FROM momo_users WHERE name = ?', [$name])->fetch();
    out(['token' => newToken((int)$u['id']), 'user' => userOut($u)]);
  }

  case 'login': {
    $b = body();
    if (tooManyFails()) fail('slow', 429);
    $u = q('SELECT * FROM momo_users WHERE LOWER(name) = LOWER(?)', [trim((string)($b['name'] ?? ''))])->fetch();
    if (!$u || !password_verify((string)($b['password'] ?? ''), $u['pass'])) { noteFail(); fail('wrong', 403); }
    if (password_needs_rehash($u['pass'], PASSWORD_DEFAULT)) q('UPDATE momo_users SET pass = ? WHERE id = ?', [password_hash((string)$b['password'], PASSWORD_DEFAULT), $u['id']]);
    out(['token' => newToken((int)$u['id']), 'user' => userOut($u)]);
  }

  case 'logout':
    q('DELETE FROM momo_tokens WHERE hash = ?', [hash('sha256', $_SERVER['HTTP_X_MOMO_TOKEN'] ?? '')]);
    out(['ok' => true]);

  case 'me':
    out(['user' => userOut(user())]);

  case 'password': {
    $u = user(); $b = body();
    $row = q('SELECT pass FROM momo_users WHERE id = ?', [$u['id']])->fetch();
    if (!password_verify((string)($b['old'] ?? ''), $row['pass'])) { noteFail(); fail('wrong', 403); }
    if (strlen((string)($b['password'] ?? '')) < 6) fail('password');
    q('UPDATE momo_users SET pass = ? WHERE id = ?', [password_hash((string)$b['password'], PASSWORD_DEFAULT), $u['id']]);
    out(['ok' => true]);
  }

  // ---- admin: the accounts, and a new password for someone who forgot theirs ----
  case 'users': {
    $u = user();
    if (!$u['admin']) fail('owner', 403);
    out(['users' => array_map(fn($r) => ['name' => $r['name'], 'admin' => (bool)$r['admin'], 'created' => $r['created']], q('SELECT name, admin, created FROM momo_users ORDER BY id')->fetchAll())]);
  }
  case 'set_password': {
    $u = user(); $b = body();
    if (!$u['admin']) fail('owner', 403);
    if (strlen((string)($b['password'] ?? '')) < 6) fail('password');
    $who = q('SELECT id FROM momo_users WHERE name = ?', [(string)($b['name'] ?? '')])->fetch();
    if (!$who) fail('missing', 404);
    q('UPDATE momo_users SET pass = ? WHERE id = ?', [password_hash((string)$b['password'], PASSWORD_DEFAULT), $who['id']]);
    // logged out everywhere: the old password may be known to someone
    q('DELETE FROM momo_tokens WHERE user_id = ?', [$who['id']]);
    out(['ok' => true]);
  }

  // ---- the save: one document per account, with a revision so two devices never overwrite each other ----
  case 'save': {
    $u = user();
    $row = q('SELECT rev, data, updated FROM momo_saves WHERE user_id = ?', [$u['id']])->fetch();
    if ($_SERVER['REQUEST_METHOD'] === 'GET') out($row ? ['rev' => (int)$row['rev'], 'updated' => $row['updated'], 'data' => json_decode($row['data'])] : ['rev' => 0, 'data' => null]);
    $data = (string)file_get_contents('php://input');
    if (json_decode($data) === null) fail('json');
    $rev = (int)($_GET['rev'] ?? -1);
    if ($row) {
      $n = q('UPDATE momo_saves SET rev = rev + 1, data = ?, updated = ? WHERE user_id = ? AND rev = ?', [$data, $now, $u['id'], $rev])->rowCount();
      if (!$n) { $row = q('SELECT rev, data FROM momo_saves WHERE user_id = ?', [$u['id']])->fetch(); fail('changed', 409, ['rev' => (int)$row['rev'], 'data' => json_decode($row['data'])]); }
      out(['rev' => $rev + 1, 'updated' => $now]);
    }
    if ($rev !== 0) fail('changed', 409, ['rev' => 0, 'data' => null]);
    q('INSERT INTO momo_saves (user_id, rev, data, updated) VALUES (?, 1, ?, ?)', [$u['id'], $data, $now]);
    out(['rev' => 1, 'updated' => $now]);
  }

  // ---- high scores, worked out from everyone's saves ----
  case 'scores': {
    user();
    $users = []; $best = []; $week = gmdate('Y-m-d\TH:i:s\Z', time() - 7 * 86400);
    // a time counts with the rules it was played with: Hard (and Free) before Normal before Easy
    $rank = ['hard' => 0, 'free' => 0, 'normal' => 1, 'easy' => 2];
    $empty = fn() => ['solved' => 0, 'week' => 0, 'medals' => ['bronze' => 0, 'silver' => 0, 'gold' => 0, 'platinum' => 0], 'packs' => [], 'time' => 0, 'records' => 0, 'points' => 0, 'rated' => []];
    foreach (q('SELECT u.name, s.data FROM momo_saves s JOIN momo_users u ON u.id = s.user_id')->fetchAll() as $r) {
      $s = json_decode($r['data'], true);
      // normal, Mega and Colour puzzles (ids ending in "@mega" / "@color") are counted apart: three games
      $m = ['normal' => $empty(), 'mega' => $empty(), 'color' => $empty()];
      foreach (($s['packs'] ?? []) as $pid => $pk) {
        if (strncmp((string)$pid, 'my-', 3) === 0) continue; // packs made in the editor don't count
        foreach (($pk['progress'] ?? []) as $pz => $v) {
          if (empty($v['cleared'])) continue;
          $mode = modeOf((string)$pz);
          $x = &$m[$mode];
          $x['solved']++; $x['packs'][$pid] = ($x['packs'][$pid] ?? 0) + 1;
          if (!empty($v['at']) && $v['at'] >= $week) $x['week']++;
          if (!empty($v['medal']) && isset($x['medals'][$v['medal']])) $x['medals'][$v['medal']]++;
          $x['points'] += (int)($v['pts'] ?? 0);
          foreach (($v['rated'] ?? []) as $rr) if (is_array($rr) && isset($rr['at'], $rr['pr'], $rr['s'])) $x['rated'][] = $rr;
          // the best time under the strictest rules it was played with
          $pick = null;
          foreach (($v['times'] ?? []) as $rules => $ms) if (is_numeric($ms) && isset($rank[$rules]) && ($pick === null || [$rank[$rules], $ms] < [$rank[$pick[1]], $pick[0]])) $pick = [(int)$ms, $rules];
          // older progress has no times per rules: its medal tells which rules it was played with
          $byMedal = ['bronze' => 'easy', 'silver' => 'normal', 'gold' => 'free', 'platinum' => 'free'];
          if ($pick === null && isset($v['best']) && is_numeric($v['best'])) $pick = [(int)$v['best'], $byMedal[$v['medal'] ?? ''] ?? ''];
          $medal = (!empty($v['medal']) && isset($x['medals'][$v['medal']])) ? $v['medal'] : '';
          if ($pick) { $best["$pid/$pz"][] = [$r['name'], $pick[0], $pick[1], $medal]; $x['time'] += $pick[0]; }
          unset($x);
        }
      }
      foreach ($m as &$x) {
        // PixElo: replayed from the rated solves in order (game/rating.ts does the same)
        usort($x['rated'], fn($a, $b) => strcmp((string)$a['at'], (string)$b['at']));
        $elo = 1000; $peak = 1000; $n = 0;
        foreach ($x['rated'] as $rr) {
          $k = $n < 15 ? 40 : 20;
          $e = 1 / (1 + pow(10, ((float)$rr['pr'] - $elo) / 400));
          $elo = max(100, (int)round($elo + $k * ((float)$rr['s'] - $e)));
          $peak = max($peak, $elo); $n++;
        }
        $x['elo'] = $elo; $x['peak'] = $peak; $x['rated'] = $n; $x['packs'] = (object)$x['packs'];
      }
      unset($x);
      $users[] = ['name' => $r['name']] + $m['normal'] + ['modes' => $m];
    }
    $rk = fn($e) => [$rank[$e[2]] ?? 3, $e[1]];
    foreach ($best as &$l) usort($l, fn($a, $b) => $rk($a) <=> $rk($b));
    unset($l);
    // records: puzzles where someone has the best time (only counted when two or more played it)
    foreach ($best as $key => $l) if (count($l) > 1) {
      $mode = modeOf((string)$key);
      foreach ($users as &$u) if ($u['name'] === $l[0][0]) { $u['modes'][$mode]['records']++; if ($mode === 'normal') $u['records']++; }
      unset($u);
    }
    usort($users, fn($a, $b) => [$b['points'], $b['solved']] <=> [$a['points'], $a['solved']]);
    out(['users' => $users, 'best' => (object)$best]);
  }

  // ---- packs: everyone with an account here sees every pack ----
  case 'packs': {
    user();
    $list = [];
    foreach (q('SELECT p.pack_id, p.meta, p.size, p.updated, p.assets, u.name FROM momo_packs p LEFT JOIN momo_users u ON u.id = p.user_id ORDER BY p.updated DESC')->fetchAll() as $r) {
      $e = ['id' => $r['pack_id'], 'size' => (int)$r['size'], 'updated' => $r['updated'], 'by' => $r['name'], 'meta' => json_decode($r['meta'])];
      // split packs: how much of it is music (it can be left out when downloading)
      if ($r['assets'] !== null) { $m = 0; foreach ((json_decode((string)$r['assets'], true) ?: []) as $f) if (!empty($f['music'])) $m += (int)($f['size'] ?? 0); $e['music'] = $m; $e['split'] = true; }
      $list[] = $e;
    }
    out(['packs' => $list]);
  }

  case 'pack': {
    user();
    $r = q('SELECT file, size FROM momo_packs WHERE pack_id = ?', [(string)($_GET['id'] ?? '')])->fetch();
    $f = $r ? "$dataDir/packs/{$r['file']}" : '';
    if (!$r || !is_file($f)) fail('missing', 404);
    header('Content-Type: application/zip');
    header('Content-Length: ' . filesize($f));
    while (ob_get_level()) ob_end_clean();
    readfile($f);
    exit;
  }

  // upload: begin (metadata) → part 0..n-1 (raw bytes) → end
  case 'upload_begin': {
    $u = user(); $b = body();
    $id = (string)($b['id'] ?? '');
    if ($id === '' || strlen($id) > 190) fail('id');
    // uploads given up more than a day ago: their entry and their half-written file
    foreach (q('SELECT id FROM momo_uploads WHERE created < ?', [gmdate('Y-m-d\TH:i:s\Z', time() - 86400)])->fetchAll() as $old) @unlink("$dataDir/packs/{$old['id']}.part");
    q('DELETE FROM momo_uploads WHERE created < ?', [gmdate('Y-m-d\TH:i:s\Z', time() - 86400)]);
    // the server keeps only the newest version of a pack: an older or the same one isn't sent at all
    $rev = (int)($b['meta']['rev'] ?? 1);
    $have = q('SELECT p.meta, p.user_id, u.name FROM momo_packs p LEFT JOIN momo_users u ON u.id = p.user_id WHERE p.pack_id = ?', [$id])->fetch();
    // a pack made in the editor is only replaced by the one who uploaded it (game packs are the same game for everyone)
    if ($have && strncmp($id, 'my-', 3) === 0 && (int)$have['user_id'] !== (int)$u['id']) fail('owner', 403, ['by' => $have['name']]);
    if ($have && (int)(json_decode($have['meta'], true)['rev'] ?? 1) >= $rev) fail('have', 409, ['rev' => (int)(json_decode($have['meta'], true)['rev'] ?? 1)]);
    $up = bin2hex(random_bytes(16));
    q('INSERT INTO momo_uploads (id, pack_id, meta, user_id, parts, created) VALUES (?, ?, ?, ?, 0, ?)', [$up, $id, json_encode($b['meta'] ?? new stdClass, JSON_UNESCAPED_UNICODE), $u['id'], $now]);
    // parts must fit the host's post_max_size
    $pm = ini_get('post_max_size'); $n = (int)$pm; $unit = strtolower(substr(trim((string)$pm), -1));
    $lim = $n * ($unit === 'g' ? 1 << 30 : ($unit === 'm' ? 1 << 20 : ($unit === 'k' ? 1 << 10 : 1)));
    $size = $lim > 0 ? min(PART_MAX / 2, (int)($lim * 0.8)) : PART_MAX / 2;
    out(['upload' => $up, 'part' => max(65536, $size)]);
  }

  case 'upload_part': {
    $u = user();
    $up = q('SELECT * FROM momo_uploads WHERE id = ? AND user_id = ?', [(string)($_GET['upload'] ?? ''), $u['id']])->fetch();
    if (!$up) fail('upload', 404);
    $i = (int)($_GET['i'] ?? -1);
    if ($i !== (int)$up['parts']) fail('order', 409, ['next' => (int)$up['parts']]);
    $data = (string)file_get_contents('php://input');
    if (strlen($data) > PART_MAX) fail('part', 413);
    if (file_put_contents("$dataDir/packs/{$up['id']}.part", $data, $i ? FILE_APPEND : 0) === false) fail('disk', 507);
    q('UPDATE momo_uploads SET parts = parts + 1 WHERE id = ?', [$up['id']]);
    out(['next' => $i + 1]);
  }

  case 'upload_end': {
    $u = user();
    $up = q('SELECT * FROM momo_uploads WHERE id = ? AND user_id = ?', [(string)($_GET['upload'] ?? ''), $u['id']])->fetch();
    $part = $up ? "$dataDir/packs/{$up['id']}.part" : '';
    if (!$up || !is_file($part)) fail('upload', 404);
    if (fread(fopen($part, 'rb'), 2) !== 'PK') { unlink($part); fail('zip'); }
    $meta = json_decode($up['meta'], true);
    $have = q('SELECT meta, user_id FROM momo_packs WHERE pack_id = ?', [$up['pack_id']])->fetch();
    if ($have && strncmp($up['pack_id'], 'my-', 3) === 0 && (int)$have['user_id'] !== (int)$u['id']) { unlink($part); q('DELETE FROM momo_uploads WHERE id = ?', [$up['id']]); fail('owner', 403); }
    if ($have && (int)(json_decode($have['meta'], true)['rev'] ?? 1) >= (int)($meta['rev'] ?? 1)) {
      unlink($part); q('DELETE FROM momo_uploads WHERE id = ?', [$up['id']]); fail('have', 409);
    }
    $file = $up['id'] . '.zip';
    rename($part, "$dataDir/packs/$file");
    $old = q('SELECT file FROM momo_packs WHERE pack_id = ?', [$up['pack_id']])->fetch();
    $db->beginTransaction();
    q('DELETE FROM momo_packs WHERE pack_id = ?', [$up['pack_id']]);
    q('INSERT INTO momo_packs (pack_id, file, meta, size, user_id, updated, assets) VALUES (?, ?, ?, ?, ?, ?, NULL)', [$up['pack_id'], $file, $up['meta'], filesize("$dataDir/packs/$file"), $u['id'], $now]);
    q('DELETE FROM momo_uploads WHERE id = ?', [$up['id']]);
    $db->commit();
    if ($old && $old['file'] !== $file) @unlink("$dataDir/packs/{$old['file']}");
    out(['ok' => true]);
  }

  // ---- split packs: pack.json and its files by hash; a file the server has already is not sent again ----
  case 'pack_split': {
    user();
    $r = q('SELECT file, assets FROM momo_packs WHERE pack_id = ?', [(string)($_GET['id'] ?? '')])->fetch();
    if (!$r) fail('missing', 404);
    if ($r['assets'] === null) out(['kind' => 'zip']);
    $f = "$dataDir/packs/{$r['file']}";
    if (!is_file($f)) fail('missing', 404);
    out(['kind' => 'split', 'pack' => json_decode((string)file_get_contents($f)), 'assets' => json_decode((string)$r['assets'])]);
  }

  case 'blobs_missing': {
    user(); $b = body();
    $miss = [];
    foreach ((array)($b['hashes'] ?? []) as $h) if (is_string($h) && preg_match(HASH_RE, $h) && !is_file("$dataDir/blobs/$h")) $miss[] = $h;
    out(['missing' => $miss]);
  }

  // one file in parts: ?hash=&i=&n= (raw bytes); the last part checks the hash
  case 'blob_part': {
    user();
    $h = (string)($_GET['hash'] ?? ''); $i = (int)($_GET['i'] ?? -1); $n = (int)($_GET['n'] ?? 0);
    if (!preg_match(HASH_RE, $h) || $i < 0 || $n < 1 || $i >= $n) fail('args');
    if (is_file("$dataDir/blobs/$h")) out(['ok' => true]);
    $data = (string)file_get_contents('php://input');
    if (strlen($data) > PART_MAX) fail('part', 413);
    $part = "$dataDir/blobs/$h.part";
    if ($i > 0 && !is_file($part)) fail('order', 409, ['next' => 0]);
    if (file_put_contents($part, $data, $i ? FILE_APPEND : 0) === false) fail('disk', 507);
    if ($i === $n - 1) {
      if (sha1_file($part) !== $h) { unlink($part); fail('hash'); }
      rename($part, "$dataDir/blobs/$h");
    }
    out(['ok' => true]);
  }

  case 'blob': {
    user();
    $h = (string)($_GET['hash'] ?? '');
    if (!preg_match(HASH_RE, $h) || !is_file("$dataDir/blobs/$h")) fail('missing', 404);
    header('Content-Type: application/octet-stream');
    header('Content-Length: ' . filesize("$dataDir/blobs/$h"));
    while (ob_get_level()) ob_end_clean();
    readfile("$dataDir/blobs/$h");
    exit;
  }

  // a split pack: its pack.json and file list; every file must be on the server already
  case 'pack_put': {
    $u = user(); $b = body();
    $id = (string)($b['id'] ?? '');
    if ($id === '' || strlen($id) > 190 || !is_array($b['pack'] ?? null)) fail('id');
    $meta = (array)($b['meta'] ?? []);
    $rev = (int)($meta['rev'] ?? 1);
    $have = q('SELECT p.meta, p.user_id, p.file, u.name FROM momo_packs p LEFT JOIN momo_users u ON u.id = p.user_id WHERE p.pack_id = ?', [$id])->fetch();
    if ($have && strncmp($id, 'my-', 3) === 0 && (int)$have['user_id'] !== (int)$u['id']) fail('owner', 403, ['by' => $have['name']]);
    if ($have && (int)(json_decode($have['meta'], true)['rev'] ?? 1) >= $rev) fail('have', 409, ['rev' => (int)(json_decode($have['meta'], true)['rev'] ?? 1)]);
    $assets = []; $size = 0;
    foreach ((array)($b['assets'] ?? []) as $f) {
      $h = (string)($f['hash'] ?? '');
      if (!preg_match(HASH_RE, $h) || !is_file("$dataDir/blobs/$h")) fail('blob', 409, ['hash' => $h]);
      $sz = filesize("$dataDir/blobs/$h");
      $assets[] = ['name' => (string)($f['name'] ?? ''), 'hash' => $h, 'size' => $sz, 'music' => !empty($f['music'])];
      $size += $sz;
    }
    $json = json_encode($b['pack'], JSON_UNESCAPED_UNICODE);
    $file = bin2hex(random_bytes(16)) . '.json';
    if (file_put_contents("$dataDir/packs/$file", $json) === false) fail('disk', 507);
    $size += strlen($json);
    $db->beginTransaction();
    q('DELETE FROM momo_packs WHERE pack_id = ?', [$id]);
    q('INSERT INTO momo_packs (pack_id, file, meta, size, user_id, updated, assets) VALUES (?, ?, ?, ?, ?, ?, ?)', [$id, $file, json_encode($meta, JSON_UNESCAPED_UNICODE), $size, $u['id'], $now, json_encode($assets)]);
    $db->commit();
    if ($have && $have['file'] !== $file) @unlink("$dataDir/packs/{$have['file']}");
    sweepBlobs();
    out(['ok' => true]);
  }

  case 'pack_delete': {
    $u = user();
    $r = q('SELECT file, user_id FROM momo_packs WHERE pack_id = ?', [(string)($_GET['id'] ?? '')])->fetch();
    if (!$r) fail('missing', 404);
    if ((int)$r['user_id'] !== (int)$u['id'] && !$u['admin']) fail('owner', 403);
    q('DELETE FROM momo_packs WHERE pack_id = ?', [(string)$_GET['id']]);
    @unlink("$dataDir/packs/{$r['file']}");
    sweepBlobs();
    out(['ok' => true]);
  }
}
fail('unknown', 404);

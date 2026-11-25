<?php
// MomoGram server settings. Edit this file, then upload the whole "server" folder to your web space.
return [
  // Database. MySQL / MariaDB (what Plesk offers):
  //   'dsn' => 'mysql:host=localhost;dbname=momogram;charset=utf8mb4', 'user' => 'momogram', 'password' => '...',
  // or leave it empty for SQLite (no database needed: a file in the data folder):
  'dsn' => '',
  'user' => '',
  'password' => '',

  // Required to create an account: give it only to the people who should use this server.
  // Accounts can't be created while this is empty.
  'invite' => '',

  // Uploaded packs and the SQLite file. This must not be reachable from the web.
  // Default is next to the web root when this folder is published as httpdocs/<name>/ (Plesk: beside httpdocs).
  // `server/data` sits inside the web tree: Apache's .htaccess hides it, nginx does not.
  // Already have data in the old folder? Set this back to __DIR__ . '/data' or move that folder here.
  'data_dir' => dirname(__DIR__, 2) . '/momogram-data',
];

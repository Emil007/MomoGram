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

  // Where uploaded packs are kept. The folder must be writable by PHP and must not be reachable from the web
  // (the .htaccess inside blocks it on Apache; outside the web root is even better).
  'data_dir' => __DIR__ . '/data',
];

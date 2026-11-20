# MomoGram server

A small server for your household. It does three things:

- It keeps each player's progress, paused puzzle and settings the same on every device.
- It keeps puzzle packs that everyone with an account can download.
- It shows high scores: puzzles solved, medals, and the fastest times for every puzzle.

It's a single PHP file. You need PHP 7.4 or newer and a MySQL/MariaDB database, which any Plesk hosting has. Without a database it uses SQLite.

## Setup on Plesk

1. **Create the database.** In Plesk, go to **Databases → Add Database**. Name it e.g. `momogram` and create a user for it, then note the user name and password. You don't need to do anything in phpMyAdmin: the tables are created on the first request.
2. **Edit `config.php`:**
   ```php
   'dsn' => 'mysql:host=localhost;dbname=momogram;charset=utf8mb4',
   'user' => 'the database user',
   'password' => 'its password',
   'invite' => 'something only your family knows',
   ```
   Accounts can only be created with the invite code. Without one, nobody can register.
3. **Upload the folder.** Use **Files** in Plesk (or FTP) to upload the `server` folder into your web space, e.g. as `httpdocs/momogram`. The `data` folder inside must be writable by PHP, which it is by default on Plesk. If you can, set `data_dir` in `config.php` to a folder outside `httpdocs`.
4. **Turn on HTTPS.** Use **SSL/TLS Certificates → Let's Encrypt**. The web version of MomoGram can only connect over HTTPS.
5. **Connect the app.** In MomoGram, go to **Options → Server**, enter the address (e.g. `https://example.com/momogram`) and tap **Connect**. Then create an account with the invite code. On your other devices, log in with the same name and password.

The first account created is the admin. The admin can delete any pack on the server (everyone else only their own) and, under Options → Server → Accounts, set a new password for someone who forgot theirs. That logs the account out on all devices.

## Good to know

- **Pack versions:** every pack carries a hidden version (when it was made). The server keeps only the newest version of each pack. The app shows which packs have a newer version on the server and can update them all at once.
- **Big packs:** they're uploaded in parts that fit the host's `post_max_size`, so big ones with music work too.
- **Playing offline:** progress is joined puzzle by puzzle. The best time and best medal from either device count, so playing offline on two devices loses nothing.
- **Backups:** back up the database and the `data` folder. Uploaded packs are files in `data/<random name>/packs/`.

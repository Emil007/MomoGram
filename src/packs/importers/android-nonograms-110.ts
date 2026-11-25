// Nonograms (com.white.black.nonogram, White&Black / "Nonograms Classic") — version 1.110 APKPure build.
//
// The game ships its whole catalogue as ordinary PNGs in the APK's resources:
//
//   res/drawable-nodpi-v4/<name>_<n>.png     (one PNG per puzzle, the solved picture)
//   res/mipmap-*/ic_launcher*.png            (the launcher icon)
//   AndroidManifest.xml                      (binary; package com.white.black.nonogram, versionName "1.110")
//   resources.arsc                           (binary resource table: the localized per-puzzle names)
//
// There is no encrypted store and no separate clue table: at runtime the app decodes each PNG with
// BitmapFactory (BitmapLoader.getImage) and turns it into a puzzle with PuzzleFactory.createOfBitmap,
// which is exactly the pipeline this importer reproduces (see ANALYSIS.md). Row/column clues are derived
// from the filled mask, so the game's own "sizes" (the <n> suffix) do not gate anything.
//
//   Category        Pictures   Playable units                Colours        Unit sizes
//   Small           34         34 (whole, never split)       1 (B/W)        5×4 … 13×11
//   Normal          39         39 (whole, never split)       1 (B/W)        7×15 … 19×11
//   Large           36         36 (whole, never split)       1 (B/W)        16×19 … 22×16
//   Complex         57         591 mosaic tiles              1 (B/W)        ~9×16 … ~19×19
//   Colorful        82         6 whole + 1689 mosaic tiles   real colour    16×16 … 20×16 (whole) / 10×10 … 20×20 (tiles)
//   Total           248         2 395 (+ 1558 colour-game tiles of the colourful ones)
//
// How the game plays (verified, see ANALYSIS.md). The app turns each puzzle PNG (BitmapFactory) into a
// grid with PuzzleFactory.createOfBitmap (colour-distance filter + crop, reproduced exactly here). It then
// splits every picture where width×height is over 400 cells (colour) / 625 cells (monochrome) into mosaic
// sub-puzzles (PuzzleFactory.addSubPuzzles): the player solves those tiles one at a time and a picture counts
// as finished when all its tiles are. The classic categories Small/Normal/Large are under the split threshold
// and are each one whole nonogram. Special (Complex) and Colorful pictures are solved as their mosaic tiles.
//
// so the honest playable unit is:
//   Small / Normal / Large   → one MomoGram puzzle per picture
//   Complex / Colorful       → one MomoGram puzzle per mosaic tile (the game's own sub-puzzles)
// This also keeps every puzzle line-solvable (whole classic pictures ≥ 97 %; the split tiles ≥ 98 % —
// the whole Special/Colorful pictures are photo mosaics that the game itself never solves whole).
//
// The game's colour mode (COLORFUL) really plays the picture as a colour nonogram: every pixel is one
// cell, white is the empty background (filtered out like the monochrome categories, verified against
// PuzzleFactory), every other cell has the colour of its pixel, and clue numbers carry block colours —
// a true colorGame (src/game/color.ts colorOf with colorGame ⇒ ≤ 32 colours). Tiles of the Colorful
// pictures are imported as colour puzzles (colorGame + colour picture); the small whole Colour pictures
// too. The monochrome categories have a single filled colour (pure black, one near-black "#060606" merged
// by the game's own colour-distance filter) and are plain black/white nonograms (no colour mode, no Mega).
//
// Container-agnostic by design (owner requirement): detect/read never gate on the file extension
// (.apk / .xapk / .apkm / .zip / an extracted folder all work). The real markers that decide are
//   - the binary AndroidManifest.xml containing the UTF-16LE package name "com.white.black.nonogram"
//     (versionName "1.110", versionCode 110),
//   - the puzzle store: a res/drawable-nodpi-v4/ set carrying the game's own puzzle PNGs
//     (>= 200 of the 248 known names, the byte pattern of the shipped build), and
//   - (optional, name enrichment) resources.arsc whose string pool yields the localized names.
// .xapk / .apkm are zips that hold the same base APK as a .apk (next to ABI/language splits), so
// unzipping recursively and matching the markers works for every distribution. An already-extracted
// base APK / a picked folder is handled by the Set variant below (same read path).
//
// Puzzle ids are the game's own picture names ("smile_5", "snapchat_50", …); each mosaic tile of a
// Special/Colorful picture is "name-NN" in the picture's own left-to-right, top-to-bottom order (the
// game's sub-puzzle order, see addSubPuzzles). Stable and already used by the game, so player progress
// survives re-imports. Names are the game's string
// resources per puzzle (en / fr / ru, the three locales the game actually ships the name table in;
// other locales fall back to English) — embedded here as the extracted table, and re-read live from
// resources.arsc when the picked file carries it (same strings).
//
// Icon: res/mipmap-*/ic_launcher.png (plain PNG, not the adaptive foreground/background layers);
// the biggest density (192×192, res/mipmap-xxxhdpi-v4) is decoded to RGBA and shipped as pack icon.
import { registerImporter, registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, PackPuzzle, makeIcon, PackIcon, Text } from '../format';
import { numberedLevels } from './android';

type Name = Text & { ru?: string };
import { unzipSync, unzlibSync } from 'fflate';

type Entry = { name: string; data: Uint8Array };

const PKG = 'com.white.black.nonogram';

// the game's own puzzle drawables per category, in the order the game lists them (Puzzles.java load*Puzzles).
// [drawable, en, fr, ru] — from resources.arsc string table (app_name "Nonograms" / "Picross" / "Японские кроссворды").
const PUZZLES: Record<string, [string, string, string, string][]> = {
  Small: [
    ['smile_5', 'Smile', 'Sourire', 'Улыбка'],
    ['stairs_5', 'Stairs', 'Escaliers', 'Лестница'],
    ['hashtag_12', 'Hashtag', 'Hashtag', 'Хэштег'],
    ['ticket_11', 'Ticket', 'Ticket', 'Билет'],
    ['screen_13', 'Screen', 'Ecran', 'Экран'],
    ['charged_battery_14', 'Charged Battery', 'Batterie chargée', 'Заряженная батарея'],
    ['box_14', 'Box', 'Boîte', 'Коробка'],
    ['binoculars_12', 'Binoculars', 'Jumelles', 'Бинокль'],
    ['flag_13', 'Flag', 'Drapeau', 'Флаг'],
    ['bus_13', 'Bus', 'Bus', 'Автобус'],
    ['mail_12', 'Mail', 'Courrier', 'Почта'],
    ['hourglass_14', 'Hourglass', 'Sablier', 'Песочные часы'],
    ['keyboard_13', 'Keyboard', 'Clavier', 'Клавиатура'],
    ['camera_12', 'Camera', 'Caméra', 'Камера'],
    ['lock_12', 'Lock', 'Serrure', 'Замок'],
    ['human_18', 'Human', 'Humain', 'Человек'],
    ['trash_can_13', 'Trash Can', 'Poubelle', 'Мусорный бак'],
    ['game_boy_11', 'Gameboy', 'Gameboy', 'Геймбой'],
    ['calculator_13', 'Calculator', 'Calculette', 'Калькулятор'],
    ['gun_12', 'Gun', 'Pistolet', 'Оружие'],
    ['store_13', 'Store', 'Magasin', 'Магазин'],
    ['kennel_12', 'Kennel', 'Chenil', 'Питомник'],
    ['musical_note_13', 'Musical Note', 'Note de musique', 'Музыкальная нота'],
    ['glasses_13', 'Glasses', 'Lunettes', 'Очки'],
    ['dumbbell_13', 'Dumbbell', 'Haltère', 'Гантель'],
    ['no_entrance_12', 'No Entrance', 'Entrée interdite', 'Входа нет'],
    ['eye_13', 'Eye', 'Oeil', 'Глаз'],
    ['monster_10', 'Monster', 'Monstre', 'Чудовище'],
    ['key_12', 'Key', 'Clé', 'Ключ'],
    ['wifi_14', 'Wi-Fi', 'Wi-Fi', 'Wi-Fi'],
    ['clock_12', 'Clock', 'Horloge', 'Часы'],
    ['smile_12', 'Smile', 'Sourire', 'Улыбка'],
    ['microphone_14', 'Microphone', 'Micro', 'Микрофон'],
    ['moon_13', 'Moon', 'Lune', 'Луна'],
  ],
  Normal: [
    ['toolbox_14', 'Toolbox', 'Boîte à outils', 'Ящик для инструментов'],
    ['dispenser_16', 'Dispenser', 'Distributeur', 'Диспенсер'],
    ['bell_16', 'Bell', 'Cloche', 'Колокол'],
    ['chocolate_bar_16', 'Chocolate Bar', 'Barre de chocolat', 'Батончик'],
    ['cheesecake_16', 'Cheesecake', 'Cheesecake', 'чизкейк'],
    ['gift_16', 'Gift', 'Cadeau', 'Подарок'],
    ['heart_balloon_16', 'Balloon', 'Ballon', 'Шарик'],
    ['crown_16', 'Crown', 'Couronne', 'Корона'],
    ['cake_16', 'Cake', 'Gateau', 'Пирожное'],
    ['cat_16', 'Cat', 'Chat', 'Кот'],
    ['camera_16', 'Camera', 'Caméra', 'Камера'],
    ['shop_16', 'Shop', 'Boutique', 'Магазин'],
    ['octopus_16', 'Octopus', 'Pieuvre', 'Осьминог'],
    ['lock_18', 'Lock', 'Serrure', 'Замок'],
    ['fox_15', 'Fox', 'Renard', 'Лиса'],
    ['coat_16', 'Coat', 'Manteau', 'Пальто'],
    ['bottle_of_water_16', 'Bottle of Water', 'Bouteille', 'Бутылка воды'],
    ['golf_ball_16', 'Golf Ball', 'Balle de golf', 'Мяч для гольфа'],
    ['mosque_16', 'Mosque', 'Mosquée', 'Мечеть'],
    ['skull_16', 'Skull', 'Crane', 'Череп'],
    ['heart_16', 'Heart', 'Coeur', 'Сердце'],
    ['gatling_gun_19', 'Gatling Gun', 'Mitrailleuse Gatling', 'Пулемёт'],
    ['mitten_16', 'Mitten', 'Mitaine', 'Варежка'],
    ['hamburger_13', 'Hamburger', 'Hamburger', 'Гамбургер'],
    ['manager_16', 'Manager', 'Directeur', 'Мэнеджер'],
    ['clock_16', 'Clock', 'Horloge', 'Часы'],
    ['fax_16', 'Fax', 'Fax', 'факс'],
    ['rat_16', 'Rat', 'Rat', 'Крыса'],
    ['pointing_finger_16', 'Pointing Finger', 'Doigt pointé', 'Указательный палец'],
    ['torch_16', 'Torch', 'Torche', 'Факел'],
    ['fighter_jet_16', 'Fighter Jet', 'Avion de chasse', 'Истребитель'],
    ['twitter_16', 'Twitter', 'Twitter', 'Twitter'],
    ['gas_station_16', 'Gas Station', 'Station-essence', 'Заправка'],
    ['santa_16', 'Santa Claus', 'Père Noel', 'Санта Клаус'],
    ['scooter_16', 'Scooter', 'Scooter', 'Скутер'],
    ['car_16', 'Car', 'Voiture', 'Машина'],
    ['bus_16', 'Bus', 'Bus', 'Автобус'],
    ['doughnut_14', 'Doughnut', 'Donut', 'Пончик'],
    ['emoji_15', 'Emoji', 'Emoji', 'Emoji'],
  ],
  Large: [
    ['android_24', 'Android', 'Android', 'Android'],
    ['trash_can_24', 'Trash Can', 'Poubelle', 'Мусорный бак'],
    ['candles_24', 'Candles', 'Bougies', 'Свечи'],
    ['pig_24', 'Pig', 'Cochon', 'Поросёнок'],
    ['corgi_24', 'Corgi', 'Corgi', 'Корги'],
    ['bug_24', 'Virus', 'Virus', 'Вирус'],
    ['rucksack_24', 'Rucksack', 'Sac à dos', 'Рюкзак'],
    ['coffee_maker_24', 'Coffee Maker', 'Machine à café', 'Кофемашина'],
    ['butterfly_24', 'Butterfly', 'Papillon', 'Бабочка'],
    ['gorilla_24', 'Gorilla', 'Gorille', 'Горилла'],
    ['elephant_24', 'Elephant', 'Eléphant', 'Слон'],
    ['bear_24', 'Bear', 'Ours', 'Медведь'],
    ['charcoal_24', 'Charcoal', 'Charbon', 'Уголь'],
    ['snail_24', 'Snail', 'Escargot', 'Улитка'],
    ['alcohol_free_24', 'Alcohol Free', 'Sans alcool', 'Безалкогольный напиток'],
    ['fire_extinguisher_24', 'Fire Extinguisher', 'Extincteur', 'Огнетушитель'],
    ['female_model_24', 'Female Model', 'Top modèle', 'Женщина-модель'],
    ['office_chair_24', 'Office Chair', 'Siège de bureau', 'Офисный стул'],
    ['cat_24', 'Cat', 'Chat', 'Кот'],
    ['cherry_24', 'Cherry', 'Cerise', 'Вишневый'],
    ['coffee_pot_24', 'Coffee Pot', 'Cafetière', 'Кофейный кувшин'],
    ['phone_23', 'Phone', 'Téléphone', 'Телефон'],
    ['anonymous_24', 'Anonymous', 'Anonymous', 'Аноним'],
    ['octopus_24', 'Octopus', 'Pieuvre', 'Осьминог'],
    ['tire_24', 'Tire', 'Pneu', 'Шина'],
    ['alligator_24', 'Alligator', 'Alligator', 'Аллигатор'],
    ['firefighter_24', 'Firefighter', 'Pompier', 'Пожарный'],
    ['cards_24', 'Cards', 'Cartes', 'Карты'],
    ['linux_24', 'Linux', 'Linux', 'Linux'],
    ['panda_24', 'Panda', 'Panda', 'Панда'],
    ['bowling_24', 'Bowling', 'Bowling', 'Боулинг'],
    ['grenade_24', 'Grenade', 'Grenade', 'Граната'],
    ['ninja_24', 'Ninja', 'Ninja', 'Ниндзя'],
    ['icq_24', 'ICQ', 'ICQ', 'ICQ'],
    ['yin_yang_24', 'Yin Yang', 'Yin Yang', 'Yin Yang'],
    ['dice_24', 'Dice', 'Dé', 'Игральная кость'],
  ],
  Complex: [
    ['snapchat_50', 'Snapchat', 'Snapchat', 'Snapchat'],
    ['puzzle_50', 'Puzzle', 'Puzzle', 'Кусочек головоломки'],
    ['credit_card_50', 'Credit Card', 'Carte de crédit', 'Кредитная карта'],
    ['nail_50', 'Nail', "L' ongle", 'Ноготь'],
    ['mailbox_50', 'Mailbox', 'Boîte aux lettres', 'Почтовый ящик'],
    ['jacket_50', 'Jacket', 'Jacket', 'Куртка'],
    ['piano_50', 'Piano', 'Piano', 'Пианино'],
    ['stapler_50', 'Stapler', 'Agrafeuse', 'Степлер'],
    ['kimono_50', 'Kimono', 'Kimono', 'Кимоно'],
    ['crow_50', 'Crow', 'Corbeau', 'Ворона'],
    ['birthday_present_50', 'Birthday Present', 'Birthday Present', 'Birthday Present'],
    ['starfish_50', 'Starfish', 'Étoile de mer', 'Морская звезда'],
    ['wizard_50', 'Wizard', 'Wizard', 'Wizard'],
    ['treasure_chest_50', 'Treasure Chest', 'Coffre au trésor', 'Сундук с сокровищами'],
    ['bandit_50', 'Bandit', 'Bandit', 'Бандит'],
    ['pelican_50', 'Pelican', 'Pélican', 'Пеликан'],
    ['ace_50', 'Ace', 'As (carte à jouer)', 'Туз'],
    ['fort_50', 'Fort', 'Fort', 'Форт'],
    ['work_boot_50', 'Work Boot', 'Botte de travail', 'Рабочая обувь'],
    ['mask_50', 'Mask', 'Mask', 'Mask'],
    ['rabbit_50', 'Rabbit', 'Lapin', 'Кролик'],
    ['bulletproof_vest_50', 'Bulletproof Vest', 'Bulletproof Vest', 'Bulletproof Vest'],
    ['dinosaur_50', 'Dinosaur', 'Dinosaur', 'Динозавр'],
    ['water_well_50', 'Water Well', 'Puits', 'Колодец'],
    ['seahorse_50', 'Seahorse', 'Hippocampe', 'Морской конёк'],
    ['spectrophotometer_50', 'Spectrophotometer', 'Spectrophotomètre', 'Спектрофотометр'],
    ['popcorn_50', 'Popcorn', 'Pop-corn', 'Попкорн'],
    ['money_sack_50', 'Money Sack', 'Money Sack', 'Money Sack'],
    ['whale_50', 'Whale', 'Baleine', 'Кит'],
    ['potato_chips_50', 'Potato Chips', 'Potato Chips', 'Potato Chips'],
    ['merry_go_round_50', 'Merry Go Round', 'Manège', 'Карусель'],
    ['sofa_50', 'Sofa', 'Canapé', 'Диван'],
    ['sonic_the_hedgehog_50', 'Sonic The Hedgehog', 'Sonic le hérisson', 'Соник'],
    ['astronaut_50', 'Astronaut', 'Astronaute', 'Астронавт'],
    ['bear_50', 'Bear', 'Ours', 'Медведь'],
    ['minion_50', 'Minion', 'Minion', 'Миньон'],
    ['snowflake_50', 'Snowflake', 'Snowflake', 'Snowflake'],
    ['superman_50', 'Superman', 'Superman', 'Супермэн'],
    ['suit_50', 'Suit', 'Costume', 'Костюм'],
    ['hippopotamus_50', 'Hippopotamus', 'Hippopotamus', 'Бегемот'],
    ['couple_50', 'Couple', 'Couple', 'Пара'],
    ['falcon_50', 'Falcon', 'Falcon', 'Сокол'],
    ['ushanka_50', 'Ushanka', 'Ouchanka', 'Ушанка'],
    ['star_of_david_96', 'Star of David', 'Etoile de David', 'Звезда Давида'],
    ['fried_chicken_50', 'Fried Chicken', 'Poulet rôti', 'Жареный цыпленок'],
    ['snake_50', 'Snake', 'Serpent', 'Змея'],
    ['roman_soldier_50', 'Roman Soldier', 'Soldat romain', 'Римский солдат'],
    ['earthquakes_50', 'Earthquakes', 'Tremblements de terre', 'Землятресение'],
    ['rose_50', 'Rose', 'Rose', 'Роза'],
    ['homer_simpson_100', 'Homer Simpson', 'Homer Simpson', 'Гомер Симпсон'],
    ['cheburashka_100', 'Cheburashka', 'Cheburashka', 'Cheburashka'],
    ['trombone_50', 'Trombone', 'Trombone', 'Тромбон'],
    ['farm_50', 'Farm', 'Ferme', 'Ферма'],
    ['amusement_park_100', 'Amusement Park', "Parc d'attraction", 'Парк развлечений'],
    ['tiger_50', 'Tiger', 'Tiger', 'Тигр'],
    ['ruby_100', 'Ruby', 'Ruby', 'Ruby'],
    ['marge_simpson_100', 'Marge Simpson', 'Marge Simpson', 'Marge Simpson'],
  ],
  Colorful: [
    ['cactus_16', 'Cactus', 'Cactus', 'Кактус'],
    ['mushroom_16', 'Mushroom (Super Mario)', 'Mushroom (Super Mario)', 'Mushroom (Super Mario)'],
    ['super_mario_16', 'Super Mario', 'Super Mario', 'Super Mario'],
    ['pokeball_16', 'Pokeball (Pokemon)', 'Pokeball (Pokemon)', 'Pokeball (Pokemon)'],
    ['emoji_17', 'Emoji', 'Emoji', 'Emoji'],
    ['whale_20', 'Whale', 'Baleine', 'Кит'],
    ['sock_96', 'Sock', 'Chaussette', 'Носок'],
    ['flame_96', 'Flame', 'Flamme', 'Пламя'],
    ['big_ben_96', 'Big Ben', 'Big Ben', 'Биг Бен'],
    ['volcano_96', 'Volcano', 'Volcan', 'Вулкан'],
    ['seal_96', 'Seal', 'Phoque', 'Тюлень'],
    ['accordion_96', 'Accordion', 'Accordéon', 'Аккордеон'],
    ['engagement_ring_96', 'Engagement Ring', 'Engagement Ring', 'Engagement Ring'],
    ['milkshake_96', 'Milkshake', 'Milkshake', 'Молочный коктейль'],
    ['dreidel_96', 'Dreidel', 'Toupie', 'Дрэйдл'],
    ['winrar_96', 'WinRAR', 'WinRAR', 'WinRAR'],
    ['steve_jobs_96', 'Steve Jobs', 'Steve Jobs', 'Стив Джобс'],
    ['pizza_96', 'Pizza', 'Pizza', 'Пицца'],
    ['cool_64', 'Cool (Emoji)', 'Sympa (Emoji)', 'Круто (Эмодзи)'],
    ['avatar_96', 'Avatar', 'Avatar', 'Avatar'],
    ['barcelona_fc_96', 'Barcelona Fc', 'FC Barcelone', 'Barcelona Fc'],
    ['maracas_96', 'Maracas', 'Maracas', 'Маракасы'],
    ['pool_table_96', 'Pool Table', 'Table de billard', 'Стол для бильярда'],
    ['violin_96', 'Violin', 'Violon', 'Скрипка'],
    ['children_96', 'Children', 'Enfant', 'Дети'],
    ['pikachu_pokemon_96', 'Pikachu (Pokemon)', 'Pikachu (Pokémon)', 'Покемон'],
    ['pie_96', 'Pie', 'Tarte', 'Пирог'],
    ['statue_of_liberty_96', 'Statue of Liberty', 'Statue de la Liberté', 'Статуя Свободы'],
    ['shop_96', 'Shop', 'Boutique', 'Магазин'],
    ['red_wine_96', 'Red Wine', 'Vin rouge', 'Красное вино'],
    ['fish_96', 'Fish', 'Poisson', 'Рыба'],
    ['santa_96', 'Santa Claus', 'Père Noel', 'Санта Клаус'],
    ['game_boy_96', 'Gameboy', 'Gameboy', 'Геймбой'],
    ['selfie_96', 'Selfie', 'Selfie', 'Селфи'],
    ['sock_puppet_96', 'Sock Puppet', 'Marionnette', 'Перчаточная кукла'],
    ['umbrella_96', 'Umbrella', 'Parapluie', 'Зонт'],
    ['baby_bottle_96', 'Baby Bottle', 'Biberon', 'Детская бутылочка'],
    ['old_man_96', 'Old Man', 'Vieil homme', 'Старик'],
    ['farm_96', 'Farm', 'Ferme', 'Ферма'],
    ['supplier_96', 'Supplier', 'Livreur', 'Поставщик'],
    ['teddy_bear_96', 'Teddy Bear', 'Ours en peluche', 'Мишка Тедди'],
    ['fly_96', 'Fly', 'Mouche', 'Полёт'],
    ['save_as_96', 'Save As..', 'Enregistrer Sous...', 'Сохранить как...'],
    ['policeman_96', 'Policeman', 'Policier', 'Полицейский'],
    ['salah_96', 'Mohamed Salah', 'Mohamed Salah', 'Мохаммед Салах'],
    ['reading_unicorn_96', 'Reading Unicorn', 'Licorne qui lit', 'Читающий единорог'],
    ['chocolate_bar_96', 'Chocolate Bar', 'Barre de chocolat', 'Батончик'],
    ['ice_cream_96', 'Ice Cream', 'Glace', 'Мороженое'],
    ['colorful_dice_96', 'Colorful Dice', 'Dé coloré', 'Цветные кости'],
    ['ingredients_96', 'Ingredients', 'Ingrédients', 'Ингредиенты'],
    ['saturn_96', 'Saturn', 'Saturne', 'Сатурн'],
    ['batman_96', 'Batman', 'Batman', 'Бэтмен'],
    ['jam_96', 'Jam', 'Confiture', 'Джем'],
    ['obama_96', 'Obama', 'Obama', 'Обама'],
    ['watermelon_96', 'Watermelon', 'Pastèque', 'Арбуз'],
    ['french_fries_96', 'French Fries', 'Frites', 'Французская картошка'],
    ['like_96', "Like", "J'aime", 'Like'],
    ['hulk_96', 'Hulk', 'Hulk', 'Халк'],
    ['rose_96', 'Tudor Rose', 'Rose Tudor', 'Роза тюдоров'],
    ['superman_96', 'Superman', 'Superman', 'Супермэн'],
    ['sewing_machine_96', 'Sewing Machine', 'Machine à coudre', 'Швейная машина'],
    ['neymar_96', 'Neymar', 'Neymar', 'Неймар'],
    ['groot_96', 'Groot', 'Groot', 'Грут'],
    ['joker_96', 'Joker', 'Joker', 'Джокер'],
    ['parrot_96', 'Parrot', 'Perroquet', 'Попугай'],
    ['razz_berry_96', 'Raspberry', 'Framboise', 'Малина'],
    ['porsche_96', 'Porsche', 'Porsche', 'Порше'],
    ['halloween_96', 'Halloween', 'Halloween', 'Хэллоуин'],
    ['helicopter_96', 'Helicopter', 'Hélicoptère', 'Вертолёт'],
    ['bicycle_96', 'Bicycle', 'Vélo', 'Велосипед'],
    ['woody_woodpecker_96', 'Woody Woodpecker', 'Woody Woodpecker', 'Woody Woodpecker'],
    ['steak_96', 'Steak', 'Steak', 'Стейк'],
    ['john_cena_96', 'John Cena', 'John Cena', 'Джон Сина'],
    ['tank_96', 'Tank', 'Tank', 'Танк'],
    ['logan_96', 'Wolverine', 'Wolverine', 'Росомаха'],
    ['harley_quinn_96', 'Harley Quinn', 'Harley Quinn', 'Харли Квинн'],
    ['deadpool_96', 'Deadpool', 'Deadpool', 'Дэдпул'],
    ['banjo_96', 'Banjo', 'Banjo', 'Банджо'],
    ['ladybird_96', 'Ladybird', 'Coccinelle', 'Божья коровка'],
    ['harry_potter_96', 'Harry Potter', 'Harry Potter', 'Harry Potter'],
    ['open_book_96', 'Open Book', 'Livre ouvert', 'Открытая книга'],
    ['notepad_96', 'Notepad++', 'Notepad++', 'Notepad++'],
  ],
};

const CAT_TITLE: Record<string, [string, string, string]> = {
  Small: ['Small', 'Petit', 'Маленький'],
  Normal: ['Normal', 'Moyen', 'Средний'],
  Large: ['Large', 'Grand', 'Большой'],
  Complex: ['Special', 'Spécial', 'Специальный'],
  Colorful: ['Colorful', 'Coloré', 'Цветной'],
};

const CAT_COLOR: Record<string, string> = {
  Small: '#3f9d4f', Normal: '#e08a2e', Large: '#c0403a', Complex: '#5a86b8', Colorful: '#c64ea0',
};

// ---- Android binary-manifest / container detection ----

function hasManifestPackage(entries: Entry[]): boolean {
  let needle = new TextEncoder().encode(PKG);
  for (const e of entries) {
    if (!/^AndroidManifest\.xml$/i.test(e.name)) continue;
    const d = e.data;
    for (let i = 0; i + needle.length * 2 <= d.length; i += 2) {
      let all = true;
      for (let k = 0; k < needle.length; k++) if (d[i + k * 2] !== needle[k] || d[i + k * 2 + 1] !== 0) { all = false; break; }
      if (all) return true;
    }
  }
  return false;
}

/** how many of the game's own puzzle PNGs are in the entries (by known drawable name). */
function puzzleCount(entries: Entry[]): number {
  const known = new Set(Object.values(PUZZLES).flat().map(p => p[0]));
  let n = 0;
  for (const e of entries) {
    const m = /^res\/drawable-nodpi-v4\/([a-z0-9_]+)\.png$/i.exec(e.name);
    if (m && known.has(m[1])) n++;
  }
  return n;
}

export function looksLike(entries: Entry[]): boolean {
  const hasMan = hasManifestPackage(entries);
  if (hasMan) return puzzleCount(entries) >= 200;
  // without the manifest the puzzle store alone is a strong enough marker (extracted folder of res/)
  return puzzleCount(entries) >= 200;
}

function unzipAll(data: Uint8Array): Entry[] {
  const files = unzipSync(data);
  return Object.entries(files).filter(([n]) => !n.endsWith('/')).map(([name, d]) => ({ name, data: d as Uint8Array }));
}

/** recursively unwrap a container until the game's marker set is on top (XAPK → base APK → res/, APKM → splits). */
export function entriesOf(data: Uint8Array, depth = 0): Entry[] {
  if (depth > 4) throw new Error('Too many nested containers.');
  let entries: Entry[] = [];
  try { entries = unzipAll(data); } catch { return []; }
  if (looksLike(entries)) return entries;
  // a XAPK / APKM wrapper: its base APK (or its largest .apk) holds the game assets
  const inner = entries.filter(e => /\.apk$/i.test(e.name)).sort((a, b) => b.data.length - a.data.length)[0];
  if (inner) {
    const sub = entriesOf(inner.data, depth + 1);
    if (sub.length && looksLike(sub)) return sub;
  }
  return entries;
}

// ---- PNG decoder (RGBA / RGB / grey / grey+alpha / indexed, 8-bit, non-interlaced) ----

function paeth(a: number, b: number, c: number) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** decode a PNG to {w, h, rgba} (4 bytes per pixel); null on anything unsupported. */
function pngRgba(d: Uint8Array): { w: number; h: number; rgba: Uint8Array } | null {
  if (d.length < 33 || d[0] !== 0x89 || d[1] !== 0x50 || d[12] !== 0x49 || d[13] !== 0x48 || d[14] !== 0x44 || d[15] !== 0x52) return null;
  const w = (d[16] << 24) | (d[17] << 16) | (d[18] << 8) | d[19];
  const h = (d[20] << 24) | (d[21] << 16) | (d[22] << 8) | d[23];
  const depth = d[24], ctype = d[25];
  if (!(w >= 1 && w <= 2048 && h >= 1 && h <= 2048) || depth !== 8) return null;
  let bpp = 0;
  if (ctype === 6) bpp = 4; else if (ctype === 2) bpp = 3; else if (ctype === 0) bpp = 1; else if (ctype === 4) bpp = 2; else if (ctype === 3) bpp = 1; else return null;
  // palette / transparency for indexed
  let plte: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idats: Uint8Array[] = [];
  let o = 8;
  while (o + 8 <= d.length) {
    const len = (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3];
    const type = String.fromCharCode(d[o + 4], d[o + 5], d[o + 6], d[o + 7]);
    if (type === 'IEND') break;
    if (type === 'IDAT') idats.push(d.subarray(o + 8, o + 8 + len));
    else if (type === 'PLTE') plte = d.subarray(o + 8, o + 8 + len);
    else if (type === 'tRNS') trns = d.subarray(o + 8, o + 8 + len);
    o += 12 + len;
  }
  if (!idats.length) return null;
  let tl = 0; for (const id of idats) tl += id.length;
  const all = new Uint8Array(tl); let at = 0;
  for (const id of idats) { all.set(id, at); at += id.length; }
  let raw: Uint8Array;
  try { raw = unzlibSync(all); } catch { return null; }
  const stride = w * bpp;
  if (raw.length < (stride + 1) * h) return null;
  const out = new Uint8Array(w * h * 4);
  const prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      const f = raw[p + x];
      cur[x] = filter === 0 ? f :
        filter === 1 ? (f + a) & 0xff :
        filter === 2 ? (f + b) & 0xff :
        filter === 3 ? (f + ((a + b) >> 1)) & 0xff :
        (f + paeth(a, b, c)) & 0xff;
    }
    p += stride;
    for (let x = 0; x < w; x++) {
      const ci = x * bpp, di = (y * w + x) * 4;
      if (ctype === 6) { out[di] = cur[ci]; out[di + 1] = cur[ci + 1]; out[di + 2] = cur[ci + 2]; out[di + 3] = cur[ci + 3]; }
      else if (ctype === 2) { out[di] = cur[ci]; out[di + 1] = cur[ci + 1]; out[di + 2] = cur[ci + 2]; out[di + 3] = 255; }
      else if (ctype === 0) { const v = cur[ci]; out[di] = v; out[di + 1] = v; out[di + 2] = v; out[di + 3] = 255; }
      else if (ctype === 4) { const v = cur[ci]; out[di] = v; out[di + 1] = v; out[di + 2] = v; out[di + 3] = cur[ci + 1]; }
      else if (ctype === 3 && plte) {
        const i = cur[ci];
        const r = plte[i * 3], g = plte[i * 3 + 1], bl = plte[i * 3 + 2];
        let alpha = 255;
        if (trns && i < trns.length) alpha = trns[i];
        out[di] = r; out[di + 1] = g; out[di + 2] = bl; out[di + 3] = alpha;
      }
      else { out[di] = 0; out[di + 1] = 0; out[di + 2] = 0; out[di + 3] = 0; }
    }
    prev.set(cur);
  }
  return { w, h, rgba: out };
}

// ---- the game's own image → puzzle pipeline (PuzzleFactory, faithful) ----

const COLOR_DISTANCE = 10500;
const MEASURED_STATE_MASK = 0xff000000;

/** android.graphics.Color helpers */
function alpha(c: number) { return (c >>> 24) & 0xff; }
function red(c: number) { return (c >>> 16) & 0xff; }
function green(c: number) { return (c >>> 8) & 0xff; }
function blue(c: number) { return c & 0xff; }
const hex = (c: number) => '#' + ((c & 0xffffff) >>> 0).toString(16).padStart(6, '0');

/** PuzzleFactory.getDistanceBetweenColors(a, b): weighted channel-wise square distance (Java Color). */
function distColors(a: number, b: number): number {
  const da = alpha(a) - alpha(b), dr = red(a) - red(b), dg = green(a) - green(b), db = blue(a) - blue(b);
  return da * da + dr * dr * 2 + dg * dg * 4 + db * db * 3;
}

/**
 * filterColorsByDistance + crop, exactly as the app: walk every pixel; a pixel becomes empty when its
 * alpha < 150 or its colour is within COLOR_DISTANCE of the empty colour (-1 = 0xFFFFFFFF white —
 * Java int -1), else it is snapped to the first already-seen colour within COLOR_DISTANCE, else it
 * starts a new colour (with the measured-state bit, which only affects alpha rendering).
 * Returns { grid: Int32Array (colours, 0 = empty), w, h, crop: [x0, y0, w, h] }.
 */
export function gamePuzzle(img: { w: number; h: number; rgba: Uint8Array }):
  { grid: Int32Array; w: number; h: number; x0: number; y0: number } | null {
  const W = img.w, H = img.h;
  const n = W * H;
  const filtered = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const a0 = img.rgba[i * 4 + 3];
    if (a0 < 150) { filtered[i] = 0; continue; }
    const argb = (a0 << 24) | (img.rgba[i * 4] << 16) | (img.rgba[i * 4 + 1] << 8) | img.rgba[i * 4 + 2];
    // getNewColor(iArr, i): 0 (empty) when transparent-weak or too close to white (-1 as colour = white)
    let newc: number;
    if (distColors(argb, -1) < COLOR_DISTANCE) newc = 0;
    else newc = argb | MEASURED_STATE_MASK;
    if (newc === 0) { filtered[i] = 0; continue; }
    // match against all previously-processed pixels (filterColorsByDistance keeps only distinct colours)
    let found = 0;
    for (let k = 0; k < i; k++) {
      const c = filtered[k];
      if (c && distColors(c, newc) < COLOR_DISTANCE) { found = c; break; }
    }
    filtered[i] = found || newc;
  }
  // crop(): first/last rows/columns that have any non-empty pixel
  let top = 0;
  while (top < H) { let any = false; for (let x = 0; x < W; x++) if (filtered[top * W + x]) { any = true; break; } if (any) break; top++; }
  let bottom = H - 1;
  while (bottom >= 0) { let any = false; for (let x = 0; x < W; x++) if (filtered[bottom * W + x]) { any = true; break; } if (any) break; bottom--; }
  let left = 0;
  while (left < W) { let any = false; for (let y = 0; y < H; y++) if (filtered[y * W + left]) { any = true; break; } if (any) break; left++; }
  let right = W - 1;
  while (right >= 0) { let any = false; for (let y = 0; y < H; y++) if (filtered[y * W + right]) { any = true; break; } if (any) break; right--; }
  if (top > bottom || left > right) return null;
  const rows = bottom - top + 1, cols = right - left + 1;
  const grid = new Int32Array(rows * cols);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) grid[y * cols + x] = filtered[(y + top) * W + (x + left)];
  return { grid, w: cols, h: rows, x0: left, y0: top };
}

/** mono rows ('#' where the cell is filled) of a filtered, cropped game grid. */
function monoRows(grid: Int32Array, w: number, h: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let s = '';
    for (let x = 0; x < w; x++) s += grid[y * w + x] ? '#' : '.';
    rows.push(s);
  }
  return rows;
}

/** colour picture: palette (#hex per distinct colour, first-seen order) + base36 index rows ('.' = empty). */
function colourRows(grid: Int32Array, w: number, h: number): { palette: string[]; rows: string[] } | null {
  const map = new Map<number, string>(); // colour → base36 index
  const palette: string[] = [];
  for (let i = 0; i < grid.length; i++) {
    const c = grid[i];
    if (!c) continue;
    if (!map.has(c)) {
      map.set(c, palette.length.toString(36));
      palette.push(hex(c));
    }
  }
  if (palette.length === 0) return null;
  const rows = [];
  for (let y = 0; y < h; y++) {
    let s = '';
    for (let x = 0; x < w; x++) {
      const c = grid[y * w + x];
      s += c ? map.get(c)! : '.';
    }
    rows.push(s);
  }
  return { palette, rows };
}

/** puzzle area above which the game splits a picture into mosaic tiles (colour > 400, monochrome > 625). */
const COLOR_SPLIT_AREA = 400;
const MONO_SPLIT_AREA = 625;

/** the width/height the game chooses for the tiles of a picture (PuzzleFactory.addSubPuzzles). */
function tileDims(w: number, h: number, nColors: number): [number, number] {
  const area = w * h;
  if (area > COLOR_SPLIT_AREA && nColors > 1) {
    const cw = Math.ceil(w / 15), ch = Math.ceil(h / 20);
    let width = Math.floor(w / cw), height = Math.floor(h / ch);
    while (w % width <= 10) width++;
    while (h % height <= 10) height++;
    return [width, height];
  }
  if (area <= 625) return [Math.floor(w / 2), Math.floor(h / 2)];
  if (area <= 900) return [Math.floor(w / 3), Math.floor(h / 3)];
  if (area <= 2025) return [Math.floor(w / 3), Math.floor(h / 3)];
  if (area <= 3600) return [Math.floor(w / 3), Math.floor(h / 3)];
  if (area <= 6400) return [Math.floor(w / 4), Math.floor(h / 4)];
  return [Math.floor(w / 5), Math.floor(h / 5)];
}

/** the game's mosaic sub-puzzle rectangles (left, right, top, bottom), in the game's order. */
function mosaicTiles(w: number, h: number, nColors: number): Array<[number, number, number, number]> {
  const [sw, sh] = tileDims(w, h, nColors);
  if (sw < 1 || sh < 1) return [];
  const tiles: Array<[number, number, number, number]> = [];
  let i2 = 0;
  while (i2 < h) {
    let i3 = sh - 1 + i2;
    let i4 = 0;
    while (i4 < w) {
      let i5 = sw - 1 + i4;
      if (w - i5 <= 5) i5 = w - 1;
      if (h - i3 <= 5) i3 = h - 1;
      tiles.push([i4, i5, i2, i3]);
      if (w - i5 <= 5) break;
      i4 += sw;
    }
    if (i3 === h - 1) break;
    i2 += sh;
  }
  return tiles;
}

/** a grid is split when the game would split it into mosaic tiles. */
function shouldSplit(w: number, h: number, nColors: number): boolean {
  const area = w * h;
  return area > (nColors > 1 ? COLOR_SPLIT_AREA : MONO_SPLIT_AREA);
}

function distinctCount(grid: Int32Array): number {
  const s = new Set<number>();
  for (let i = 0; i < grid.length; i++) if (grid[i]) s.add(grid[i]);
  return s.size;
}

// ---- icon ----

function findIcon(entries: Entry[]): { name: string; icon: PackIcon; w: number; h: number } | null {
  let best: Entry | null = null;
  for (const e of entries) {
    if (!/^res\/mipmap[^/]*\/ic_launcher[0-9a-z_.]*\.png$/i.test(e.name)) continue;
    if (/\.9\.png$/i.test(e.name)) continue;
    if (/(?:foreground|background)\.png$/i.test(e.name)) continue;
    if (!best || e.data.length > best.data.length) best = e;
  }
  if (!best) return null;
  const px = pngRgba(best.data);
  if (!px) return null;
  return { name: best.name, icon: makeIcon(px.w, px.h, px.rgba), w: px.w, h: px.h };
}

// ---- pack assembly ----

function packFromEntries(entries: Entry[]): Pack {
  const imgs = new Map<string, Uint8Array>();
  for (const e of entries) {
    const m = /^res\/drawable-nodpi-v4\/([a-z0-9_]+)\.png$/i.exec(e.name);
    if (m) imgs.set(m[1], e.data);
  }
  const levels: PackLevel[] = [];
  let total = 0, dropped: string[] = [];
  for (const cat of ['Small', 'Normal', 'Large', 'Complex', 'Colorful']) {
    const row = PUZZLES[cat];
    const puzzles: PackPuzzle[] = [];
    const isColor = cat === 'Colorful';
    for (const [drawable] of row) {
      const data = imgs.get(drawable);
      if (!data) { dropped.push(drawable); continue; }
      const img = pngRgba(data);
      if (!img) { dropped.push(drawable); continue; }
      const gp = gamePuzzle(img);
      if (!gp) { dropped.push(drawable); continue; }
      const names = PUZZLES[cat].find(p => p[0] === drawable)!;
      const name: Name = { en: names[1], fr: names[2], ru: names[3] };
      const nCol = distinctCount(gp.grid);
      if (shouldSplit(gp.w, gp.h, nCol)) {
        // the game's mosaic sub-puzzles: one puzzle per tile, in the game's order (addSubPuzzles).
        const tiles = mosaicTiles(gp.w, gp.h, nCol);
        tiles.forEach(([x0, x1, y0, y1], k) => {
          const tw = x1 - x0 + 1, th = y1 - y0 + 1;
          const tile = new Int32Array(tw * th);
          for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) tile[y * tw + x] = gp.grid[(y0 + y) * gp.w + (x0 + x)];
          const rows = monoRows(tile, tw, th);
          const label = `${k + 1}/${tiles.length}`;
          const pz: PackPuzzle = { id: `${drawable}-${String(k + 1).padStart(2, '0')}`, width: tw, height: th, rows, name: { en: `${name.en} ${label}`, fr: `${name.fr} ${label}`, ru: `${name.ru} ${label}` } as Name };
          if (isColor) {
            const cr = colourRows(tile, tw, th);
            if (cr) { pz.color = cr; pz.colorGame = true; pz.colorOnly = true; }
          }
          puzzles.push(pz);
        });
      } else {
        const rows = monoRows(gp.grid, gp.w, gp.h);
        const pz: PackPuzzle = { id: drawable, width: gp.w, height: gp.h, rows, name };
        if (isColor) {
          const cr = colourRows(gp.grid, gp.w, gp.h);
          if (cr) { pz.color = cr; pz.colorGame = true; pz.colorOnly = true; }
        }
        puzzles.push(pz);
      }
    }
    if (!puzzles.length) continue;
    const [en, fr, ru] = CAT_TITLE[cat];
    const n = puzzles.length;
    const gt = { en, fr: fr || en, ru: ru || en } as Name;
    levels.push(...numberedLevels(puzzles, {
      id: cat.toLowerCase(), group: cat.toLowerCase(), groupTitle: gt,
    }));
    total += n;
  }
  if (!total) throw new Error('Puzzle pictures found, but none decoded.');

  const pack: Pack = {
    format: 'momogram-pack', version: 1,
    id: 'android-nonograms-110',
    title: { en: 'Nonograms (Classic)', fr: 'Picross', ru: 'Японские кроссворды' } as Name,
    source: { game: 'Nonograms', platform: 'Android', developer: 'White & Black', year: 2024, file: `${total} puzzles` },
    theme: { palette: { accent: '#4a7dd6', fill: '#2b3a55', grid: '#7992bd', cell: '#f6f7fb', clue: '#263147', cross: '#c0392b', cursor: '#4a7dd6', bg: '#eef2f9', style: 'default' } },
    levels,
  };
  const icon = findIcon(entries);
  if (icon) { pack.icon = icon.icon; pack.source.file += ` (icon ${icon.name} ${icon.w}x${icon.h})`; }
  if (dropped.length) {
    // never drop silently: a few missing pictures are still an import (the game itself can differ)
    pack.source.file += `; skipped: ${dropped.join(', ')}`;
  }
  return pack;
}

// ---- entry points (one read path, like the other Android importers) ----

registerImporter({
  name: 'Nonograms Classic (Android)',
  version: 1,
  detect(data, fileName) {
    if (data.length < 4096) return false;
    try { const entries = entriesOf(data); return looksLike(entries); } catch { return false; }
  },
  read(data, fileName) {
    const entries = entriesOf(data);
    if (!looksLike(entries)) throw new Error('Not a Nonograms Classic APK: puzzle PNGs missing.');
    return [packFromEntries(entries)];
  },
});

registerSetImporter({
  name: 'Nonograms Classic (Android)',
  version: 1,
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      // an already-extracted base APK folder: its own res/drawable-nodpi-v4 lives here
      if (/^res\/drawable-nodpi-v4\//.test(n)) {
        const r = n.slice(0, n.indexOf('res/'));
        roots.add(r === '' ? '.' : r.replace(/\/$/, ''));
      }
    }
    return [...roots];
  },
  async read(files: GameFiles, root: string) {
    const all: Entry[] = [];
    for (const n of files.names) {
      if (root !== '.' && !(n === root || n.startsWith(root + '/'))) continue;
      let data = await files.get(n);
      if (!data) continue;
      if (/\.(apk|xapk|apkm|zip)$/i.test(n)) {
        try { all.push(...entriesOf(data)); } catch { /* skip unreadable */ }
      } else {
        const rel = root === '.' ? n : n.slice(root.length + 1);
        if (!/^\.\.\//.test(rel)) all.push({ name: rel, data });
      }
    }
    if (!looksLike(all)) throw new Error('Not a Nonograms Classic APK: puzzle PNGs missing.');
    return [packFromEntries(all)];
  },
});

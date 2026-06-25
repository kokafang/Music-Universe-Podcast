import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const equals = trimmed.indexOf("=");
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const port = Number(process.env.PORT || 8765);
const runtimeDir = join(root, "assets", "runtime");
const sourceDir = join(root, "assets", "youtube-source");
const genreDataPath = join(root, "assets", "data", "every-noise-genres.json");
const musicBrainzBaseUrl = "https://musicbrainz.org/ws/2/";
const wikipediaApiUrl = "https://en.wikipedia.org/w/api.php";
const musicBrainzUserAgent =
  process.env.MUSICBRAINZ_USER_AGENT || "MusicUniverseMap/0.1.0 (local research prototype; set MUSICBRAINZ_USER_AGENT for contact)";
const isWindows = process.platform === "win32";

function pathLikeAbsolute(value) {
  return isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value);
}

function executableNames(binary) {
  if (!isWindows || /\.[a-z0-9]+$/i.test(binary)) return [binary];
  const exts = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  return [binary, ...exts.map((ext) => `${binary}${ext.toLowerCase()}`), ...exts.map((ext) => `${binary}${ext.toUpperCase()}`)];
}

function findExecutable(command) {
  if (!command) return "";
  if (pathLikeAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? command : "";
  }
  for (const dir of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const name of executableNames(command)) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function pythonFrameworkCandidates(binary) {
  if (isWindows) return [];
  const versionsDir = "/Library/Frameworks/Python.framework/Versions";
  try {
    return readdirSync(versionsDir).map((version) => join(versionsDir, version, "bin", binary));
  } catch {
    return [];
  }
}

function resolveCommand(envNames, binary, extraCandidates = []) {
  const explicit = envFirst(envNames);
  const candidates = [explicit, binary, ...extraCandidates].filter(Boolean);
  for (const candidate of candidates) {
    const found = findExecutable(candidate);
    if (found) return found;
  }
  return explicit || binary;
}

function resolveExistingFile(value) {
  if (!value) return "";
  const file = pathLikeAbsolute(value) ? value : resolve(root, value);
  try {
    return existsSync(file) && statSync(file).isFile() ? file : "";
  } catch {
    return "";
  }
}

function configuredCookieFile() {
  return resolveExistingFile(envFirst(["YTDLP_COOKIES", "YOUTUBE_COOKIES"]));
}

const commands = {
  ytdlp: resolveCommand(["YTDLP_BIN"], "yt-dlp", [
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    ...pythonFrameworkCandidates("yt-dlp")
  ]),
  ffmpeg: resolveCommand(["FFMPEG_BIN"], "ffmpeg", ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]),
  ffprobe: resolveCommand(["FFPROBE_BIN"], "ffprobe", ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"]),
  fishPython: process.env.FISH_PYTHON || join(root, ".venv-fish", isWindows ? "Scripts" : "bin", isWindows ? "python.exe" : "python"),
  fishTts: join(root, "scripts", "fish_tts.py"),
  fishRoot: join(root, "tools", "fish-speech"),
  fishCheckpoint: join(root, "tools", "fish-speech", "checkpoints", "openaudio-s1-mini"),
  gptSovitsPython: process.env.GPT_SOVITS_PYTHON || join(root, ".venv-gpt-sovits", isWindows ? "Scripts" : "bin", isWindows ? "python.exe" : "python"),
  gptSovitsTts: join(root, "scripts", "gpt_sovits_tts.py"),
  gptSovitsRoot: join(root, "tools", "GPT-SoVITS"),
  gptSovitsGPTModel: join(root, "tools", "GPT-SoVITS", "GPT_SoVITS", "pretrained_models", "gsv-v2final-pretrained", "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"),
  gptSovitsModel: join(root, "tools", "GPT-SoVITS", "GPT_SoVITS", "pretrained_models", "gsv-v2final-pretrained", "s2G2333k.pth"),
  cosyPython: process.env.COSYVOICE_PYTHON || join(root, ".venv-cosyvoice", isWindows ? "Scripts" : "bin", isWindows ? "python.exe" : "python"),
  cosyTts: join(root, "scripts", "cosyvoice_tts.py"),
  cosyRoot: join(root, "tools", "CosyVoice"),
  cosyModel: join(root, "tools", "CosyVoice", "pretrained_models", process.env.COSYVOICE_MODEL || "CosyVoice-300M-SFT")
};

function ytdlpAuthArgs() {
  const args = [];
  const cookies = configuredCookieFile();
  const cookiesFromBrowser = envFirst(["YTDLP_COOKIES_FROM_BROWSER", "YOUTUBE_COOKIES_FROM_BROWSER"]);
  if (cookies) args.push("--cookies", cookies);
  if (cookiesFromBrowser) args.push("--cookies-from-browser", cookiesFromBrowser);
  if (envFirst(["YTDLP_REMOTE_COMPONENTS"]) !== "0") args.push("--remote-components", envFirst(["YTDLP_REMOTE_COMPONENTS"]) || "ejs:github");
  return args;
}

const GENERIC_GENRE_TOKENS = new Set([
  "music",
  "official",
  "video",
  "audio",
  "lyrics",
  "song",
  "songs",
  "topic",
  "records",
  "channel",
  "pop",
  "rock",
  "the",
  "and",
  "feat",
  "ft"
]);
const genreIdAliases = {
  cpop: "c-pop",
  artpop: "art-pop",
  popballad: "classic-mandopop",
  "alt-metal": "alternative-metal",
  altmetal: "alternative-metal",
  "alt-rock": "alternative-rock",
  altrock: "alternative-rock",
  "hip-hop": "hiphop",
  "hip hop": "hiphop",
  hiphop: "hiphop"
};

let universeGenreCache = null;
let musicBrainzLastRequestAt = 0;
const musicBrainzCache = new Map();
const publicResearchCache = new Map();

for (const dir of [runtimeDir, sourceDir]) mkdirSync(dir, { recursive: true });

const genreRepresentatives = {
  funk: [
    ["James Brown", "I Got You (I Feel Good)", "James Brown I Got You I Feel Good official audio", 4],
    ["Parliament", "Flash Light", "Parliament Flash Light official audio", 12]
  ],
  soul: [
    ["Stevie Wonder", "Living for the City", "Stevie Wonder Living for the City official audio", 34],
    ["Aretha Franklin", "Respect", "Aretha Franklin Respect official audio", 18]
  ],
  rnb: [
    ["Stevie Wonder", "Maybe Your Baby", "Stevie Wonder Maybe Your Baby official audio", 16],
    ["Michael Jackson", "Billie Jean", "Michael Jackson Billie Jean official audio", 18]
  ],
  rock: [
    ["Nirvana", "Smells Like Teen Spirit", "Nirvana Smells Like Teen Spirit official audio", 36],
    ["The Rolling Stones", "Satisfaction", "The Rolling Stones Satisfaction official audio", 8]
  ],
  disco: [
    ["Chic", "Good Times", "Chic Good Times official audio", 18],
    ["Donna Summer", "I Feel Love", "Donna Summer I Feel Love official audio", 25]
  ],
  house: [
    ["Daft Punk", "One More Time", "Daft Punk One More Time official audio", 48],
    ["CeCe Peniston", "Finally", "CeCe Peniston Finally official audio", 22]
  ],
  electronic: [
    ["Kraftwerk", "The Robots", "Kraftwerk The Robots official audio", 20],
    ["Daft Punk", "One More Time", "Daft Punk One More Time official audio", 48]
  ],
  techno: [
    ["Juan Atkins", "Clear", "Cybotron Clear official audio", 20],
    ["Inner City", "Good Life", "Inner City Good Life official audio", 20]
  ],
  hiphop: [
    ["The Sugarhill Gang", "Rapper's Delight", "The Sugarhill Gang Rapper's Delight official audio", 22],
    ["Grandmaster Flash", "The Message", "Grandmaster Flash The Message official audio", 20]
  ],
  jazz: [
    ["Miles Davis", "So What", "Miles Davis So What official audio", 50],
    ["Herbie Hancock", "Chameleon", "Herbie Hancock Chameleon official audio", 34]
  ],
  blues: [
    ["B.B. King", "The Thrill Is Gone", "B.B. King The Thrill Is Gone official audio", 18],
    ["Muddy Waters", "Mannish Boy", "Muddy Waters Mannish Boy official audio", 15]
  ],
  punk: [
    ["The Clash", "London Calling", "The Clash London Calling official audio", 8],
    ["Ramones", "Blitzkrieg Bop", "Ramones Blitzkrieg Bop official audio", 5]
  ],
  metal: [
    ["Black Sabbath", "Paranoid", "Black Sabbath Paranoid official audio", 9],
    ["Metallica", "Enter Sandman", "Metallica Enter Sandman official audio", 35]
  ],
  reggae: [
    ["Bob Marley", "Could You Be Loved", "Bob Marley Could You Be Loved official audio", 15],
    ["Toots and the Maytals", "Pressure Drop", "Toots and the Maytals Pressure Drop official audio", 12]
  ],
  latin: [
    ["Santana", "Oye Como Va", "Santana Oye Como Va official audio", 16],
    ["Buena Vista Social Club", "Chan Chan", "Buena Vista Social Club Chan Chan official audio", 14]
  ],
  afrobeat: [
    ["Fela Kuti", "Zombie", "Fela Kuti Zombie official audio", 52],
    ["Tony Allen", "Secret Agent", "Tony Allen Secret Agent official audio", 24]
  ],
  ambient: [
    ["Brian Eno", "An Ending", "Brian Eno An Ending official audio", 18],
    ["Aphex Twin", "Rhubarb", "Aphex Twin Rhubarb official audio", 12]
  ],
  synthpop: [
    ["Depeche Mode", "Enjoy the Silence", "Depeche Mode Enjoy the Silence official audio", 20],
    ["New Order", "Blue Monday", "New Order Blue Monday official audio", 42]
  ],
  country: [
    ["Johnny Cash", "I Walk the Line", "Johnny Cash I Walk the Line official audio", 8],
    ["Dolly Parton", "Jolene", "Dolly Parton Jolene official audio", 7]
  ],
  folk: [
    ["Bob Dylan", "Blowin' in the Wind", "Bob Dylan Blowin in the Wind official audio", 6],
    ["Joni Mitchell", "A Case of You", "Joni Mitchell A Case of You official audio", 8]
  ],
  gospel: [
    ["Aretha Franklin", "Amazing Grace", "Aretha Franklin Amazing Grace official audio", 25],
    ["The Staple Singers", "I'll Take You There", "The Staple Singers I'll Take You There official audio", 12]
  ],
  classical: [
    ["Bach", "Cello Suite No. 1 Prelude", "Bach Cello Suite No. 1 Prelude official audio", 6],
    ["Beethoven", "Symphony No. 5", "Beethoven Symphony No. 5 official audio", 3]
  ],
  trap: [
    ["Future", "Mask Off", "Future Mask Off official audio", 14],
    ["Migos", "Bad and Boujee", "Migos Bad and Boujee official audio", 15]
  ],
  cpop: [
    ["Faye Wong", "Red Bean", "王菲 红豆 official audio", 42],
    ["Teresa Teng", "The Moon Represents My Heart", "邓丽君 月亮代表我的心 official audio", 18]
  ],
  mandopop: [
    ["Faye Wong", "Red Bean", "王菲 红豆 official audio", 42],
    ["Jay Chou", "Qing Hua Ci", "周杰伦 青花瓷 official audio", 35]
  ],
  cantopop: [
    ["Faye Wong", "Fragile Woman", "王菲 容易受伤的女人 official audio", 32],
    ["Beyond", "Boundless Oceans Vast Skies", "Beyond 海阔天空 official audio", 58]
  ],
  artpop: [
    ["Faye Wong", "Eyes On Me", "王菲 Eyes On Me official audio", 20],
    ["Kate Bush", "Running Up That Hill", "Kate Bush Running Up That Hill official audio", 38]
  ],
  popballad: [
    ["Faye Wong", "Red Bean", "王菲 红豆 official audio", 42],
    ["Jacky Cheung", "Kiss Goodbye", "张学友 吻别 official audio", 52]
  ]
};

const artistGenreHints = [
  [/stevie wonder|james brown|parliament|sly and the family stone/i, ["funk", "soul", "rnb", "rock"]],
  [/daft punk|chic|donna summer/i, ["house", "disco", "electronic", "funk"]],
  [/nirvana|pearl jam|soundgarden/i, ["grunge", "rock", "punk", "metal"]],
  [/miles davis|john coltrane|herbie hancock|duke ellington/i, ["jazz", "blues", "funk"]],
  [/bob marley|toots and the maytals/i, ["reggae", "soul", "afrobeat"]],
  [/fela kuti|tony allen/i, ["afrobeat", "funk", "jazz"]],
  [/metallica|black sabbath|iron maiden/i, ["metal", "rock", "punk"]],
  [/linkin park|limp bizkit|korn|system of a down|deftones|papa roach|evanescence/i, ["nu-metal", "rap-rock", "alternative-metal", "post-grunge"]],
  [/ramones|the clash|sex pistols/i, ["punk", "rock", "grunge"]],
  [/taylor swift|dolly parton|johnny cash/i, ["country", "folk", "synthpop"]],
  [/kendrick lamar|drake|future|migos|nas|jay-z|2pac|notorious/i, ["hiphop", "trap", "rnb"]],
  [/bach|beethoven|mozart|chopin/i, ["classical", "ambient"]],
  [/faye wong|王菲|王靖雯|teresa teng|邓丽君|jay chou|周杰伦|jacky cheung|张学友|beyond/i, ["cpop", "mandopop", "cantopop", "artpop", "popballad"]]
];

const keywordGenreHints = [
  [/c-?pop|chinese pop|mandopop|cantopop|華語|华语|國語|国语|粵語|粤语|流行|抒情|紅豆|红豆/i, "cpop"],
  [/mandopop|國語|国语|華語|华语/i, "mandopop"],
  [/cantopop|粵語|粤语|港樂|港乐/i, "cantopop"],
  [/art.?pop|dream.?pop|alternative pop|實驗流行|实验流行/i, "artpop"],
  [/ballad|抒情|情歌|慢歌/i, "popballad"],
  [/funk/i, "funk"],
  [/soul/i, "soul"],
  [/r&b|rnb|rhythm and blues/i, "rnb"],
  [/rock/i, "rock"],
  [/disco/i, "disco"],
  [/house/i, "house"],
  [/electronic|electronica|edm/i, "electronic"],
  [/techno/i, "techno"],
  [/hip.?hop|rap/i, "hiphop"],
  [/trap/i, "trap"],
  [/jazz/i, "jazz"],
  [/blues/i, "blues"],
  [/punk/i, "punk"],
  [/metal/i, "metal"],
  [/reggae|dub/i, "reggae"],
  [/latin|salsa|bossa/i, "latin"],
  [/afrobeat/i, "afrobeat"],
  [/ambient/i, "ambient"],
  [/synth.?pop|new wave/i, "synthpop"],
  [/country/i, "country"],
  [/folk/i, "folk"],
  [/gospel/i, "gospel"],
  [/classical|orchestra|symphony/i, "classical"]
];

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[-_/]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchTokens(value) {
  return [...new Set(normalizeSearchText(value).split(" ").filter((token) => {
    if (!token) return false;
    if (GENERIC_GENRE_TOKENS.has(token)) return false;
    return token.length >= 3 || /[\u3400-\u9fff]/.test(token);
  }))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadUniverseGenres() {
  if (universeGenreCache) return universeGenreCache;
  let rawGenres = [];
  try {
    const raw = JSON.parse(readFileSync(genreDataPath, "utf8"));
    rawGenres = Array.isArray(raw.genres) ? raw.genres : [];
  } catch (error) {
    console.warn(`Could not load genre universe from ${genreDataPath}: ${error.message}`);
  }
  const genres = rawGenres
    .filter((genre) => genre?.id && genre?.name)
    .map((genre, index) => {
      const aliases = Array.isArray(genre.aliases) ? genre.aliases.filter(Boolean) : [];
      const tags = Array.isArray(genre.tags) ? genre.tags.filter(Boolean) : [];
      const indexText = normalizeSearchText([
        genre.id,
        genre.name,
        genre.family,
        genre.sample,
        aliases.join(" "),
        tags.join(" ")
      ].filter(Boolean).join(" "));
      return {
        ...genre,
        id: String(genre.id),
        name: String(genre.name),
        aliases,
        tags,
        sample: genre.sample || "",
        lat: Number(genre.lat),
        lon: Number(genre.lon),
        sourceRank: Number(genre.sourceRank || index + 1),
        family: genre.family || "",
        indexText,
        tokens: searchTokens([genre.id, genre.name, aliases.join(" "), genre.family].join(" "))
      };
    });
  universeGenreCache = {
    genres,
    byId: new Map(genres.map((genre) => [genre.id, genre]))
  };
  return universeGenreCache;
}

function resolveGenreId(id) {
  const raw = String(id || "");
  const universe = loadUniverseGenres();
  if (universe.byId.has(raw)) return raw;
  const alias = genreIdAliases[raw] || raw;
  if (universe.byId.has(alias)) return alias;
  return raw;
}

function hasGenre(id) {
  const resolved = resolveGenreId(id);
  const universe = loadUniverseGenres();
  return universe.byId.has(resolved) || Boolean(genreRepresentatives[resolved] || genreRepresentatives[id] || genreLabels[resolved] || genreLabels[id]);
}

function addGenreScore(scores, id, amount, reason = "") {
  const resolved = resolveGenreId(id);
  if (!resolved || !hasGenre(resolved)) return;
  const current = scores.get(resolved) || { id: resolved, score: 0, reasons: [] };
  current.score += amount;
  if (reason) current.reasons.push(reason);
  scores.set(resolved, current);
}

function genreSortRank(id) {
  const universe = loadUniverseGenres();
  const genre = universe.byId.get(resolveGenreId(id));
  return genre?.sourceRank || 9999;
}

function scoreUniverseGenre(genre, haystackNorm, hayTokens) {
  let score = 0;
  const nameNorm = normalizeSearchText(genre.name);
  const idNorm = normalizeSearchText(genre.id);
  const labels = [nameNorm, idNorm, ...(genre.aliases || []).map(normalizeSearchText)].filter(Boolean);
  for (const label of labels) {
    if (label.length >= 4 && haystackNorm.includes(label)) score += label === nameNorm ? 18 : 12;
  }
  for (const token of genre.tokens || []) {
    if (hayTokens.has(token)) score += token.length > 4 ? 4 : 2;
  }
  if (genre.family && hayTokens.has(normalizeSearchText(genre.family))) score += 2;
  return score;
}

function tagToGenreIdCandidates(label) {
  const normalized = normalizeSearchText(label);
  const hyphenated = normalized.replace(/\s+/g, "-");
  const compact = normalized.replace(/\s+/g, "");
  return [...new Set([label, normalized, hyphenated, compact].filter(Boolean).map((item) => String(item).toLowerCase()))];
}

function addExternalTagGenreScore(scores, label, amount, reason = "external") {
  const normalized = normalizeSearchText(label);
  if (!normalized || GENERIC_GENRE_TOKENS.has(normalized)) return;
  const universe = loadUniverseGenres();
  const candidates = tagToGenreIdCandidates(label);
  let exactMatched = false;

  for (const candidate of candidates) {
    const resolved = resolveGenreId(candidate);
    if (universe.byId.has(resolved)) {
      addGenreScore(scores, resolved, amount * 1.35, `${reason}:exact`);
      exactMatched = true;
    }
  }

  for (const genre of universe.genres) {
    const labels = [genre.id, genre.name, ...(genre.aliases || [])].map(normalizeSearchText).filter(Boolean);
    if (labels.includes(normalized)) {
      addGenreScore(scores, genre.id, amount * 1.25, `${reason}:alias`);
      exactMatched = true;
      continue;
    }
    if (!exactMatched) {
      const score = scoreUniverseGenre(genre, normalized, new Set(searchTokens(normalized)));
      if (score >= 10) addGenreScore(scores, genre.id, Math.min(amount, score * 1.5), `${reason}:fuzzy`);
    }
  }
}

function collectMusicBrainzTags(entity, weight, source, scores, evidence) {
  for (const item of entity?.genres || []) {
    const label = item.name || item.tag;
    if (!label) continue;
    const amount = weight + Math.min(16, Number(item.count || 0));
    evidence.push({ label, source: `${source}:genre`, count: item.count || 0 });
    addExternalTagGenreScore(scores, label, amount, `${source}:genre`);
  }
  for (const item of entity?.tags || []) {
    const label = item.name || item.tag;
    if (!label) continue;
    const amount = weight * 0.72 + Math.min(12, Number(item.count || 0));
    evidence.push({ label, source: `${source}:tag`, count: item.count || 0 });
    addExternalTagGenreScore(scores, label, amount, `${source}:tag`);
  }
}

function musicBrainzArtistName(recording = {}) {
  return (recording["artist-credit"] || [])
    .map((credit) => credit?.name || credit?.artist?.name)
    .filter(Boolean)
    .join(" ");
}

function simpleTextMatchScore(a, b) {
  const left = normalizeSearchText(a);
  const right = normalizeSearchText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.72;
  const leftTokens = new Set(searchTokens(left));
  const rightTokens = new Set(searchTokens(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function scoreMusicBrainzRecording(recording, artist, title, durationSeconds) {
  let score = Number(recording.score || 0) / 100;
  score += simpleTextMatchScore(recording.title, title) * 2.2;
  score += simpleTextMatchScore(musicBrainzArtistName(recording), artist) * 2;
  const mbDuration = Number(recording.length || 0) / 1000;
  if (durationSeconds && mbDuration) {
    const diff = Math.abs(mbDuration - durationSeconds);
    if (diff <= 5) score += 0.8;
    else if (diff <= 15) score += 0.35;
  }
  return score;
}

async function musicBrainzFetchJson(resource, params = {}) {
  const url = new URL(resource.replace(/^\//, ""), musicBrainzBaseUrl);
  Object.entries({ ...params, fmt: "json" }).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  const cacheKey = url.toString();
  if (musicBrainzCache.has(cacheKey)) return musicBrainzCache.get(cacheKey);

  const elapsed = Date.now() - musicBrainzLastRequestAt;
  if (elapsed < 1050) await sleep(1050 - elapsed);
  musicBrainzLastRequestAt = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": musicBrainzUserAgent
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`MusicBrainz ${response.status} for ${url.pathname}`);
    const data = await response.json();
    musicBrainzCache.set(cacheKey, data);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function musicBrainzSearchQuery(artist, title, broad = false) {
  const cleanArtist = String(artist || "").replace(/"/g, "").trim();
  const cleanTitle = String(title || "").replace(/"/g, "").trim();
  if (broad) return `${cleanArtist} ${cleanTitle}`.trim();
  return [`recording:"${cleanTitle}"`, cleanArtist ? `artist:"${cleanArtist}"` : ""].filter(Boolean).join(" AND ");
}

async function findMusicBrainzRecording(artist, title, durationSeconds) {
  const attempts = [
    musicBrainzSearchQuery(artist, title, false),
    musicBrainzSearchQuery(artist, title, true)
  ].filter(Boolean);

  for (const query of attempts) {
    const data = await musicBrainzFetchJson("recording", { query, limit: 8 });
    const recordings = (data.recordings || [])
      .map((recording) => ({ recording, matchScore: scoreMusicBrainzRecording(recording, artist, title, durationSeconds) }))
      .sort((a, b) => b.matchScore - a.matchScore);
    if (recordings[0]?.matchScore >= 2.1) return recordings[0].recording;
  }
  return null;
}

async function inferGenresFromMusicBrainz(info, parsedSong) {
  const duration = Number(info.duration || 0) || 0;
  const recording = await findMusicBrainzRecording(parsedSong.artist, parsedSong.title, duration);
  if (!recording?.id) return null;

  const scores = new Map();
  const evidence = [];
  inferGenres(info).forEach((id, index) => addGenreScore(scores, id, 28 - index * 3, "metadata-context"));
  const recordingLookup = await musicBrainzFetchJson(`recording/${recording.id}`, {
    inc: "genres+tags+artist-credits+releases+release-groups"
  });
  collectMusicBrainzTags(recordingLookup, 82, "musicbrainz-recording", scores, evidence);

  const releaseGroupIds = new Set();
  for (const release of recordingLookup.releases || []) {
    const releaseGroupId = release?.["release-group"]?.id;
    if (releaseGroupId) releaseGroupIds.add(releaseGroupId);
  }
  for (const releaseGroup of recordingLookup["release-groups"] || []) {
    if (releaseGroup?.id) releaseGroupIds.add(releaseGroup.id);
  }

  const releaseGroups = [];
  for (const releaseGroupId of [...releaseGroupIds].slice(0, 2)) {
    const releaseGroup = await musicBrainzFetchJson(`release-group/${releaseGroupId}`, {
      inc: "genres+tags+artist-credits"
    });
    releaseGroups.push({
      id: releaseGroup.id,
      title: releaseGroup.title,
      type: releaseGroup["primary-type"],
      firstReleaseDate: releaseGroup["first-release-date"],
      artist: musicBrainzArtistName(releaseGroup),
      tags: [...(releaseGroup.genres || []), ...(releaseGroup.tags || [])]
        .map((item) => item.name || item.tag)
        .filter(Boolean)
        .slice(0, 10)
    });
    collectMusicBrainzTags(releaseGroup, 66, "musicbrainz-release-group", scores, evidence);
  }

  const artistIds = new Set();
  for (const credit of recordingLookup["artist-credit"] || recording["artist-credit"] || []) {
    if (credit?.artist?.id) artistIds.add(credit.artist.id);
  }
  const artists = [];
  for (const artistId of [...artistIds].slice(0, 2)) {
    const artist = await musicBrainzFetchJson(`artist/${artistId}`, { inc: "genres+tags" });
    artists.push({
      id: artist.id,
      name: artist.name,
      type: artist.type,
      country: artist.country,
      beginArea: artist["begin-area"]?.name,
      area: artist.area?.name,
      lifeSpan: artist["life-span"],
      tags: [...(artist.genres || []), ...(artist.tags || [])]
        .map((item) => item.name || item.tag)
        .filter(Boolean)
        .slice(0, 12)
    });
    collectMusicBrainzTags(artist, 44, "musicbrainz-artist", scores, evidence);
  }

  const ranked = [...scores.values()]
    .filter((item) => hasGenre(item.id))
    .sort((a, b) => b.score - a.score || genreSortRank(a.id) - genreSortRank(b.id))
    .map((item) => item.id);
  const unique = [...new Set(ranked)].slice(0, 5);
  if (!unique.length) return null;
  const genres = unique.length >= 2 ? unique.slice(0, 4) : [...new Set([...unique, ...neighborGenres(unique[0])])].slice(0, 4);
  return {
    genres,
    source: "MusicBrainz genres/tags + Every Noise mapping",
    confidence: "musicbrainz",
    musicBrainz: {
      recordingMbid: recordingLookup.id || recording.id,
      recordingTitle: recordingLookup.title || recording.title,
      artist: musicBrainzArtistName(recordingLookup) || musicBrainzArtistName(recording),
      releaseGroups,
      artists,
      evidence: evidence.slice(0, 12)
    }
  };
}

async function inferGenresWithMusicBrainz(info, parsedSong) {
  try {
    const musicBrainz = await inferGenresFromMusicBrainz(info, parsedSong);
    if (musicBrainz?.genres?.length) return musicBrainz;
  } catch (error) {
    console.warn(`MusicBrainz genre lookup failed: ${error.message}`);
  }
  return {
    genres: inferGenres(info),
    source: "YouTube metadata heuristic + Every Noise mapping",
    confidence: "metadata-fallback",
    musicBrainz: null
  };
}

function metadataOnlyInfo(body, url, reason = "") {
  const rawTitle = String(body.title || body.name || "").trim();
  const rawArtist = String(body.artist || body.uploader || body.channel || "").trim();
  const parsed = parseArtistTitle({
    title: rawTitle || "Unknown Track",
    artist: rawArtist || "Unknown Artist",
    uploader: rawArtist || "Search result",
    channel: rawArtist || "Search result"
  });
  return {
    id: body.id || safeId(url || `${parsed.artist}-${parsed.title}`),
    title: parsed.title,
    track: parsed.title,
    artist: parsed.artist,
    creator: rawArtist || parsed.artist,
    uploader: rawArtist || parsed.artist,
    channel: rawArtist || parsed.artist,
    duration: Number(body.duration || 0) || null,
    webpage_url: url,
    release_year: body.year || "",
    upload_date: "",
    tags: [],
    categories: [],
    description: [
      rawTitle,
      rawArtist,
      body.durationLabel,
      reason ? `Metadata-only fallback: ${reason}` : ""
    ].filter(Boolean).join(" ")
  };
}

function createSessionSong({ sessionId, info, body, url, artist, title, videoId, genreResult, sourceFile, sourceDuration, warning }) {
  const genres = genreResult.genres;
  const hasAudio = Boolean(sourceFile);
  return {
    title,
    artist,
    year: info.release_year || String(info.upload_date || "").slice(0, 4) || body.year || "unknown",
    bpm: "metadata",
    key: "auto",
    region: info.uploader || info.channel || body.uploader || "Online source",
    source: hasAudio ? `${genreResult.source} + yt-dlp audio` : `${genreResult.source} + metadata-only`,
    videoId,
    youtubeUrl: info.webpage_url || url,
    confidence: genreResult.confidence,
    genres,
    summary: hasAudio
      ? `Matched ${artist} - ${title}. Audio is cached locally and mapped to ${genreRoute(genres)}.`
      : `Matched ${artist} - ${title} from search metadata. YouTube audio was not available on this machine, so the radio workspace opens first and sampling will use available preview/fallback sources.`,
    duration: sourceDuration || Number(info.duration || body.duration || 0) || 0,
    ...(sourceFile ? { sourceFile } : {}),
    sessionId,
    audioAvailable: hasAudio,
    warning: warning || "",
    genreEvidence: genreResult.musicBrainz?.evidence || []
  };
}

function parseUniverseSample(sample) {
  const text = String(sample || "").trim();
  const quoted = text.match(/^(.+?)\s+"(.+)"$/);
  if (quoted) return { artist: quoted[1].trim(), title: quoted[2].trim() };
  const dash = text.match(/^(.+?)\s+-\s+(.+)$/);
  if (dash) return { artist: dash[1].trim(), title: dash[2].trim() };
  return null;
}

function representativeFromUniverseGenre(genreId) {
  const universe = loadUniverseGenres();
  const genre = universe.byId.get(resolveGenreId(genreId));
  const parsed = parseUniverseSample(genre?.sample);
  if (!genre || !parsed) return null;
  const query = `${parsed.artist} ${parsed.title} official audio`;
  return {
    title: parsed.title,
    artist: parsed.artist,
    query,
    start: 12,
    length: DEFAULT_MUSIC_LISTEN_SECONDS,
    youtube: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    reason: `用 Every Noise 节点「${genre.name}」的样本曲 ${clipName(parsed)}，展示这个宇宙节点的代表声音。`,
    nodes: [genre.id, ...neighborGenres(genre.id).slice(0, 2)],
    edges: []
  };
}

const infoPrintTemplate =
  "%(.{id,title,track,artist,creator,uploader,channel,duration,webpage_url,release_year,upload_date,tags,categories,description,channel_is_verified})j";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, ...(options.env || {}) },
    maxBuffer: 1024 * 1024 * 80,
    timeout: options.timeoutMs || undefined
  });
  if (result.error || result.status !== 0) {
    const spawnedError = result.error ? `\n${result.error.message}` : "";
    const detail = options.capture ? `\n${result.stdout || ""}\n${result.stderr || ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed${spawnedError}${detail}`);
  }
  return result.stdout?.trim() || "";
}

function safeId(value) {
  return String(value || "item")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseArtistTitle(info) {
  const rawTitle = info.track || info.title || "Unknown Track";
  const artist = info.artist || info.creator || info.uploader || info.channel || "Unknown Artist";
  let title = rawTitle;
  let parsedArtist = artist;
  const dash = rawTitle.match(/^(.+?)\s+-\s+(.+?)(?:\s+\(|$)/);
  if (dash && (!info.artist || info.artist === info.uploader)) {
    parsedArtist = dash[1].trim();
    title = dash[2].replace(/\s*\[(official|audio|video|lyrics).*$/i, "").trim();
  }
  title = cleanSongTitleForSpeech(title);
  return { artist: parsedArtist, title };
}

function inferGenres(info) {
  const trustedParts = [
    info.title,
    info.track,
    info.artist,
    info.creator,
    info.uploader,
    info.channel,
    ...(info.tags || []),
    ...(info.categories || [])
  ].filter(Boolean);
  const displayParts = [...trustedParts, info.description].filter(Boolean);
  const trustedHaystack = trustedParts.join(" ");
  const displayHaystack = displayParts.join(" ");
  const trustedNorm = normalizeSearchText(trustedHaystack);
  const trustedTokens = new Set(searchTokens(trustedHaystack));

  const scores = new Map();
  for (const [pattern, ids] of artistGenreHints) {
    if (pattern.test(trustedHaystack)) ids.forEach((id, index) => addGenreScore(scores, id, 56 - index * 4, "artist"));
  }
  for (const [pattern, id] of keywordGenreHints) {
    if (pattern.test(trustedHaystack)) addGenreScore(scores, id, 18, "keyword");
  }

  const universe = loadUniverseGenres();
  for (const genre of universe.genres) {
    const score = scoreUniverseGenre(genre, trustedNorm, trustedTokens);
    if (score > 0) addGenreScore(scores, genre.id, Math.min(score, 16), "universe");
  }

  if (/[\u3400-\u9fff]/.test(displayHaystack) || /faye wong|teresa teng|jay chou|jacky cheung|beyond/i.test(displayHaystack)) {
    [
      ["c-pop", 24],
      ["mandopop", 23],
      ["classic-mandopop", 21],
      ["cantopop", 18],
      ["classic-cantopop", 12],
      ["mainland-chinese-pop", 11],
      ["taiwan-pop", 9],
      ["art-pop", 8]
    ].forEach(([id, score]) => addGenreScore(scores, id, score, "c-pop-context"));
  }

  if (/紅豆|红豆|red bean/i.test(displayHaystack)) {
    [
      ["classic-mandopop", 14],
      ["mandopop", 12],
      ["c-pop", 10],
      ["cantopop", 7],
      ["art-pop", 5]
    ].forEach(([id, score]) => addGenreScore(scores, id, score, "song-context"));
  }

  const ranked = [...scores.values()]
    .filter((item) => hasGenre(item.id))
    .sort((a, b) => b.score - a.score || genreSortRank(a.id) - genreSortRank(b.id))
    .map((item) => item.id);
  const unique = [...new Set(ranked)];
  if (unique.length >= 2) return unique.slice(0, 4);
  if (unique.length === 1) return [...new Set([...unique, ...neighborGenres(unique[0])])].filter(hasGenre).slice(0, 4);
  return ["rock", "soul", "electronic"];
}

function neighborGenres(genre) {
  const neighbors = {
    funk: ["soul", "rnb", "disco"],
    soul: ["gospel", "funk", "rnb"],
    rnb: ["soul", "funk", "trap"],
    rock: ["blues", "punk", "metal"],
    disco: ["funk", "house", "electronic"],
    house: ["disco", "electronic", "techno"],
    electronic: ["house", "techno", "ambient"],
    techno: ["electronic", "house", "synthpop"],
    hiphop: ["funk", "trap", "reggae"],
    trap: ["hiphop", "rnb", "electronic"],
    jazz: ["blues", "funk", "latin"],
    blues: ["jazz", "rock", "soul"],
    punk: ["rock", "grunge", "metal"],
    metal: ["rock", "punk", "grunge"],
    reggae: ["hiphop", "latin", "soul"],
    latin: ["jazz", "afrobeat", "reggae"],
    afrobeat: ["funk", "jazz", "latin"],
    ambient: ["electronic", "classical", "synthpop"],
    synthpop: ["electronic", "house", "ambient"],
    country: ["folk", "rock", "blues"],
    folk: ["country", "classical", "rock"],
    gospel: ["soul", "rnb", "blues"],
    classical: ["ambient", "folk", "jazz"],
    grunge: ["rock", "punk", "metal"],
    cpop: ["c-pop", "mandopop", "classic-mandopop"],
    "c-pop": ["mandopop", "classic-mandopop", "cantopop"],
    mandopop: ["c-pop", "classic-mandopop", "mainland-chinese-pop"],
    "classic-mandopop": ["mandopop", "c-pop", "taiwan-pop"],
    cantopop: ["c-pop", "classic-cantopop", "hong-kong-rock"],
    "classic-cantopop": ["cantopop", "c-pop", "hong-kong-indie"],
    artpop: ["art-pop", "dream-pop", "synthpop"],
    "art-pop": ["dream-pop", "sophisti-pop", "c-pop"],
    popballad: ["classic-mandopop", "mandopop", "folk"]
  };
  const baseId = resolveGenreId(genre);
  const manual = (neighbors[genre] || neighbors[baseId] || [])
    .map(resolveGenreId)
    .filter((id) => id !== baseId && hasGenre(id));
  const universe = loadUniverseGenres();
  const base = universe.byId.get(baseId);
  if (!base || !Number.isFinite(base.lat) || !Number.isFinite(base.lon)) {
    return manual.length ? [...new Set(manual)].slice(0, 3) : ["rock", "soul", "electronic"];
  }
  const sameFamily = universe.genres
    .filter((candidate) => candidate.id !== base.id && candidate.family && candidate.family === base.family)
    .sort((a, b) => Math.abs(a.sourceRank - base.sourceRank) - Math.abs(b.sourceRank - base.sourceRank))
    .map((candidate) => candidate.id)
    .slice(0, 3);
  const nearest = universe.genres
    .filter((candidate) => candidate.id !== base.id && Number.isFinite(candidate.lat) && Number.isFinite(candidate.lon))
    .map((candidate) => ({
      id: candidate.id,
      distance: Math.hypot(candidate.lat - base.lat, candidate.lon - base.lon),
      rank: candidate.sourceRank
    }))
    .sort((a, b) => a.distance - b.distance || a.rank - b.rank)
    .map((candidate) => candidate.id)
    .slice(0, 6);
  return [...new Set([...manual, ...sameFamily, ...nearest])]
    .filter((id) => id !== baseId && hasGenre(id))
    .slice(0, 3);
}

function downloadAudio(url, key) {
  const existing = readdirSync(sourceDir).find((name) => name.startsWith(`${key}.`));
  if (existing) return join(sourceDir, existing);
  run(commands.ytdlp, [
    "--no-update",
    "--no-playlist",
    ...ytdlpAuthArgs(),
    "-f",
    "ba",
    "-o",
    join(sourceDir, `${key}.%(ext)s`),
    url
  ], { timeoutMs: Number(process.env.YTDLP_TIMEOUT_MS || 90000) || 90000 });
  const downloaded = readdirSync(sourceDir).find((name) => name.startsWith(`${key}.`));
  if (!downloaded) throw new Error(`No audio downloaded for ${url}`);
  return join(sourceDir, downloaded);
}

function getInfo(url) {
  const raw = run(commands.ytdlp, [
    "--no-update",
    "--skip-download",
    "--no-playlist",
    ...ytdlpAuthArgs(),
    "--print",
    infoPrintTemplate,
    url
  ], {
    capture: true,
    timeoutMs: Number(process.env.YTDLP_TIMEOUT_MS || 60000) || 60000
  });
  const info = JSON.parse(raw.split("\n").at(-1));
  if (info.description) info.description = String(info.description).slice(0, 2000);
  return info;
}

function getDuration(file) {
  const raw = run(commands.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", file], {
    capture: true
  });
  return Number.parseFloat(raw);
}

function formatTime(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

function ttsSegmentPath(dir, guideId, index) {
  return join(dir, `${guideId}-${String(index).padStart(2, "0")}-tts.wav`);
}

function ttsRawPath(dir, guideId, index, ext = "wav") {
  return join(dir, `${guideId}-${String(index).padStart(2, "0")}-tts.raw.${ext}`);
}

function ttsMetaPath(output) {
  return `${output}.json`;
}

function ttsSegmentFresh(output, meta) {
  if (!existsSync(output) || !existsSync(ttsMetaPath(output))) return false;
  try {
    const cached = JSON.parse(readFileSync(ttsMetaPath(output), "utf8"));
    return Object.entries(meta).every(([key, value]) => cached[key] === value);
  } catch {
    return false;
  }
}

function writeTtsMeta(output, meta) {
  writeFileSync(ttsMetaPath(output), JSON.stringify({
    ...meta,
    generatedAt: new Date().toISOString()
  }, null, 2));
}

const MIN_SONG_SOURCE_SECONDS = 30;
const MIN_MUSIC_LISTEN_SECONDS = 30;
const DEFAULT_MUSIC_LISTEN_SECONDS = 30;
const TTS_POSTPROCESS_VERSION = "voice-no-fade-v3";
const MUSIC_CLIP_EDIT_VERSION = "music-continuous-focus30-bed-ducking-v1";
const DEEPSEEK_ELEVENLABS_VERSION = "deepseek-elevenlabs-v1";
const DEEPSEEK_MINIMAX_VERSION = "deepseek-minimax-v1";
const VOLC_PODCAST_VERSION = "volc-podcast-action3-mp3-split-v15-continuous-music-bed";
const DEEPSEEK_GUIDE_VERSION = "deepseek-guides-dialogue-v9-aligned-code-switch";
const ELEVENLABS_TEXT_NORMALIZATION_VERSION = "mandarin-normalized-v2";
const MINIMAX_TEXT_NORMALIZATION_VERSION = "mandarin-normalized-v2";
const VOLC_TEXT_NORMALIZATION_VERSION = "mandarin-code-switch-v3";

function ttsVoiceFilter(voice) {
  const highpass = voice === "male" ? 45 : voice === "dialogue" ? 50 : 70;
  const level = `highpass=f=${highpass},dynaudnorm=f=200:g=10:p=0.9:m=10,loudnorm=I=-16:TP=-1.2:LRA=8`;
  return `aresample=44100,${level}`;
}

function postprocessTts(raw, output, voice) {
  run(commands.ffmpeg, [
    "-y",
    "-loglevel",
    "error",
    "-i",
    raw,
    "-ar",
    "44100",
    "-ac",
    "2",
    "-af",
    ttsVoiceFilter(voice),
    output
  ]);
  try {
    unlinkSync(raw);
  } catch {
    // Temporary raw TTS files are best-effort cleanup only.
  }
}

function postprocessPcmTts(raw, output, voice, sampleRate = 24000) {
  run(commands.ffmpeg, [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "s16le",
    "-ar",
    String(sampleRate),
    "-ac",
    "1",
    "-i",
    raw,
    "-ar",
    "44100",
    "-ac",
    "2",
    "-af",
    ttsVoiceFilter(voice),
    output
  ]);
  try {
    unlinkSync(raw);
  } catch {
    // Temporary raw TTS files are best-effort cleanup only.
  }
}

function envFirst(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return "";
}

function truncateText(value, max = 900) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

async function fetchJson(url, options = {}, label = "JSON request") {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${truncateText(text, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON response: ${truncateText(text, 500)}`);
  }
}

async function fetchJsonWithTimeout(url, options = {}, label = "JSON request", timeoutMs = 9000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchJson(url, { ...options, signal: controller.signal }, label);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAudio(url, options, label) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${label} failed with HTTP ${response.status}: ${truncateText(text, 500)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function callDeepSeekJson(messages, label) {
  const apiKey = envFirst(["DEEPSEEK_API_KEY", "DEEPSEEK_KEY"]);
  if (!apiKey) {
    throw new Error("Missing DeepSeek API key. Set DEEPSEEK_API_KEY in .env or the process environment.");
  }
  const baseUrl = envFirst(["DEEPSEEK_API_BASE"]) || "https://api.deepseek.com";
  const model = envFirst(["DEEPSEEK_MODEL"]) || "deepseek-chat";
  const payload = {
    model,
    messages,
    temperature: 0.72,
    max_tokens: 20000,
    response_format: { type: "json_object" }
  };
  const data = await fetchJsonWithTimeout(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  }, label, Number(process.env.DEEPSEEK_TIMEOUT_MS || 180000) || 180000);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${label} returned an empty DeepSeek message.`);
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`${label} returned invalid JSON content: ${truncateText(content, 700)}`);
  }
}

function elevenLabsApiKey() {
  const apiKey = envFirst(["ELEVENLABS_API_KEY", "ELEVEN_API_KEY"]);
  if (!apiKey) throw new Error("Missing ElevenLabs API key. Set ELEVENLABS_API_KEY in .env or the process environment.");
  return apiKey;
}

function minimaxApiKey() {
  const apiKey = envFirst(["MINIMAX_API_KEY", "MINIMAX_KEY"]);
  if (!apiKey) throw new Error("Missing MiniMax API key. Set MINIMAX_API_KEY in .env or the process environment.");
  return apiKey;
}

function minimaxEndpoint() {
  const host = (envFirst(["MINIMAX_API_HOST", "MINIMAX_BASE_URL"]) || "https://api.minimax.io").replace(/\/+$/, "");
  const groupId = envFirst(["MINIMAX_GROUP_ID", "MINIMAX_GROUPID"]);
  const url = new URL(`${host}/v1/t2a_v2`);
  if (groupId) url.searchParams.set("GroupId", groupId);
  return url.toString();
}

function resolveMiniMaxVoices() {
  const female = envFirst(["MINIMAX_FEMALE_VOICE_ID", "MINIMAX_EXPERT_VOICE_ID"]) || "female-yujie";
  const male = envFirst(["MINIMAX_MALE_VOICE_ID", "MINIMAX_NEWBIE_VOICE_ID"]) || "male-qn-daxuesheng";
  return { female, male, source: "env" };
}

function volcVoiceApiKey() {
  const apiKey = envFirst(["VOLC_VOICE_API_KEY", "VOLC_PODCAST_API_KEY"]);
  if (!apiKey) throw new Error("Missing Volc Doubao voice API key. Set VOLC_VOICE_API_KEY in .env or the process environment.");
  return apiKey;
}

function normalizeVolcPodcastVoice(value, fallback) {
  const raw = String(value || "").trim();
  const aliases = {
    uranus_bigtts: "zh_male_liufei_v2_saturn_bigtts",
    moon_bigtts: "zh_female_mizai_v2_saturn_bigtts"
  };
  return aliases[raw] || raw || fallback;
}

function resolveVolcPodcastVoices() {
  return {
    female: normalizeVolcPodcastVoice(
      envFirst(["VOLC_PODCAST_FEMALE_VOICE", "VOLC_PODCAST_SPEAKER2"]),
      "zh_female_mizai_v2_saturn_bigtts"
    ),
    male: normalizeVolcPodcastVoice(
      envFirst(["VOLC_PODCAST_MALE_VOICE", "VOLC_PODCAST_SPEAKER1"]),
      "zh_male_liufei_v2_saturn_bigtts"
    ),
    source: "env"
  };
}

function volcPodcastConfig() {
  const apiUrl = envFirst(["VOLC_PODCAST_API_URL"]) || "wss://openspeech.bytedance.com/api/v3/sami/podcasttts";
  const appId = envFirst(["VOLC_PODCAST_APP_ID"]);
  const appKey = envFirst(["VOLC_PODCAST_APP_KEY"]);
  const resourceId = envFirst(["VOLC_PODCAST_RES_ID"]) || "volc.service_type.10050";
  if (!appId) throw new Error("Missing VOLC_PODCAST_APP_ID in .env or the process environment.");
  if (!appKey) throw new Error("Missing VOLC_PODCAST_APP_KEY in .env or the process environment.");
  const voices = resolveVolcPodcastVoices();
  if (voices.female === voices.male) {
    throw new Error(`Volc podcast female and male voices resolve to the same id: ${voices.female}`);
  }
  return {
    apiUrl,
    appId,
    appKey,
    apiKey: volcVoiceApiKey(),
    resourceId,
    authHeader: envFirst(["VOLC_PODCAST_AUTH_HEADER"]) || "X-Api-Key",
    voices,
    speed: Number(envFirst(["TTS_SPEED"]) || 1) || 1
  };
}

function websocketFrame(opcode, payload = Buffer.alloc(0), masked = true) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const lengthBytes = data.length < 126 ? 0 : data.length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + (masked ? 4 : 0));
  header[0] = 0x80 | opcode;
  let offset = 2;
  if (data.length < 126) {
    header[1] = data.length;
  } else if (data.length <= 0xffff) {
    header[1] = 126;
    header.writeUInt16BE(data.length, offset);
    offset += 2;
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), offset);
    offset += 8;
  }
  if (!masked) return Buffer.concat([header, data]);
  header[1] |= 0x80;
  const mask = randomBytes(4);
  mask.copy(header, offset);
  const maskedPayload = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) maskedPayload[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, maskedPayload]);
}

class WebSocketFrameReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < offset + 2) break;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) break;
        length = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      const masked = Boolean(second & 0x80);
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) break;
      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      frames.push({ opcode: first & 0x0f, payload });
      this.buffer = this.buffer.subarray(offset + length);
    }
    return frames;
  }
}

function buildVolcMessage(event, payload, sessionId = "") {
  const body = payload === undefined || payload === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
  const session = Buffer.from(sessionId);
  const parts = [
    Buffer.from([0x11, 0x14, 0x10, 0x00]),
    Buffer.alloc(4)
  ];
  parts[1].writeUInt32BE(event, 0);
  if (session.length) {
    const sessionLength = Buffer.alloc(4);
    sessionLength.writeUInt32BE(session.length, 0);
    parts.push(sessionLength, session);
  }
  const bodyLength = Buffer.alloc(4);
  bodyLength.writeUInt32BE(body.length, 0);
  parts.push(bodyLength, body);
  return Buffer.concat(parts);
}

function parseVolcMessage(payload) {
  if (payload.length < 8) return { messageType: null, event: null, body: Buffer.alloc(0) };
  const headerBytes = (payload[0] & 0x0f) * 4;
  const messageType = payload[1] >> 4;
  const flags = payload[1] & 0x0f;
  const compression = payload[2] & 0x0f;
  let offset = headerBytes;
  let event = null;
  let sessionId = "";
  if (flags & 0x04) {
    event = payload.readUInt32BE(offset);
    offset += 4;
  }
  if (payload.length >= offset + 4) {
    const maybeSessionLength = payload.readUInt32BE(offset);
    const remainingAfterSession = payload.length - offset - 4 - maybeSessionLength;
    if (maybeSessionLength > 0 && remainingAfterSession >= 4 && maybeSessionLength < 512) {
      offset += 4;
      sessionId = payload.subarray(offset, offset + maybeSessionLength).toString();
      offset += maybeSessionLength;
    }
  }
  let body = Buffer.alloc(0);
  if (payload.length >= offset + 4) {
    const bodyLength = payload.readUInt32BE(offset);
    offset += 4;
    if (bodyLength > 0 && payload.length >= offset + bodyLength) {
      body = payload.subarray(offset, offset + bodyLength);
      if (compression === 1) body = gunzipSync(body);
    }
  }
  return { messageType, event, sessionId, body };
}

function parseJsonBody(body) {
  if (!body?.length) return null;
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

function openVolcPodcastSocket(config) {
  return new Promise((resolveSocket, rejectSocket) => {
    const url = new URL(config.apiUrl);
    const key = randomBytes(16).toString("base64");
    const socket = tlsConnect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname });
    const fail = (error) => {
      socket.destroy();
      rejectSocket(error);
    };
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      const path = `${url.pathname}${url.search}`;
      const headers = [
        `GET ${path} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `X-Api-App-Id: ${config.appId}`,
        `X-Api-App-Key: ${config.appKey}`,
        `${config.authHeader}: ${config.apiKey}`,
        `X-Api-Resource-Id: ${config.resourceId}`,
        `X-Api-Request-Id: ${randomUUID()}`,
        "",
        ""
      ].join("\r\n");
      socket.write(headers);
    });
    let handshake = Buffer.alloc(0);
    const onData = (chunk) => {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      socket.off("error", fail);
      const head = handshake.subarray(0, end).toString("utf8");
      if (!head.startsWith("HTTP/1.1 101")) {
        socket.destroy();
        rejectSocket(new Error(`Volc podcast WebSocket handshake failed: ${head.split("\r\n")[0] || "unknown response"}`));
        return;
      }
      resolveSocket({ socket, rest: handshake.subarray(end + 4) });
    };
    socket.on("data", onData);
  });
}

async function synthesizeVolcPodcastTurns(config, turns, label) {
  const sessionId = randomUUID();
  const inputId = randomUUID();
  const nlpTexts = turns.map((turn) => ({
    speaker: config.voices[turn.voice === "male" ? "male" : "female"],
    text: normalizeMandarinTtsText(turn.text)
  })).filter((turn) => turn.text);
  if (!nlpTexts.length) throw new Error(`Volc podcast TTS ${label} has no text.`);
  if (process.env.DEBUG_VOLC_TTS === "1") {
    console.error(JSON.stringify({
      label,
      mode: "volc-podcast-submit",
      turns: nlpTexts.map((turn, index) => ({
        index,
        speaker: turn.speaker,
        chars: turn.text.length,
        englishTokens: englishTokenCount(turn.text),
        text: truncateText(turn.text, 220)
      }))
    }, null, 2));
  }
  const startPayload = {
    action: 3,
    input_id: inputId,
    nlp_texts: nlpTexts,
    use_head_music: false,
    use_tail_music: false,
    speaker_info: {
      random_order: false,
      speakers: [config.voices.female, config.voices.male]
    },
    audio_config: {
      format: "mp3",
      sample_rate: 24000,
      speech_rate: Math.round((config.speed - 1) * 100)
    },
    user: { uid: "music-universe-local" },
    request: { reqid: inputId, operation: "submit", text_type: "plain" }
  };

  const { socket, rest } = await openVolcPodcastSocket(config);
  const reader = new WebSocketFrameReader();
  const chunks = [];
  let settled = false;
  let started = false;
  let endedRounds = 0;
  let idleFinishTimer = null;

  return await new Promise((resolveAudio, rejectAudio) => {
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(idleFinishTimer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.end(websocketFrame(0x8, Buffer.alloc(0)));
      if (!chunks.length) {
        rejectAudio(new Error(`Volc podcast TTS ${label} returned no audio.`));
        return;
      }
      resolveAudio(Buffer.concat(chunks));
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      rejectAudio(error);
    };
    const sendEvent = (event, payload) => {
      socket.write(websocketFrame(0x2, buildVolcMessage(event, payload, sessionId)));
    };
    const scheduleIdleFinish = () => {
      clearTimeout(idleFinishTimer);
      const idleMs = Number(process.env.VOLC_PODCAST_IDLE_FINISH_MS || 9000) || 9000;
      idleFinishTimer = setTimeout(() => {
        if (!settled && chunks.length) finish();
      }, idleMs);
    };
    const onMessage = (frame) => {
      if (frame.opcode === 0x9) {
        socket.write(websocketFrame(0xA, frame.payload));
        return;
      }
      if (frame.opcode === 0x8) {
        if (chunks.length) finish();
        else fail(new Error(`Volc podcast TTS ${label} closed before audio.`));
        return;
      }
      if (frame.opcode !== 0x2) return;
      const message = parseVolcMessage(frame.payload);
      if (message.messageType === 0xF) {
        const detail = parseJsonBody(message.body) || message.body.toString("utf8");
        fail(new Error(`Volc podcast TTS ${label} failed: ${truncateText(JSON.stringify(detail), 700)}`));
        return;
      }
      if (message.messageType === 0xB && message.body.length) {
        if (process.env.DEBUG_VOLC_TTS === "1") {
          const headerBytes = (frame.payload[0] & 0x0f) * 4;
          console.error(JSON.stringify({
            event: message.event,
            frameLength: frame.payload.length,
            headerBytes,
            frameHead: frame.payload.subarray(0, 160).toString("hex"),
            bodyLength: message.body.length,
            bodyHead: message.body.subarray(0, 96).toString("hex")
          }));
        }
        chunks.push(message.body);
        scheduleIdleFinish();
      }
      if (message.event === 50 && !started) {
        started = true;
        sendEvent(100, startPayload);
        return;
      }
      if (message.event === 362) {
        endedRounds += 1;
      }
      if (message.event === 362 && chunks.length && endedRounds >= nlpTexts.length) {
        finish();
        return;
      }
      if (message.event === 154 && chunks.length && nlpTexts.length === 1) {
        finish();
      }
    };
    const onData = (chunk) => {
      for (const frame of reader.push(chunk)) onMessage(frame);
    };
    const onError = (error) => fail(error);
    const onClose = () => {
      if (!settled && chunks.length) finish();
      else if (!settled) fail(new Error(`Volc podcast TTS ${label} connection closed before audio.`));
    };
    const timer = setTimeout(() => fail(new Error(`Volc podcast TTS ${label} timed out.`)), Number(process.env.API_TIMEOUT || 60) * 1000);
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.write(websocketFrame(0x2, buildVolcMessage(1, {})));
    if (rest.length) onData(rest);
  });
}

let elevenLabsVoiceCache = null;
const defaultElevenLabsVoices = {
  female: "21m00Tcm4TlvDq8ikWAM",
  male: "pNInz6obpgDQGcFmaJgB"
};

async function listElevenLabsVoices() {
  if (elevenLabsVoiceCache) return elevenLabsVoiceCache;
  const data = await fetchJson("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": elevenLabsApiKey() }
  }, "ElevenLabs voice list");
  elevenLabsVoiceCache = data.voices || [];
  return elevenLabsVoiceCache;
}

function voiceGender(voice) {
  return String(voice?.labels?.gender || voice?.labels?.Gender || "").toLowerCase();
}

async function resolveElevenLabsVoices() {
  const explicitFemale = envFirst(["ELEVENLABS_FEMALE_VOICE_ID", "ELEVENLABS_EXPERT_VOICE_ID"]);
  const explicitMale = envFirst(["ELEVENLABS_MALE_VOICE_ID", "ELEVENLABS_NEWBIE_VOICE_ID"]);
  if (explicitFemale && explicitMale) return { female: explicitFemale, male: explicitMale, source: "env" };
  if (explicitFemale || explicitMale) {
    return {
      female: explicitFemale || defaultElevenLabsVoices.female,
      male: explicitMale || defaultElevenLabsVoices.male,
      source: "env-with-premade-fallback"
    };
  }

  if (envFirst(["ELEVENLABS_SKIP_VOICE_LIST"]) !== "0") {
    return { ...defaultElevenLabsVoices, source: "premade-fallback" };
  }

  const voices = await listElevenLabsVoices();
  const pickByName = (names) => voices.find((voice) => names.some((name) => String(voice.name || "").toLowerCase() === name));
  const femaleVoice =
    explicitFemale ||
    pickByName(["rachel", "bella", "domi", "elli"])?.voice_id ||
    voices.find((voice) => voiceGender(voice) === "female")?.voice_id ||
    voices[0]?.voice_id;
  const maleVoice =
    explicitMale ||
    pickByName(["antoni", "drew", "josh", "adam"])?.voice_id ||
    voices.find((voice) => voiceGender(voice) === "male")?.voice_id ||
    voices.find((voice) => voice.voice_id !== femaleVoice)?.voice_id ||
    voices[0]?.voice_id;
  if (!femaleVoice || !maleVoice) throw new Error("ElevenLabs has no available voices for this API key.");
  return { female: femaleVoice, male: maleVoice, source: "voices-api" };
}

function fishMaxTokens(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  const chineseChars = [...normalized].length;
  return Math.max(128, Math.min(512, Math.round(chineseChars * 3.4)));
}

function fishPromptText(job) {
  const label = job.voice === "male" ? "男主持" : "女主持";
  const text = String(job.text || "").trim();
  if (!text) return `${label}：`;
  if (text.startsWith(`${label}：`) || text.startsWith(`${label}:`)) return text;
  return `${label}：${text}`;
}

function currentTtsEngine(override) {
  const engine = (override || process.env.TTS_ENGINE || "deepseek-minimax").toLowerCase();
  if (["deepseek-elevenlabs", "deepseek-eleven", "elevenlabs", "eleven"].includes(engine)) {
    if (!envFirst(["DEEPSEEK_API_KEY", "DEEPSEEK_KEY"])) {
      throw new Error("Missing DeepSeek API key. Set DEEPSEEK_API_KEY in .env or the process environment.");
    }
    if (!envFirst(["ELEVENLABS_API_KEY", "ELEVEN_API_KEY"])) {
      throw new Error("Missing ElevenLabs API key. Set ELEVENLABS_API_KEY in .env or the process environment.");
    }
    return "deepseek-elevenlabs";
  }
  if (["deepseek-minimax", "minimax", "minimax-tts"].includes(engine)) {
    if (!envFirst(["DEEPSEEK_API_KEY", "DEEPSEEK_KEY"])) {
      throw new Error("Missing DeepSeek API key. Set DEEPSEEK_API_KEY in .env or the process environment.");
    }
    if (!envFirst(["MINIMAX_API_KEY", "MINIMAX_KEY"])) {
      throw new Error("Missing MiniMax API key. Set MINIMAX_API_KEY in .env or the process environment.");
    }
    return "deepseek-minimax";
  }
  if (["volc-podcast", "doubao", "doubao-podcast", "volc", "volc-tts"].includes(engine)) {
    volcPodcastConfig();
    return "volc-podcast";
  }
  if (engine === "gpt-sovits" || engine === "gptsovits") {
    if (
      existsSync(commands.gptSovitsPython) &&
      existsSync(commands.gptSovitsTts) &&
      existsSync(commands.gptSovitsRoot) &&
      existsSync(commands.gptSovitsGPTModel) &&
      existsSync(commands.gptSovitsModel)
    ) return "gpt-sovits";
    throw new Error("GPT-SoVITS is not ready in this workspace.");
  }
  if (engine === "disabled" || engine === "none") {
    throw new Error("TTS has been reset. Install and configure the next engine, such as GPT-SoVITS, before generating guides.");
  }
  if (engine === "fish") {
    if (existsSync(commands.fishTts) && existsSync(commands.fishCheckpoint)) return engine;
    throw new Error("Fish TTS has been cleared from this workspace.");
  }
  if (engine === "cosyvoice") {
    if (existsSync(commands.cosyTts) && existsSync(commands.cosyModel)) return engine;
    throw new Error("CosyVoice TTS has been cleared from this workspace.");
  }
  throw new Error(`Unsupported TTS_ENGINE=${engine}. Use volc-podcast, deepseek-minimax, gpt-sovits, fish, or cosyvoice.`);
}

function currentTtsSignature(engineOverride) {
  const engine = currentTtsEngine(engineOverride);
  if (engine === "gpt-sovits") {
    return {
      engine,
      model: "GPT-SoVITS v2 pretrained",
      voiceMode: "local-male-female-reference-natural",
      postprocess: TTS_POSTPROCESS_VERSION,
      musicClipEdit: MUSIC_CLIP_EDIT_VERSION
    };
  }
  if (engine === "deepseek-elevenlabs") {
    return {
      engine,
      model: envFirst(["DEEPSEEK_MODEL"]) || "deepseek-chat",
      voiceMode: "female-expert-male-newbie",
      ttsModel: envFirst(["ELEVENLABS_MODEL_ID"]) || "eleven_multilingual_v2",
      postprocess: TTS_POSTPROCESS_VERSION,
      musicClipEdit: MUSIC_CLIP_EDIT_VERSION,
      textNormalization: ELEVENLABS_TEXT_NORMALIZATION_VERSION,
      scriptVersion: DEEPSEEK_GUIDE_VERSION,
      version: DEEPSEEK_ELEVENLABS_VERSION
    };
  }
  if (engine === "deepseek-minimax") {
    const voices = resolveMiniMaxVoices();
    return {
      engine,
      model: envFirst(["DEEPSEEK_MODEL"]) || "deepseek-chat",
      voiceMode: "female-expert-male-newbie",
      ttsModel: envFirst(["MINIMAX_TTS_MODEL"]) || "speech-2.8-hd",
      femaleVoiceId: voices.female,
      maleVoiceId: voices.male,
      postprocess: TTS_POSTPROCESS_VERSION,
      musicClipEdit: MUSIC_CLIP_EDIT_VERSION,
      textNormalization: MINIMAX_TEXT_NORMALIZATION_VERSION,
      scriptVersion: DEEPSEEK_GUIDE_VERSION,
      version: DEEPSEEK_MINIMAX_VERSION
    };
  }
  if (engine === "volc-podcast") {
    const config = volcPodcastConfig();
    const endpoint = new URL(config.apiUrl);
    return {
      engine,
      voiceMode: "doubao-podcast-male-female",
      endpoint: `${endpoint.protocol}//${endpoint.host}${endpoint.pathname}`,
      appId: config.appId,
      resourceId: config.resourceId,
      femaleVoiceId: config.voices.female,
      maleVoiceId: config.voices.male,
      postprocess: TTS_POSTPROCESS_VERSION,
      musicClipEdit: MUSIC_CLIP_EDIT_VERSION,
      textNormalization: VOLC_TEXT_NORMALIZATION_VERSION,
      scriptVersion: DEEPSEEK_GUIDE_VERSION,
      version: VOLC_PODCAST_VERSION
    };
  }
  if (engine === "fish") {
    return {
      engine,
      model: "fishaudio/openaudio-s1-mini",
      voiceMode: "fish-only-female-prompt-male-postprocess",
      musicClipEdit: MUSIC_CLIP_EDIT_VERSION
    };
  }
  return {
    engine,
    model: process.env.COSYVOICE_MODEL || "CosyVoice-300M-SFT",
    voiceMode: "cosyvoice-sft-male-female",
    musicClipEdit: MUSIC_CLIP_EDIT_VERSION
  };
}

function renderCosyVoiceBatch(dir, guideId, jobs) {
  const pending = jobs.filter((job) => !ttsSegmentFresh(job.output, {
    engine: "cosyvoice",
    voice: job.voice,
    text: job.text,
    postprocess: TTS_POSTPROCESS_VERSION
  }));
  if (!pending.length) return;
  const jobFile = join(dir, `${guideId}-cosyvoice-tts-jobs.json`);
  const payload = {
    jobs: pending.map((job) => ({
      index: job.index,
      voice: job.voice,
      text: job.text,
      output: ttsRawPath(dir, guideId, job.index),
      speaker: job.voice === "male" ? "中文男" : "中文女"
    }))
  };
  writeFileSync(jobFile, JSON.stringify(payload, null, 2));
  run(commands.cosyPython, [
    commands.cosyTts,
    "--jobs",
    jobFile,
    "--cosy-root",
    commands.cosyRoot,
    "--model-dir",
    commands.cosyModel
  ], { capture: true });
  for (const job of pending) {
    postprocessTts(ttsRawPath(dir, guideId, job.index), job.output, job.voice);
    writeTtsMeta(job.output, {
      engine: "cosyvoice",
      voice: job.voice,
      text: job.text,
      postprocess: TTS_POSTPROCESS_VERSION
    });
  }
}

async function renderElevenLabsBatch(dir, guideId, jobs) {
  const voices = await resolveElevenLabsVoices();
  const modelId = envFirst(["ELEVENLABS_MODEL_ID"]) || "eleven_multilingual_v2";
  const metaFor = (job) => ({
    engine: "deepseek-elevenlabs",
    voice: job.voice,
    text: job.text,
    voiceId: voices[job.voice === "male" ? "male" : "female"],
    voiceSource: voices.source,
    ttsModel: modelId,
    postprocess: TTS_POSTPROCESS_VERSION,
    textNormalization: ELEVENLABS_TEXT_NORMALIZATION_VERSION,
    version: DEEPSEEK_ELEVENLABS_VERSION
  });
  const pending = jobs.filter((job) => !ttsSegmentFresh(job.output, metaFor(job)));
  if (!pending.length) return;

  const generateChunk = async (job, text, raw) => {
    const voiceId = voices[job.voice === "male" ? "male" : "female"];
    const audio = await fetchAudio(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          accept: "audio/mpeg",
          "content-type": "application/json",
          "xi-api-key": elevenLabsApiKey()
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: {
            stability: job.voice === "female" ? 0.56 : 0.5,
            similarity_boost: 0.74,
            style: 0,
            use_speaker_boost: true
          }
        })
      },
      `ElevenLabs TTS ${guideId}-${job.index}`
    );
    writeFileSync(raw, audio);
  };

  for (const job of pending) {
    const normalizedText = normalizeMandarinTtsText(job.text);
    const chunks = splitTtsText(normalizedText, 82);
    if (chunks.length <= 1) {
      const raw = ttsRawPath(dir, guideId, job.index, "mp3");
      await generateChunk(job, chunks[0] || normalizedText, raw);
      postprocessTts(raw, job.output, job.voice);
    } else {
      const wavParts = [];
      for (const [partIndex, chunk] of chunks.entries()) {
        const raw = join(dir, `${guideId}-${String(job.index).padStart(2, "0")}-tts.part-${partIndex}.raw.mp3`);
        const wav = join(dir, `${guideId}-${String(job.index).padStart(2, "0")}-tts.part-${partIndex}.wav`);
        await generateChunk(job, chunk, raw);
        postprocessTts(raw, wav, job.voice);
        wavParts.push(wav);
      }
      concatFiles(wavParts, job.output);
      for (const wav of wavParts) {
        try {
          unlinkSync(wav);
        } catch {
          // Temporary TTS chunk files are best-effort cleanup only.
        }
      }
    }
    writeTtsMeta(job.output, metaFor(job));
  }
}

async function renderMiniMaxBatch(dir, guideId, jobs) {
  const voices = resolveMiniMaxVoices();
  const modelId = envFirst(["MINIMAX_TTS_MODEL"]) || "speech-2.8-hd";
  const endpoint = minimaxEndpoint();
  const metaFor = (job) => ({
    engine: "deepseek-minimax",
    voice: job.voice,
    text: job.text,
    voiceId: voices[job.voice === "male" ? "male" : "female"],
    voiceSource: voices.source,
    ttsModel: modelId,
    endpoint: endpoint.replace(/\?.*$/, ""),
    postprocess: TTS_POSTPROCESS_VERSION,
    textNormalization: MINIMAX_TEXT_NORMALIZATION_VERSION,
    version: DEEPSEEK_MINIMAX_VERSION
  });
  const pending = jobs.filter((job) => !ttsSegmentFresh(job.output, metaFor(job)));
  if (!pending.length) return;

  for (const job of pending) {
    const text = normalizeMandarinTtsText(job.text);
    const voiceId = voices[job.voice === "male" ? "male" : "female"];
    const data = await fetchJson(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${minimaxApiKey()}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: modelId,
        text,
        stream: false,
        language_boost: "Chinese",
        output_format: "hex",
        voice_setting: {
          voice_id: voiceId,
          speed: 1,
          vol: 1,
          pitch: 0
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: "mp3",
          channel: 1
        }
      })
    }, `MiniMax TTS ${guideId}-${job.index}`);

    const statusCode = Number(data?.base_resp?.status_code || 0);
    if (statusCode !== 0) {
      throw new Error(`MiniMax TTS ${guideId}-${job.index} failed: ${truncateText(data?.base_resp?.status_msg || JSON.stringify(data), 500)}`);
    }
    const hex = data?.data?.audio;
    if (!hex || typeof hex !== "string") {
      throw new Error(`MiniMax TTS ${guideId}-${job.index} returned no audio: ${truncateText(JSON.stringify(data), 500)}`);
    }
    const raw = ttsRawPath(dir, guideId, job.index, "mp3");
    writeFileSync(raw, Buffer.from(hex, "hex"));
    postprocessTts(raw, job.output, job.voice);
    writeTtsMeta(job.output, metaFor(job));
  }
}

async function renderVolcPodcastBatch(dir, guideId, jobs) {
  const config = volcPodcastConfig();
  const metaFor = (job) => ({
    engine: "volc-podcast",
    voice: job.voice,
    text: job.text,
    voiceId: config.voices[job.voice === "male" ? "male" : "female"],
    appId: config.appId,
    resourceId: config.resourceId,
    postprocess: TTS_POSTPROCESS_VERSION,
    textNormalization: VOLC_TEXT_NORMALIZATION_VERSION,
    version: VOLC_PODCAST_VERSION
  });
  const pending = jobs.filter((job) => !ttsSegmentFresh(job.output, metaFor(job)));
  if (!pending.length) return;

  for (const job of pending) {
    const raw = ttsRawPath(dir, guideId, job.index, "mp3");
    const audio = await synthesizeVolcPodcastTurns(config, [job], `${guideId}-${job.index}`);
    writeFileSync(raw, audio);
    postprocessTts(raw, job.output, job.voice);
    writeTtsMeta(job.output, metaFor(job));
  }
}

function volcDialogueBlockPath(dir, guideId, blockIndex) {
  return join(dir, `${guideId}-dialogue-${String(blockIndex).padStart(2, "0")}-tts.wav`);
}

function collectVolcDialogueBlocks(sequence) {
  const blocks = [];
  let current = [];
  let currentChars = 0;
  const maxChars = Number(process.env.VOLC_PODCAST_BLOCK_MAX_CHARS || 260) || 260;
  const maxTurnChars = Number(process.env.VOLC_PODCAST_TURN_MAX_CHARS || 220) || 220;
  const flush = () => {
    if (!current.length) return;
    blocks.push({ blockIndex: blocks.length, turns: current });
    current = [];
    currentChars = 0;
  };
  for (const [index, item] of sequence.entries()) {
    if (item[0] === "tts") {
      const text = String(item[3] || "");
      const parts = splitTtsText(text, maxTurnChars);
      for (const [partIndex, part] of parts.entries()) {
        const chars = part.replace(/\s+/g, "").length;
        if (current.length && currentChars + chars > maxChars) flush();
        current.push({ index, partIndex, voice: item[1], label: item[2], text: part });
        currentChars += chars;
      }
      continue;
    }
    flush();
  }
  flush();
  return blocks;
}

async function renderVolcPodcastGuideBlocks(dir, guideId, sequence) {
  const config = volcPodcastConfig();
  const blocks = collectVolcDialogueBlocks(sequence);
  const filesByIndex = new Map();
  for (const block of blocks) {
    const output = volcDialogueBlockPath(dir, guideId, block.blockIndex);
    const meta = {
      engine: "volc-podcast",
      mode: "dialogue-block",
      guideId,
      blockIndex: block.blockIndex,
      turns: JSON.stringify(block.turns.map((turn) => ({
        index: turn.index,
        voice: turn.voice,
        text: turn.text
      }))),
      femaleVoiceId: config.voices.female,
      maleVoiceId: config.voices.male,
      appId: config.appId,
      resourceId: config.resourceId,
      postprocess: TTS_POSTPROCESS_VERSION,
      textNormalization: VOLC_TEXT_NORMALIZATION_VERSION,
      version: VOLC_PODCAST_VERSION
    };
    if (!ttsSegmentFresh(output, meta)) {
      const raw = join(dir, `${guideId}-dialogue-${String(block.blockIndex).padStart(2, "0")}-tts.raw.mp3`);
      const audio = await synthesizeVolcPodcastTurns(config, block.turns, `${guideId}-dialogue-${block.blockIndex}`);
      writeFileSync(raw, audio);
      postprocessTts(raw, output, "dialogue");
      writeTtsMeta(output, meta);
    }
    const firstIndex = block.turns[0]?.index;
    if (firstIndex !== undefined) {
      const files = filesByIndex.get(firstIndex) || [];
      files.push(output);
      filesByIndex.set(firstIndex, files);
      for (const turn of block.turns.slice(1)) {
        if (!filesByIndex.has(turn.index)) filesByIndex.set(turn.index, null);
      }
    }
  }
  return filesByIndex;
}

function renderGptSovitsBatch(dir, guideId, jobs) {
  const pending = jobs.filter((job) => !ttsSegmentFresh(job.output, {
    engine: "gpt-sovits",
    voice: job.voice,
    text: job.text,
    postprocess: TTS_POSTPROCESS_VERSION
  }));
  if (!pending.length) return;
  const jobFile = join(dir, `${guideId}-gpt-sovits-tts-jobs.json`);
  const payload = {
    refs: {
      male: {
        audio: join(root, "assets", "voice-refs", "male.wav"),
        text: readFileSync(join(root, "assets", "voice-refs", "male.txt"), "utf8").trim()
      },
      female: {
        audio: join(root, "assets", "voice-refs", "female.wav"),
        text: readFileSync(join(root, "assets", "voice-refs", "female.txt"), "utf8").trim()
      }
    },
    jobs: pending.map((job) => ({
      index: job.index,
      voice: job.voice,
      text: job.text,
      output: ttsRawPath(dir, guideId, job.index),
      minSeconds: Math.max(0.8, Math.min(8, job.text.length / 18)),
      retries: 3
    }))
  };
  writeFileSync(jobFile, JSON.stringify(payload, null, 2));
  run(commands.gptSovitsPython, [
    commands.gptSovitsTts,
    "--jobs",
    jobFile,
    "--gpt-sovits-root",
    commands.gptSovitsRoot,
    "--gpt-model",
    commands.gptSovitsGPTModel,
    "--sovits-model",
    commands.gptSovitsModel
  ], { capture: true });
  for (const job of pending) {
    postprocessTts(ttsRawPath(dir, guideId, job.index), job.output, job.voice);
    writeTtsMeta(job.output, {
      engine: "gpt-sovits",
      voice: job.voice,
      text: job.text,
      postprocess: TTS_POSTPROCESS_VERSION
    });
  }
}

function renderFishTtsBatch(dir, guideId, jobs) {
  const pending = jobs.filter((job) => !ttsSegmentFresh(job.output, {
    engine: "fish",
    voice: job.voice,
    text: fishPromptText(job),
    postprocess: TTS_POSTPROCESS_VERSION
  }));
  if (!pending.length) return;
  const jobFile = join(dir, `${guideId}-fish-tts-jobs.json`);
  const payload = {
    refs: {
      female: {
        audio: join(root, "assets", "voice-refs", "female.wav"),
        text: "女主持测试：这是一段开源中文语音，用来确认导听链路。"
      }
    },
    jobs: pending.map((job) => ({
        index: job.index,
        voice: "female",
        text: fishPromptText(job),
        output: job.output,
        maxNewTokens: fishMaxTokens(fishPromptText(job)),
        temperature: 0.8
      }))
  };
  writeFileSync(jobFile, JSON.stringify(payload, null, 2));
  run(commands.fishPython, [
    commands.fishTts,
    "--jobs",
    jobFile,
    "--fish-root",
    commands.fishRoot,
    "--checkpoint",
    commands.fishCheckpoint,
    "--device",
    process.env.FISH_TTS_DEVICE || "mps"
  ], { capture: true });
  for (const job of pending) {
    if (!existsSync(job.output)) {
      throw new Error(`TTS segment was not generated: ${job.output}`);
    }
    const tmp = `${job.output}.norm.wav`;
    run(commands.ffmpeg, [
      "-y",
      "-loglevel",
      "error",
      "-i",
      job.output,
      "-ar",
      "44100",
      "-ac",
      "2",
      "-af",
      ttsVoiceFilter(job.voice),
      tmp
    ]);
    renameSync(tmp, job.output);
    writeTtsMeta(job.output, {
      engine: "fish",
      voice: job.voice,
      text: fishPromptText(job),
      postprocess: TTS_POSTPROCESS_VERSION
    });
  }
}

async function renderTtsBatch(dir, guideId, jobs, engineOverride) {
  const engine = currentTtsEngine(engineOverride);
  if (engine === "deepseek-elevenlabs") {
    await renderElevenLabsBatch(dir, guideId, jobs);
    return;
  }
  if (engine === "deepseek-minimax") {
    await renderMiniMaxBatch(dir, guideId, jobs);
    return;
  }
  if (engine === "volc-podcast") {
    await renderVolcPodcastBatch(dir, guideId, jobs);
    return;
  }
  if (engine === "gpt-sovits") {
    renderGptSovitsBatch(dir, guideId, jobs);
    return;
  }
  if (engine === "fish") {
    renderFishTtsBatch(dir, guideId, jobs);
    return;
  }
  renderCosyVoiceBatch(dir, guideId, jobs);
}

function directYoutubeAudioUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtube.com" || host === "music.youtube.com" || host === "m.youtube.com") {
      return url.searchParams.get("v") ? text : "";
    }
    if (host === "youtu.be") return url.pathname.length > 1 ? text : "";
  } catch {
    return "";
  }
  return "";
}

function clipSegment(dir, guideId, index, clip) {
  const directUrl = directYoutubeAudioUrl(clip.youtube);
  const query = clip.query || `${clip.artist} ${clip.title} official audio`;
  if (clip.sourceFile && /local-test/i.test(String(clip.sourceFile)) && process.env.ALLOW_PLACEHOLDER_AUDIO !== "1") {
    throw new Error("当前片段来源是本地测试占位音源，不允许作为真实乐曲插入。");
  }
  const source = clip.sourceFile && existsSync(clip.sourceFile)
    ? clip.sourceFile
    : downloadAudio(directUrl || `ytsearch1:${query}`, safeId(query));
  const sourceDuration = getDuration(source);
  if (sourceDuration <= MIN_SONG_SOURCE_SECONDS) {
    throw new Error(`Music source is too short (${formatTime(sourceDuration)}). Need more than ${MIN_SONG_SOURCE_SECONDS} seconds.`);
  }
  const clipLength = Math.max(MIN_MUSIC_LISTEN_SECONDS, Number(clip.length || DEFAULT_MUSIC_LISTEN_SECONDS) || DEFAULT_MUSIC_LISTEN_SECONDS);
  const maxStart = Math.max(sourceDuration - clipLength - 1, 0);
  const requestedStart = Number(clip.start || 8) || 8;
  const start = maxStart > 0
    ? (requestedStart > maxStart ? requestedStart % maxStart : Math.max(requestedStart, 0))
    : 0;
  const wav = join(dir, `${guideId}-${String(index).padStart(2, "0")}-clip-${safeId(clip.artist + "-" + clip.title)}.wav`);
  const fadeOutStart = Math.max(clipLength - 0.45, 0.2);
  run(commands.ffmpeg, [
    "-y",
    "-loglevel",
    "error",
    "-ss",
    String(start),
    "-t",
    String(clipLength),
    "-i",
    source,
    "-vn",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-af",
    `afade=t=in:st=0:d=0.18,afade=t=out:st=${fadeOutStart}:d=0.45,loudnorm=I=-16:TP=-1.2:LRA=10`,
    wav
  ]);
  return { wav, source, sourceDuration, start, length: clipLength };
}

function clipIdentity(clip) {
  return normalizeSearchText([
    clip?.artist,
    cleanSongTitleForSpeech(clip?.title)
  ].filter(Boolean).join(" "));
}

function uniqueClipOccurrence(clip, useCounts) {
  const key = clipIdentity(clip);
  if (!key) return clip;
  const count = useCounts.get(key) || 0;
  useCounts.set(key, count + 1);
  const length = Math.max(MIN_MUSIC_LISTEN_SECONDS, Number(clip.length || DEFAULT_MUSIC_LISTEN_SECONDS) || DEFAULT_MUSIC_LISTEN_SECONDS);
  if (count === 0) return { ...clip, length };
  const baseStart = Number(clip.start || 8) || 8;
  const stagger = Math.max(length + 12, 36);
  return {
    ...clip,
    length,
    start: baseStart + count * stagger,
    reason: `${clip.reason || "同一首歌再次出现。"}（这次自动选取同一首歌的另一段，避免重复播放同一个段落。）`
  };
}

function isThemeClip(clip, session) {
  if (!clip || !session?.song) return false;
  if (clip.sourceFile && session.song.sourceFile && clip.sourceFile === session.song.sourceFile) return true;
  return sameClip(clip, session.song);
}

function clipCandidateQueue(clip, session, usedClipKeys) {
  const alternates = Array.isArray(clip?.alternates) ? clip.alternates : [];
  const candidates = dedupeClipCandidates([stripClipAlternates(clip), ...alternates]);
  const nonThemeFresh = candidates.filter((candidate) => {
    const key = clipIdentity(candidate);
    return key && !usedClipKeys.has(key) && !isThemeClip(candidate, session);
  });
  const fresh = candidates.filter((candidate) => {
    const key = clipIdentity(candidate);
    return key && !usedClipKeys.has(key);
  });
  const repeatedNonTheme = candidates.filter((candidate) => !isThemeClip(candidate, session));
  return dedupeClipCandidates([...nonThemeFresh, ...fresh, ...repeatedNonTheme, ...candidates]);
}

function fallbackThemeClip(session, length, failedClip) {
  if (!session.song.sourceFile || !existsSync(session.song.sourceFile)) return null;
  return {
    title: session.song.title,
    artist: session.song.artist,
    sourceFile: session.song.sourceFile,
    start: Math.min(12, Math.max(0, (session.song.duration || 80) * 0.08)),
    length: Math.max(MIN_MUSIC_LISTEN_SECONDS, Number(length || DEFAULT_MUSIC_LISTEN_SECONDS) || DEFAULT_MUSIC_LISTEN_SECONDS),
    youtube: session.song.youtubeUrl,
    reason: `原参考曲 ${clipName(failedClip)} 暂时无法下载，改用入口主题歌片段保持导听结构完整。`,
    nodes: session.song.genres.slice(0, 3),
    edges: []
  };
}

function cachedAudioForClip(clip) {
  const query = clip?.query || `${clip?.artist || ""} ${clip?.title || ""} official audio`;
  const key = safeId(query);
  const existing = readdirSync(sourceDir).find((name) => name.startsWith(`${key}.`));
  return existing ? join(sourceDir, existing) : null;
}

function samplePoolPath(session) {
  return join(runtimeDir, session.id, "sample-pool.json");
}

function readSamplePool(session) {
  const path = samplePoolPath(session);
  if (!existsSync(path)) return null;
  try {
    const pool = JSON.parse(readFileSync(path, "utf8"));
    const items = (pool.items || []).filter((item) => item.sourceFile && existsSync(item.sourceFile));
    return { ...pool, items };
  } catch {
    return null;
  }
}

function samplePoolGenres(session) {
  const route = fissionGenresFor(session.song.genres);
  return [...new Set([...(session.song.genres || []).map(resolveGenreId), ...route])].filter(hasGenre);
}

function samplePoolCandidates(session, limit = 36) {
  const genres = samplePoolGenres(session);
  const base = representativeCandidates(genres.length ? genres : session.song.genres);
  const expanded = [];
  for (let offset = 0; offset < Math.max(base.length, limit); offset += 1) {
    const rep = pickRepresentative(genres.length ? genres : session.song.genres, offset);
    if (rep) expanded.push(stripClipAlternates(rep), ...(rep.alternates || []));
  }
  return dedupeClipCandidates([...base, ...expanded])
    .filter((clip) => !isThemeClip(clip, session))
    .slice(0, limit);
}

function clipRoleScore(clip, guideId, index = 0) {
  const nodes = (clip.nodes || []).map(resolveGenreId);
  const text = normalizeSearchText([clip.artist, clip.title, clip.reason, nodes.join(" ")].join(" "));
  if (guideId === "song") {
    let score = 0;
    if (nodes.some((node) => ["art-pop", "alternative-rock", "britpop", "art-rock", "dream-pop"].includes(node))) score += 8;
    if (/radiohead|art pop|alternative|britpop|dream|post/.test(text)) score += 3;
    return score - index * 0.01;
  }
  if (guideId === "map") {
    let score = 0;
    if (nodes.some((node) => ["dream-pop", "sophisti-pop", "post-grunge", "hard-rock", "shoegaze", "art-rock"].includes(node))) score += 7;
    if (/rock|pop|synth|dream|grunge|hard|shoegaze/.test(text)) score += 4;
    return score - index * 0.01;
  }
  if (guideId === "history") {
    let score = 0;
    if (nodes.some((node) => ["rock", "punk", "grunge", "synthpop", "classic-rock", "new-wave"].includes(node))) score += 7;
    if (/classic|punk|rock|new wave|history|eighties|seventies|anthem/.test(text)) score += 4;
    return score - index * 0.01;
  }
  return -index * 0.01;
}

function buildSamplePool(session, workDir, options = {}) {
  const target = Number(options.target || process.env.SAMPLE_POOL_TARGET || 18) || 18;
  const maxCandidates = Number(options.maxCandidates || process.env.SAMPLE_POOL_MAX_CANDIDATES || 42) || 42;
  const forceFresh = options.forceFresh === true;
  const existingPool = !forceFresh ? readSamplePool(session) : null;
  if (existingPool?.items?.length >= Math.min(target, 9)) return existingPool;

  const items = [];
  const seen = new Set();
  for (const clip of samplePoolCandidates(session, maxCandidates)) {
    const key = clipIdentity(clip);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    try {
      const sourceFile = downloadAudio(directYoutubeAudioUrl(clip.youtube) || `ytsearch1:${clip.query || `${clip.artist} ${clip.title} official audio`}`, safeId(clip.query || `${clip.artist} ${clip.title} official audio`));
      const sourceDuration = getDuration(sourceFile);
      if (sourceDuration <= MIN_SONG_SOURCE_SECONDS) continue;
      items.push({
        ...stripClipAlternates(clip),
        sourceFile,
        sourceDuration,
        length: Math.max(MIN_MUSIC_LISTEN_SECONDS, Number(clip.length || DEFAULT_MUSIC_LISTEN_SECONDS) || DEFAULT_MUSIC_LISTEN_SECONDS),
        poolKey: key
      });
      if (items.length >= target) break;
    } catch (error) {
      console.warn(`Sample pool download failed for ${clip.artist} - ${clip.title}: ${error.message}`);
    }
  }

  const pool = {
    generatedAt: new Date().toISOString(),
    target,
    maxCandidates,
    items
  };
  writeFileSync(samplePoolPath(session), JSON.stringify(pool, null, 2));
  return pool;
}

function pickFromSamplePool(pool, session, guideId, used, slotIndex) {
  const items = (pool?.items || []).filter((item) => item.sourceFile && existsSync(item.sourceFile) && !isThemeClip(item, session));
  const fresh = items.filter((item) => {
    const key = item.poolKey || clipIdentity(item);
    return key && !used.has(key);
  });
  const source = fresh.length ? fresh : items;
  if (!source.length) return null;
  const sorted = [...source].sort((a, b) => clipRoleScore(b, guideId, slotIndex) - clipRoleScore(a, guideId, slotIndex));
  const chosen = sorted[0];
  const key = chosen.poolKey || clipIdentity(chosen);
  const alreadyUsed = key ? [...used].filter((value) => value === key || value.startsWith(`${key}#repeat`)).length : 0;
  if (key) used.add(alreadyUsed ? `${key}#repeat-${guideId}-${slotIndex}` : key);
  return {
    ...stripClipAlternates(chosen),
    start: Number(chosen.start || 8) + (alreadyUsed ? alreadyUsed * 42 : 0),
    reason: `${chosen.reason || ""}${alreadyUsed ? "（采样池可用曲目有限，这里选取同一作品的后续不同段落。）" : ""}`
  };
}

function renderBestClipSegment(workDir, guideId, index, clip, session, clipUseCounts, usedClipKeys) {
  let lastError = null;
  const primary = stripClipAlternates(clip);
  try {
    const renderedClip = uniqueClipOccurrence(primary, clipUseCounts);
    const rendered = clipSegment(workDir, guideId, index, renderedClip);
    const key = clipIdentity(primary);
    if (key && !isThemeClip(primary, session)) usedClipKeys.add(key);
    return { renderedClip, rendered };
  } catch (error) {
    lastError = error;
    console.warn(`Clip failed for ${primary?.artist} - ${primary?.title}: ${error.message}`);
  }

  const queue = clipCandidateQueue(clip, session, usedClipKeys);
  for (const candidate of queue) {
    const key = clipIdentity(candidate);
    const renderedClip = uniqueClipOccurrence(candidate, clipUseCounts);
    try {
      const rendered = clipSegment(workDir, guideId, index, renderedClip);
      if (key) usedClipKeys.add(key);
      return { renderedClip, rendered };
    } catch (error) {
      lastError = error;
      console.warn(`Clip failed for ${candidate.artist} - ${candidate.title}: ${error.message}`);
    }
  }

  const fallback = fallbackThemeClip(session, clip?.length, clip);
  if (!fallback) {
    throw new Error(`鐪熷疄鎻掑叆鏇蹭笅杞藉け璐ワ細${clipName(clip)}銆?{lastError?.message || "No fallback source"}`);
  }
  const renderedClip = uniqueClipOccurrence(fallback, clipUseCounts);
  const rendered = clipSegment(workDir, guideId, index, renderedClip);
  const key = clipIdentity(fallback);
  if (key) usedClipKeys.add(key);
  return { renderedClip, rendered };
}

function chooseGuideClipPlan(guides, session) {
  const used = new Set();
  const expansionGenres = fissionGenresFor(session.song.genres);
  const expansionCandidates = representativeCandidates(expansionGenres.length ? expansionGenres : session.song.genres);
  return guides.map((guide) => {
    let clipNumber = 0;
    const sequence = guide.sequence.map((item) => {
      if (item[0] !== "clip") return item;
      clipNumber += 1;
      const clip = item[1];
      const allowRepeat = clipNumber === 1;
      const candidates = dedupeClipCandidates([
        stripClipAlternates(clip),
        ...(Array.isArray(clip?.alternates) ? clip.alternates : []),
        ...(!allowRepeat ? expansionCandidates : [])
      ]);
      const chosen = allowRepeat
        ? stripClipAlternates(clip)
        : candidates.find((candidate) => {
            const key = clipIdentity(candidate);
            return key && !used.has(key) && !isThemeClip(candidate, session);
          }) || stripClipAlternates(clip);
      const key = clipIdentity(chosen);
      if (key && !allowRepeat) used.add(key);
      return ["clip", chosen];
    });
    return { ...guide, sequence };
  });
}

function ensureDownloadableGuideClipPlan(guides, session, workDir, samplePool = null) {
  const used = new Set();
  const expansionGenres = fissionGenresFor(session.song.genres);
  const expansionCandidates = representativeCandidates(expansionGenres.length ? expansionGenres : session.song.genres);
  return guides.map((guide) => {
    let clipNumber = 0;
    const sequence = guide.sequence.map((item, index) => {
      if (item[0] !== "clip") return item;
      clipNumber += 1;
      const clip = item[1];
      if (clipNumber === 1) return item;
      const pooled = pickFromSamplePool(samplePool, session, guide.id, used, clipNumber);
      if (pooled) return ["clip", pooled];
      const candidates = dedupeClipCandidates([
        ...clipCandidateQueue(clip, session, used),
        ...expansionCandidates
      ]);
      const unusedCached = candidates.filter((candidate) => {
        const key = clipIdentity(candidate);
        return key && !used.has(key) && !isThemeClip(candidate, session) && cachedAudioForClip(candidate);
      });
      const unusedCandidates = candidates.filter((candidate) => {
        const key = clipIdentity(candidate);
        return key && !used.has(key) && !isThemeClip(candidate, session) && !cachedAudioForClip(candidate);
      });
      const repeatCached = candidates
        .filter((candidate) => !isThemeClip(candidate, session) && cachedAudioForClip(candidate))
        .sort((a, b) => {
          const countA = [...used].filter((key) => key.startsWith(`${clipIdentity(a)}#repeat`) || key === clipIdentity(a)).length;
          const countB = [...used].filter((key) => key.startsWith(`${clipIdentity(b)}#repeat`) || key === clipIdentity(b)).length;
          return countA - countB;
        });
      const repeatCandidates = candidates.filter((candidate) => !isThemeClip(candidate, session) && !cachedAudioForClip(candidate));
      const firstPass = repeatCached.length ? unusedCached : unusedCandidates;
      for (const candidate of firstPass) {
        if (isThemeClip(candidate, session)) continue;
        const candidateKey = clipIdentity(candidate);
        if (candidateKey && used.has(candidateKey)) continue;
        try {
          clipSegment(workDir, `${guide.id}-preflight`, index, candidate);
          if (candidateKey) used.add(candidateKey);
          return ["clip", stripClipAlternates(candidate)];
        } catch (error) {
          console.warn(`Preflight clip failed for ${candidate.artist} - ${candidate.title}: ${error.message}`);
        }
      }
      const secondPass = repeatCached.length ? repeatCached : repeatCandidates;
      for (const candidate of secondPass) {
        if (isThemeClip(candidate, session)) continue;
        try {
          clipSegment(workDir, `${guide.id}-preflight-repeat`, index, candidate);
          const key = clipIdentity(candidate);
          const repeatIndex = key ? [...used].filter((value) => value.startsWith(`${key}#repeat`) || value === key).length : clipNumber;
          if (key) used.add(`${key}#repeat-${guide.id}-${clipNumber}`);
          return ["clip", {
            ...stripClipAlternates(candidate),
            start: Number(candidate.start || 8) + Math.max(repeatIndex * 42, 42),
            reason: `${candidate.reason || ""}（当前可下载扩展音源有限，这里选取同一作品的后续不同段落，避免退回主题歌。）`
          }];
        } catch (error) {
          console.warn(`Repeat preflight clip failed for ${candidate.artist} - ${candidate.title}: ${error.message}`);
        }
      }
      console.warn(`No downloadable non-theme expansion clip found for ${guide.id} #${clipNumber}; keeping planned clip.`);
      return item;
    });
    return { ...guide, sequence };
  });
}

function concatFiles(files, output) {
  const list = `${output}.txt`;
  writeFileSync(list, files.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
  run(commands.ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c:a", "pcm_s16le", output]);
}

function mixVoiceOverMusic(dir, guideId, clipIndex, voiceIndex, clipInfo, voiceFiles) {
  const focusSeconds = Number(process.env.MUSIC_FOCUS_SECONDS || 30) || 30;
  const bedVolume = Number(process.env.MUSIC_BED_VOLUME || 0.16) || 0.16;
  const voiceList = join(dir, `${guideId}-${String(clipIndex).padStart(2, "0")}-voice-over-${String(voiceIndex).padStart(2, "0")}.txt`);
  const voiceConcat = join(dir, `${guideId}-${String(clipIndex).padStart(2, "0")}-voice-over-${String(voiceIndex).padStart(2, "0")}.wav`);
  const output = join(dir, `${guideId}-${String(clipIndex).padStart(2, "0")}-musicbed-${String(voiceIndex).padStart(2, "0")}.wav`);
  writeFileSync(voiceList, voiceFiles.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
  run(commands.ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", voiceList, "-c:a", "pcm_s16le", voiceConcat]);
  const voiceDuration = getDuration(voiceConcat);
  const outputDuration = focusSeconds + voiceDuration;
  const source = clipInfo.source || clipInfo.wav;
  const start = Number(clipInfo.start || 0) || 0;
  const needsLoop = clipInfo.sourceDuration && start + outputDuration <= clipInfo.sourceDuration - 0.5 ? false : true;
  const sourceArgs = needsLoop
    ? ["-stream_loop", "-1", "-ss", String(start), "-i", source]
    : ["-ss", String(start), "-i", source];
  run(commands.ffmpeg, [
    "-y",
    "-loglevel",
    "error",
    ...sourceArgs,
    "-i",
    voiceConcat,
    "-filter_complex",
    `[0:a]atrim=0:${outputDuration},asetpts=PTS-STARTPTS,volume='if(lt(t,${focusSeconds}),1,${bedVolume})':eval=frame,afade=t=in:st=0:d=0.2,afade=t=out:st=${Math.max(outputDuration - 0.8, 0.2)}:d=0.8[music];` +
      `[1:a]adelay=${Math.round(focusSeconds * 1000)}|${Math.round(focusSeconds * 1000)},volume=1.15[voice];` +
      `[music][voice]amix=inputs=2:duration=first:dropout_transition=0,loudnorm=I=-16:TP=-1.2:LRA=10[out]`,
    "-map",
    "[out]",
    "-ar",
    "44100",
    "-ac",
    "2",
    output
  ]);
  return { wav: output, duration: getDuration(output), focusSeconds, bedVolume };
}

function legacyPickRepresentative(genres, offset = 0) {
  const choices = genres.flatMap((genre) => {
    const resolved = resolveGenreId(genre);
    const universeRep = representativeFromUniverseGenre(resolved);
    const manualReps = (genreRepresentatives[resolved] || genreRepresentatives[genre] || []).map((item) => ({ genre: resolved, item }));
    return [
      ...(universeRep ? [{ genre: resolved, representative: universeRep }] : []),
      ...manualReps
    ];
  });
  const choice = choices[offset % Math.max(choices.length, 1)];
  if (!choice) return null;
  if (choice.representative) return choice.representative;
  const [artist, title, query, start] = choice.item;
  return {
    title,
    artist,
    query,
    start,
    length: DEFAULT_MUSIC_LISTEN_SECONDS,
    youtube: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    reason: `用 ${clipName({ artist, title })} 展示 ${choice.genre} 节点的代表声音。`,
    nodes: [choice.genre, ...neighborGenres(choice.genre).slice(0, 2)],
    edges: []
  };
}

function stripClipAlternates(clip) {
  if (!clip) return null;
  const { alternates, ...rest } = clip;
  return rest;
}

function clipCandidateIdentity(clip) {
  return normalizeSearchText([
    clip?.artist,
    cleanSongTitleForSpeech(clip?.title)
  ].filter(Boolean).join(" "));
}

function dedupeClipCandidates(candidates) {
  const seen = new Set();
  const unique = [];
  for (const clip of candidates.filter(Boolean)) {
    const key = clipCandidateIdentity(clip);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(stripClipAlternates(clip));
  }
  return unique;
}

function representativeFromManualChoice(choice) {
  const [artist, title, query, start] = choice.item;
  return {
    title,
    artist,
    query,
    start,
    length: DEFAULT_MUSIC_LISTEN_SECONDS,
    youtube: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    reason: `由 ${clipName({ artist, title })} 展示 ${choice.genre} 节点的代表声音。`,
    nodes: [choice.genre, ...neighborGenres(choice.genre).slice(0, 2)],
    edges: []
  };
}

function representativeCandidates(genres) {
  const choices = genres.flatMap((genre) => {
    const resolved = resolveGenreId(genre);
    const universeRep = representativeFromUniverseGenre(resolved);
    const manualReps = (genreRepresentatives[resolved] || genreRepresentatives[genre] || []).map((item) => ({ genre: resolved, item }));
    return [
      ...(universeRep ? [{ genre: resolved, representative: universeRep }] : []),
      ...manualReps
    ];
  });
  return dedupeClipCandidates(choices.map((choice) => choice.representative || representativeFromManualChoice(choice)));
}

function withClipAlternates(clip, candidates, offset = 0) {
  if (!clip) return null;
  const primaryKey = clipCandidateIdentity(clip);
  const alternates = [];
  for (let cursor = 1; cursor < candidates.length; cursor += 1) {
    const candidate = candidates[(offset + cursor) % candidates.length];
    if (!candidate || clipCandidateIdentity(candidate) === primaryKey) continue;
    alternates.push(stripClipAlternates(candidate));
  }
  return { ...stripClipAlternates(clip), alternates: alternates.slice(0, 10) };
}

function pickRepresentative(genres, offset = 0) {
  const choices = representativeCandidates(genres);
  const choice = choices[offset % Math.max(choices.length, 1)];
  return choice ? withClipAlternates(choice, choices, offset) : null;
}

const genreLabels = {
  funk: "放克",
  soul: "灵魂乐",
  rnb: "节奏布鲁斯",
  rock: "摇滚",
  disco: "迪斯科",
  house: "浩室",
  electronic: "电子乐",
  techno: "科技舞曲",
  hiphop: "嘻哈",
  jazz: "爵士",
  blues: "布鲁斯",
  punk: "朋克",
  metal: "金属",
  reggae: "雷鬼",
  latin: "拉丁",
  afrobeat: "非洲节拍",
  ambient: "氛围",
  synthpop: "合成器流行",
  country: "乡村",
  folk: "民谣",
  gospel: "福音",
  classical: "古典",
  trap: "陷阱说唱",
  grunge: "垃圾摇滚",
  cpop: "华语流行",
  "c-pop": "华语流行",
  mandopop: "国语流行",
  "classic-mandopop": "经典国语流行",
  "mainland-chinese-pop": "大陆华语流行",
  "taiwan-pop": "台湾流行",
  cantopop: "粤语流行",
  "classic-cantopop": "经典粤语流行",
  "hong-kong-indie": "香港独立",
  "hong-kong-rock": "香港摇滚",
  artpop: "艺术流行",
  "art-pop": "艺术流行",
  "dream-pop": "梦幻流行",
  "sophisti-pop": "精致流行",
  popballad: "抒情流行"
};

function genreName(id) {
  const resolved = resolveGenreId(id);
  const universe = loadUniverseGenres();
  return genreLabels[resolved] || genreLabels[id] || universe.byId.get(resolved)?.name || resolved || id;
}

function genreRoute(genres) {
  return genres.map(genreName).join("、");
}

function cleanSongTitleForSpeech(title) {
  return String(title || "")
    .replace(/\[[^\]]*]/g, " ")
    .replace(/【[^】]*】/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/（[^）]*）/g, " ")
    .replace(/\b(?:official|audio|video|lyrics?|hd|hq|mv|m\/v|music video|visualizer)\b/gi, " ")
    .replace(/\s+-\s+(?:official|audio|video|lyrics?|hd|hq|mv|m\/v|music video|visualizer).*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function songName(song) {
  return `${song.artist} 的《${cleanSongTitleForSpeech(song.title)}》`;
}

function clipName(clip) {
  return clip ? `${clip.artist} 的《${cleanSongTitleForSpeech(clip.title)}》` : "入口歌曲片段";
}

function fissionGenresFor(genres) {
  const route = [];
  for (const genre of genres || []) {
    const resolved = resolveGenreId(genre);
    if (hasGenre(resolved)) route.push(resolved);
    for (const neighbor of neighborGenres(resolved).slice(0, 3)) {
      if (hasGenre(neighbor)) route.push(neighbor);
    }
  }
  return [...new Set(route)].slice(0, 14);
}

function primaryClipGenre(clip) {
  return (clip?.nodes || []).find((genre) => hasGenre(genre)) || null;
}

function fissionRepresentative(song, offset = 0) {
  const route = fissionGenresFor(song.genres);
  const clip = pickRepresentative(route.length ? route : song.genres, offset);
  if (!clip) return null;
  const targetGenre = primaryClipGenre(clip);
  return {
    ...clip,
    length: Math.max(MIN_MUSIC_LISTEN_SECONDS, Number(clip.length || 0)),
    reason: `从 ${songName(song)} 的 ${genreRoute(song.genres.slice(0, 3))} 裂变到近邻「${genreName(targetGenre || song.genres[0])}」：选择 ${clipName(clip)} 不是随机跳歌，而是为了比较两首歌在节奏骨架、音色重心、旋律钩子或听众场景上的可追踪关联。`
  };
}

function criticalProfile(song) {
  const key = `${song.artist} ${song.title}`.toLowerCase();
  if (/daft punk/.test(key) && /one more time/.test(key)) {
    return {
      hook: "它把 Eddie Johns 的灵魂乐采样处理成一台会发光的循环机器：不是用复杂和弦取胜，而是让短句、滤波和重拍一点点把人推上舞池。",
      production:
        "这首歌最值得细听的是滤波器的开合、低频四拍的稳定推进，以及人声被声码器包起来以后形成的半人半机器质感。它让怀旧迪斯科的颗粒感和未来派电子音色同时成立。",
      critique:
        "它的锋利之处在于克制。旋律信息并不多，但混音层次让每次重复都像灯光换了角度：贝斯托住身体，采样托住记忆，机械人声托住狂喜。",
      history:
        "放回世纪之交的语境，它不是单纯的复古舞曲，而是 French touch 把俱乐部、采样文化、家庭录音室和流行电台重新焊在一起的代表时刻。"
    };
  }

  if (/stevie wonder/.test(key)) {
    return {
      hook: "这首歌的入口不是炫技，而是把旋律、和声和律动揉成一种会自己呼吸的叙事。",
      production:
        "可以重点听键盘音色、贝斯线和鼓的对话：它们不是背景伴奏，而像几个人在同一张桌上互相接话。",
      critique:
        "它的高级感来自弹性。节奏一直往前走，但人声常常把句尾轻轻往后拖，于是情绪既稳又活。",
      history:
        "放在七十年代灵魂乐和放克的发展里，它体现的是唱作人、录音室技术和社会叙事互相靠近的黄金时刻。"
    };
  }

  if (/faye wong|王菲/.test(key) && /red bean|紅豆|红豆/.test(key)) {
    return {
      hook:
        "它的强处不是大起大落，而是把极轻的旋律、克制的编曲和林夕式的时间感压在一起：听上去像情歌，真正讲的是人怎样在不确定的关系里练习告别和等待。",
      production:
        "这首歌最值得细听的是留白。鼓和低频不抢戏，和声铺得很薄，人声被放在近处，却没有夸张的哭腔；这种克制让每个尾音、换气和字尾都像被单独照亮。",
      critique:
        "它不是靠副歌爆发制造记忆，而是靠旋律的缓慢回旋和词句的反复，把“有时候”变成一种心理动作。越不煽情，越让听众把自己的经历投进去。",
      history:
        "放回九十年代末的华语流行语境，它连接了港台流行工业、卡拉 OK 传播、女性声线审美和都市情感叙事：不是舞台上巨大的宣告，而是私人情绪被公共传唱接住的时刻。"
    };
  }

  if (/nirvana/.test(key)) {
    return {
      hook: "这首歌的冲击力来自极端动态：安静段落把焦虑压低，失真吉他一进来，情绪像被直接推到墙上。",
      production:
        "鼓、贝斯和吉他的关系很粗粝，但并不松散。它故意保留毛边，让青少年式的疲惫和愤怒不被修得太漂亮。",
      critique:
        "真正有意思的是它一边反流行，一边又拥有非常强的副歌记忆点；这种矛盾让它能进入主流，却不完全被主流驯服。",
      history:
        "放回九十年代初的摇滚产业，它是地下吉他噪音和 MTV 时代大众传播撞在一起的节点。"
    };
  }

  return {
    hook: `它的核心不只是“像 ${genreName(song.genres[0])}”，而是把 ${genreRoute(song.genres.slice(0, 3))} 的若干语法压进一首可被记住的歌里。`,
    production:
      "细听时可以先抓三件事：节拍怎样分配身体重心，低频怎样托住段落，主旋律或人声怎样把重复变成记忆点。",
    critique:
      "好的流派歌曲不靠标签说服人，而靠每一处取舍让标签变得有声音。这里值得听的，就是它在熟悉语汇里保留了哪些个性。",
    history:
      `把它放回 ${genreRoute(song.genres.slice(0, 4))} 的网络里，它更像一个交叉路口：一边继承旧的律动，一边把制作、传播和听众习惯推向新的场景。`
  };
}

function buildGuides(song) {
  const g = song.genres;
  const rep0 = pickRepresentative(g, 0);
  const rep1 = pickRepresentative(g, 1);
  const rep2 = pickRepresentative(g, 2);
  const rep3 = pickRepresentative(g, 3);
  const rep4 = pickRepresentative(g, 4);
  const rep5 = pickRepresentative(g, 5);
  const fiss0 = fissionRepresentative(song, 0);
  const fiss1 = fissionRepresentative(song, 1);
  const fiss2 = fissionRepresentative(song, 2);
  const fiss3 = fissionRepresentative(song, 3);
  const profile = criticalProfile(song);
  const selectedClip = (reason, length = DEFAULT_MUSIC_LISTEN_SECONDS) => ({
    title: song.title,
    artist: song.artist,
    sourceFile: song.sourceFile,
    start: Math.min(12, Math.max(0, (song.duration || 80) * 0.08)),
    length: Math.max(MIN_MUSIC_LISTEN_SECONDS, Number(length || DEFAULT_MUSIC_LISTEN_SECONDS) || DEFAULT_MUSIC_LISTEN_SECONDS),
    youtube: song.youtubeUrl,
    reason,
    nodes: g.slice(0, 3),
    edges: []
  });

  return [
    {
      id: "song",
      title: "导听 1：主题歌深度乐评",
      outline: `先向听众打招呼并介绍 ${songName(song)}，再深挖艺人、歌曲、专辑语境、职业生涯位置和风格定位。`,
      script: `先完成稿件，再用开源 TTS 生成男女双主持口播，最后插入入口歌与相邻金曲片段。`,
      sequence: [
        ["clip", selectedClip(`深夜电台开场前奏：先让主题歌自己建立本期节目的气味和空间。`)],
        ["tts", "female", "女主持", `这一段我们只盯住一件事：${songName(song)} 为什么值得被放进音乐宇宙的中心来听。它在地图上暂时点亮 ${genreRoute(g.slice(0, 4))}，但标签只是入口，真正重要的是声音如何组织情绪、身体和记忆。`],
        ["tts", "male", "男主持", `${profile.hook} 所以我不会先问它“属于什么流派”，而会先问：它怎样让听众在前十几秒就明白自己该跟着什么走，是鼓点、低频、人声，还是一个被反复擦亮的短句。`],
        ["clip", selectedClip(`入口主题歌片段：先让听众确认本次导听分析的对象。`, 18)],
        ["tts", "female", "女主持", `${profile.production} 你可以把耳朵分成三层：最下面听低频是不是稳定，中央听鼓和贝斯有没有互相咬合，最上面听人声或旋律有没有留出空气。很多歌听起来热闹，其实层次糊在一起；这首歌成立，是因为每一层都知道自己要承担什么。`],
        ["tts", "male", "男主持", `${profile.critique} 这里的重复并不等于偷懒。重复是一种结构手段，它让听众有时间进入声音内部，感到细节在微微变化。强的流行音乐往往不是一直给新东西，而是让同一个材料在不同光线下出现。`],
        ["clip", rep0],
        ["tts", "female", "女主持", `拿 ${clipName(rep0)} 做参照，是为了把 ${songName(song)} 的重心听得更清楚。相邻金曲不是随便塞进来热场，它像一块对照板：如果两首歌都让身体先动起来，我们就比较它们的律动密度；如果它们都靠音色取胜，我们就比较哪些频段在说话。`],
        ["clip", rep1 || selectedClip(`再次回到入口歌曲，确认它和相邻节点之间的声音联系。`, 17)],
        ["tts", "male", "男主持", `到这里，主题歌已经不是孤立作品了。它像一个坐标：横轴是 ${genreRoute(g.slice(0, 2))} 的律动和制作，纵轴是歌曲自身的情绪弧线。真正的深听，是把“我喜欢这个副歌”继续追问下去：为什么这个副歌被安排在这里，为什么它的音色是这个亮度，为什么它没有再多一步。`],
        ["clip", selectedClip(`回到主题歌，用收束片段让听众重新校准本曲的钩子和质感。`, 18)],
        ["tts", "female", "女主持", `所以这一首歌的价值，不只是它好听，而是它把一套风格语言变成了可以被大众立即识别的情绪装置。接下来再听它，你可以少看歌名，多听声音怎样把人带进场景：先给身体一个支点，再给记忆一个亮点，最后让流派地图在耳朵里亮起来。`]
      ].filter((item) => item[0] !== "clip" || item[1])
    },
    {
      id: "map",
      title: "导听 2：风格谱系与金曲路线",
      outline: `从 ${songName(song)} 向 ${genreRoute(g.slice(0, 4))} 扩散，用金曲片段听出上游、近邻和下游。`,
      script: `用入口歌和代表金曲建立可听见的路线，而不是只给流派百科。`,
      sequence: [
        ["clip", selectedClip(`深夜电台开场前奏：用主题歌先建立本轮流派路线的出发点。`)],
        ["tts", "female", "女主持", `第二段我们把镜头拉远。${songName(song)} 在地图上不是一个孤点，而是一条路线的临时入口。它旁边亮起来的关键词是 ${genreRoute(g.slice(0, 4))}，但这些词要靠声音来证明：节奏怎样走，低频怎样站，音色怎样把年代感和空间感带出来。`],
        ["tts", "male", "男主持", `先听近邻。所谓近邻，不是“听起来差不多”的歌，而是解决了相似问题的歌。比如怎样把循环做得不腻，怎样让鼓组既服务舞池又服务歌曲，怎样让一个短小的动机在三四分钟里持续有效。`],
        ["clip", fiss0 || rep2 || selectedClip(`入口歌曲的相邻声音片段。`, 18)],
        ["tts", "female", "女主持", `${clipName(fiss0 || rep2 || rep0)} 可以帮助我们听 ${genreName(g[0])} 这一侧的骨架：它通常先让身体找到稳定脉冲，再让旋律或人声在上面制造个性。你会发现，风格不是装饰，而是一套安排注意力的方法。`],
        ["tts", "male", "男主持", `再往旁边走，${genreName(g[1] || g[0])} 提供的是另一种重心。它可能更重视和声的温度，也可能更重视音色的机械感。把两首金曲连起来听，地图就不只是平面的点位，而会变成一段可以比较的听觉斜坡。`],
        ["clip", fiss1 || rep3 || rep0],
        ["tts", "female", "女主持", `这里最有意思的，是主题歌和代表曲之间的差异。相似让我们找到家族关系，差异才让我们听见作品性格。${songName(song)} 如果更强调钩子，它就会把流派压缩成一个可唱的符号；如果更强调质感，它就会让制作本身成为主角。`],
        ["clip", fiss2 || rep4 || rep1 || selectedClip(`用入口歌曲补足地图路径。`, 18)],
        ["tts", "male", "男主持", `所以这条路线可以这样听：从 ${songName(song)} 出发，先经过 ${genreName(g[0])} 的节奏骨架，再碰到 ${genreName(g[1] || g[0])} 的情绪语法，随后向 ${genreName(g[2] || g[0])} 的制作观念扩散。每一步都不是分类游戏，而是在问：声音把身体、记忆和时代感分别交给了哪一层。`],
        ["clip", fiss3 || rep5 || selectedClip(`继续裂变到一个相近但不完全相同的声音，强调路线不是随机跳歌。`, 18)],
        ["tts", "male", "男主持", `所以这条裂变路线不是随机歌单，而是每一次跳转都要说得出理由？如果我重新回到入口歌，是不是应该能听到它继承了什么，也删掉了什么？`],
        ["tts", "female", "女主持", `这样再回到入口歌，它会变得更立体。你会听到它继承了什么，也会听到它删掉了什么。真正好的风格导听，不是把歌塞进抽屉，而是把抽屉打开，让你看到里面有采样、录音室、舞池、电台、城市和听众习惯共同组成的线路。`]
      ].filter((item) => item[0] !== "clip" || item[1])
    },
    {
      id: "history",
      title: "导听 3：人文历史与听众现场",
      outline: `把 ${songName(song)} 放回技术、传播、舞厅、电台和听众共同塑造的历史现场。`,
      script: `讲清楚为什么这类声音会在特定时代出现，并用金曲片段标出迁移路径。`,
      sequence: [
        ["clip", selectedClip(`深夜电台开场前奏：先让主题歌铺出本轮文化史讨论的夜色和情绪底色。`)],
        ["tts", "female", "女主持", `第三段，我们把 ${songName(song)} 放回历史现场。流行音乐从来不是只在录音棚里发生，它还发生在舞厅、耳机、电台、榜单、俱乐部音响、短视频以前的电视屏幕，以及每一次听众决定“再放一遍”的瞬间。`],
        ["tts", "male", "男主持", `${profile.history} 这类歌能够被听见，往往需要几个条件同时成熟：可用的录音技术，足够清晰的传播渠道，一批愿意重复播放它的 DJ 或听众，以及一个能接受这种声音的时代情绪。`],
        ["clip", selectedClip(`入口歌曲历史语境片段：听它怎样把技术和情绪合在一起。`, 18)],
        ["tts", "female", "女主持", `如果我们只说“这是 ${genreName(g[0])}”，其实会漏掉一半。更准确的问法是：为什么这种鼓、这种低频、这种人声处理、这种段落长度，会在这个场景里显得合理。历史不是背景墙，历史会直接改变一首歌应该有多亮、多紧、多重复，甚至多长。`],
        ["tts", "male", "男主持", `相邻金曲在这里的作用，是把迁移路线听出来。某些声音从黑人音乐传统、迪斯科舞池、摇滚地下现场或电子制作社区里走出来，进入更大的大众市场；它每进入一层新空间，就会损失一点边缘性，也会获得新的传播力量。`],
        ["clip", rep5 || rep2 || rep0],
        ["tts", "female", "女主持", `当 ${clipName(rep5 || rep2 || rep0)} 出现时，你可以听它和主题歌之间共享的部分：可能是律动的耐心，可能是合成器的质地，可能是让人群一起进入同一拍点的设计。音乐史不是一条直线，更像许多房间之间开了门。`],
        ["clip", rep1 || selectedClip(`以入口歌曲收尾，保留当前 session 路径。`, 17)],
        ["tts", "male", "男主持", `还有一个不能忽略的层面，是听众现场。很多金曲之所以成为金曲，不是因为它们信息量最大，而是因为它们能在公共空间里快速建立共同感。它们让陌生人共享一个节拍，让私人情绪找到外部形状，这也是流行音乐最强的社会功能。`],
        ["tts", "female", "女主持", `所以这一段的结论是：${songName(song)} 不只是一首被搜索到的歌，它是某种技术、风格和听众关系交汇后的结果。你继续在音乐宇宙里深挖 ${genreName(g[0])}，会听到更多亲戚；你横跳到 ${genreName(g[1] || g[0])} 或 ${genreName(g[2] || g[0])}，会听到它如何改变形状。地图的意义，就是把这些看不见的关系变成可以被耳朵确认的路线。`]
      ].filter((item) => item[0] !== "clip" || item[1])
    }
  ];
}

function decodeBasicHtmlEntities(text) {
  return String(text || "")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanResearchText(text, max = 900) {
  return truncateText(
    decodeBasicHtmlEntities(text)
      .replace(/<[^>]+>/g, " ")
      .replace(/\[[^\]]+\]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
    max
  );
}

async function wikipediaQuery(params, label) {
  const url = new URL(wikipediaApiUrl);
  Object.entries({ format: "json", origin: "*", ...params }).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  return fetchJsonWithTimeout(url, {
    headers: {
      accept: "application/json",
      "user-agent": musicBrainzUserAgent
    }
  }, label, 8000);
}

async function wikipediaTopic(query, kind) {
  const search = await wikipediaQuery({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: 1
  }, `Wikipedia search: ${query}`);
  const hit = search.query?.search?.[0];
  if (!hit?.title) return null;

  const extractData = await wikipediaQuery({
    action: "query",
    prop: "extracts",
    exintro: 1,
    explaintext: 1,
    redirects: 1,
    titles: hit.title
  }, `Wikipedia extract: ${hit.title}`);
  const page = Object.values(extractData.query?.pages || {})[0] || {};
  const extract = cleanResearchText(page.extract || hit.snippet, 1200);
  if (!extract) return null;
  return {
    kind,
    query,
    title: page.title || hit.title,
    extract
  };
}

function researchQueriesForSession(session) {
  const song = session.song;
  const genres = (song.genres || []).slice(0, 4);
  const queries = [
    { kind: "artist", query: `${song.artist} musician`, intent: "artist career, scene position, influence" },
    { kind: "song", query: `${song.artist} ${song.title} song`, intent: "song, album, release context" },
    ...genres.map((genre) => ({
      kind: "genre",
      query: `${genreName(genre)} music genre history`,
      genre,
      intent: "genre origins, people, city, cultural background"
    }))
  ];
  const seen = new Set();
  return queries.filter((item) => {
    const key = normalizeSearchText(item.query);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

async function loadPublicResearchContext(session, sessionDir) {
  const cachePath = join(sessionDir, "public-research-v1.json");
  if (existsSync(cachePath)) {
    try {
      return JSON.parse(readFileSync(cachePath, "utf8"));
    } catch {
      // Ignore malformed cache and rebuild below.
    }
  }
  const cacheKey = `${session.song.artist} ${session.song.title} ${(session.song.genres || []).join(" ")}`;
  if (publicResearchCache.has(cacheKey)) return publicResearchCache.get(cacheKey);

  const topics = [];
  const warnings = [];
  for (const topic of researchQueriesForSession(session)) {
    try {
      const result = await wikipediaTopic(topic.query, topic.kind);
      if (result) topics.push({ ...topic, ...result });
    } catch (error) {
      warnings.push(`${topic.query}: ${error.message}`);
    }
  }

  const context = {
    source: "Wikipedia public summaries + MusicBrainz/YouTube metadata",
    fetchedAt: new Date().toISOString(),
    topics,
    warnings: warnings.slice(0, 4)
  };
  publicResearchCache.set(cacheKey, context);
  try {
    writeFileSync(cachePath, JSON.stringify(context, null, 2));
  } catch {
    // Research cache is optional; generation can continue without it.
  }
  return context;
}

function compactSongForPrompt(session) {
  const { song, info } = session;
  return {
    title: cleanSongTitleForSpeech(song.title),
    rawTitle: song.title,
    artist: song.artist,
    year: song.year,
    youtubeUrl: song.youtubeUrl,
    duration: song.duration,
    genres: song.genres,
    genreRoute: genreRoute(song.genres.slice(0, 4)),
    summary: song.summary,
    musicBrainz: session.genreResult?.musicBrainz || null,
    youtubeMetadata: info ? {
      title: info.title,
      track: info.track,
      artist: info.artist || info.creator || info.uploader,
      uploader: info.uploader || info.channel,
      release_year: info.release_year,
      upload_date: info.upload_date,
      tags: (info.tags || []).slice(0, 24),
      categories: (info.categories || []).slice(0, 8),
      description: truncateText(info.description, 1200)
    } : null
  };
}

function guideBlueprint(guide) {
  let ttsNumber = 0;
  let clipNumber = 0;
  let previousClip = null;
  return {
    id: guide.id,
    title: guide.title,
    outline: guide.outline,
    styleMethod: guideStyleMethod(guide.id),
    requirements: guideRequirements(guide.id),
    target: "约 5 分钟的连环乐评播客；会穿插约 30 秒音乐采样；女生是资深专家，男生是小白听众；必须像两个人真的在对话，轻松但信息扎实，不能像念稿。",
    slots: guide.sequence.map((item, index) => {
      if (item[0] === "clip") {
        clipNumber += 1;
        const clip = item[1];
        previousClip = clip;
        return {
          type: "clip",
          index: clipNumber,
          artist: clip.artist,
          title: cleanSongTitleForSpeech(clip.title),
          reason: clip.reason,
          length: clip.length
        };
      }
      ttsNumber += 1;
      const nextClip = guide.sequence[index + 1]?.[0] === "clip" ? guide.sequence[index + 1][1] : null;
      const previousClipForSlot = previousClip;
      return {
        type: "tts",
        index: ttsNumber,
        voice: item[1],
        persona: item[1] === "female" ? "女生专家" : "男生小白",
        conversationTask: item[1] === "female"
          ? "像资深女专家一样解释上一句问题或铺垫下一段音乐片段；要有判断和听感细节，但必须口语化。"
          : "像男生小白一样接住上一句，提出一个真实听众会问的问题；必须包含问号。",
        slotGoal: guideSlotGoal(guide.id, ttsNumber, item[1]),
        previousClip: previousClipForSlot ? { artist: previousClipForSlot.artist, title: cleanSongTitleForSpeech(previousClipForSlot.title) } : null,
        upcomingClip: nextClip ? { artist: nextClip.artist, title: cleanSongTitleForSpeech(nextClip.title) } : null,
        announcementRule: nextClip
          ? `本段之后音乐会自然浮上来，素材来自 ${clipName(nextClip)}。本段要像电台导听一样自然铺垫这首歌，明确说出歌名，并给出 1-2 个听点；不要说“插入”“采样”“播放片段”这类机械报幕词。`
          : previousClipForSlot
            ? `本段前面刚播放了 ${clipName(previousClipForSlot)}。本段必须先回应刚才这个片段的听感，再继续推进对话；不要误说成其他歌曲。`
            : "本段前后都没有立刻相邻的音乐片段，不要说“现在放”“接下来听”“马上听”等报歌句。"
      };
    })
  };
}

function guideStyleMethod(guideId) {
  const methods = {
    song: {
      label: "HOPICO-style station review method",
      principle: "学习 HOPICO 的展开方式：像推荐一首新作一样站台，但每个判断都要落到具体声音证据和艺人脉络。",
      moves: [
        "先给明确推荐判断：这首歌为什么值得现在被听。",
        "从艺人、专辑或发行语境切入，讲它在这个音乐人作品序列里的位置。",
        "把声音拆成可听见的细节：低频、鼓、贝斯线、人声、采样、和声、合成器、空间感或编曲取舍。",
        "可以横向提到艺人的其他歌、合作对象、相近制作人或历史参照，但每个参照都要服务主题歌。",
        "允许有鲜活比喻，但不要堆形容词；比喻后必须回到声音本身。"
      ]
    },
    map: {
      label: "Juxiangbo concept frame + HOPICO station hopping",
      principle: "第二段同时学习具象波的概念框架和 HOPICO 的站台式跳转：先建立一个可理解的风格问题，再一站一站用参照曲证明。",
      moves: [
        "先把本段要解决的风格问题说清楚，例如节奏骨架、舞池功能、制作审美、听众场景或流派迁移。",
        "每次裂变都像 HOPICO 推荐下一站：说清为什么选这首歌、它听哪里、它和上一首/主题歌共享什么问题。",
        "同时像具象波一样做概念解释：告诉小乐迷这个流派词背后代表什么生产方式、听众场景或审美立场。",
        "相似性和差异性都要讲：不是因为同类才放，而是因为它能把主题歌的一个侧面照出来。",
        "每一站结束时都要把路线往下一站推进，不要变成孤立歌单。"
      ]
    },
    history: {
      label: "Juxiangbo concept-history method",
      principle: "第三段学习具象波的概念史写法：从一个声音现象出发，挖到技术、城市、人群、商业、媒介和听众位置。",
      moves: [
        "先提出一个概念问题：这种声音为什么会在某个时代/场景里出现。",
        "解释来源和成因：技术条件、录音设备、舞厅/地下/电台/平台、城市空间、人群身份或跨地域传播。",
        "把风格当成社会关系，而不只是标签；可以谈商业机制、主流/地下、中心/边缘、听众过滤或身份表达。",
        "每个历史判断都要落回耳朵：这些背景如何变成鼓点、噪音、低频、人声处理、段落长度或混音质感。",
        "结尾要形成一个观点，而不是百科式总结。"
      ]
    }
  };
  return methods[guideId] || null;
}

function guideRequirements(guideId) {
  const requirements = {
    song: [
      "整体展开方式偏 HOPICO：像新作推荐/站台乐评，但必须有声音证据和艺人脉络，不要只夸。",
      "第一句必须先跟听众打招呼，并明确说出今天要听的是哪位艺人的哪首歌，格式必须接近“今天我们要听的是某某的《某某》”。",
      "必须分析艺人、歌曲、专辑或发行语境；如果资料里没有专辑名，不要编造，可以说资料里暂时没有稳定专辑信息。",
      "可以多聊艺人的其他代表歌曲、职业阶段或公众形象变化，用来说明主题歌在艺人作品序列中的位置。",
      "必须谈到艺人职业生涯或音乐圈位置：可以谈场景、影响、代际、商业位置、审美位置或与同类音乐人的关系。",
      "必须分析这首歌的风格：把流派标签落到可听见的鼓、低频、吉他、合成器、人声、旋律、歌词语气或混音上。"
    ],
    map: [
      "整体展开方式是具象波 + HOPICO：先用概念问题搭框架，再像站台一样一首一首裂变推荐。",
      "这一篇的核心是裂变：从主题歌出发，沿着相近风格、相近制作问题或相近音乐人继续向外扩散。",
      "每次跳到另一首歌前，都要把听众当成小乐迷，说明为什么要听这首看似不一样的歌。",
      "必须讲清两首歌的关联：共享的流派节点、相似的节奏骨架、相近的人声处理、共同的听众场景，或完全相反但可比较的解决方案。",
      "不能只报歌名和放片段；每一个片段都要成为路线上的证据。"
    ],
    history: [
      "整体展开方式偏具象波：从声音现象进入概念史、文化史和听众位置。",
      "这一篇要介绍音乐人或风格的来源，不要只讲歌曲听感。",
      "要挖风格背后的人群、城市、场景、媒介和传播方式；资料支持时，可以谈阶层、族群、移民、地缘政治、宗教或技术条件。",
      "优先使用 publicResearchContext 里的公开资料摘要；如果资料不够，必须用“可能”“更稳妥地说”这类谨慎表达，不要编造。",
      "最后要把人文背景落回具体声音，让听众知道这些历史为什么能在耳朵里听见。"
    ]
  };
  return requirements[guideId] || [];
}

function guideSlotGoal(guideId, index, voice) {
  const goals = {
    song: [
      "开场：用 HOPICO 式站台推荐开场，先打招呼，明确介绍今天听的是哪位艺人的哪首歌，并给出一句清楚的推荐判断。",
      "追问：让专家解释这首歌第一遍应该先抓住什么，同时引出艺人的其他作品、合作或发行语境。",
      "分析：深挖艺人、歌曲、专辑或职业生涯位置，再落到一个具体制作、律动、人声、采样或歌词语气细节。",
      "追问：要求把刚才的职业/风格判断和普通听感连接起来。",
      "参照：围绕刚出现的片段比较主题歌和相邻作品，必须说清共同点和差异。",
      "追问：把比较收束成这首歌的独特性和风格定位问题。",
      "收束：总结这首歌的风格判断、艺人位置和下一次重听入口。"
    ],
    map: [
      "开场：用具象波式概念框架提出本段的风格问题，再说明这一篇要做有迹可循的裂变。",
      "追问：问清楚为什么要从主题歌跳到下一首相近但可能很不一样的歌。",
      "分析：像 HOPICO 推荐下一站一样解释第一个相邻节点和主题歌共享的声音问题。",
      "追问：要求区分相似性和差异性，不能只说它们都是同一类。",
      "参照：比较刚出现片段与主题歌的结构、听感或人群场景差异。",
      "追问：把路线总结成可听见的迁移问题，说明下一跳的理由。",
      "分析：说明新的裂变片段如何打开另一个相邻音乐人或风格。",
      "收束：说明这条裂变路线如何帮助重新听主题歌。"
    ],
    history: [
      "开场：用具象波式问题切入，把主题歌放回风格来源、传播、技术和听众现场。",
      "追问：问为什么私人听感会变成公共记忆，并引出人群或城市背景。",
      "分析：用公开资料说明音乐人或风格的来源，以及技术、媒介、商业或场景如何影响声音形态。",
      "追问：要求把历史、人群或城市背景落到耳朵能听见的东西上。",
      "参照：解释刚出现片段和主题歌共享的历史线索或场景逻辑。",
      "追问：把听众现场、城市、传播和风格变化连起来。",
      "收束：用一句明确判断结束，把人文背景重新落回主题歌的声音。"
    ]
  };
  return goals[guideId]?.[index - 1] || (voice === "male" ? "追问上一句的具体听感依据。" : "回答上一句，并推进到下一个声音细节。");
}

function normalizeDeepSeekGuidePayload(payload) {
  if (Array.isArray(payload?.guides)) {
    return Object.fromEntries(payload.guides.map((guide) => [guide.id, guide]));
  }
  if (payload?.guides && typeof payload.guides === "object") return payload.guides;
  return {};
}

function fitTtsTextsToSlots(texts, slotCount) {
  const cleanTexts = (texts || []).map(cleanSpokenText).filter(Boolean);
  return cleanTexts.slice(0, slotCount);
}

function looksLikeNewbieText(text) {
  return /我.*(不懂|不知道|没听出来|聽不出|听不出|不明白|还真不知道|有点没|感觉|好像)|为什么|为啥|啥关系|什么区别|怎么听|怎么分|是不是|吗[？?]|呢[？?]/.test(String(text || ""));
}

function looksLikeExpertText(text) {
  return /你注意听|关键|典型|这就是|区别在于|核心|制作|编曲|混音|低频|底鼓|合成器|人声|流派|谱系|历史|传播|场景|节点|结构|律动/.test(String(text || ""));
}

function englishTokenCount(text) {
  const tokens = String(text || "").match(/\b[A-Za-z][A-Za-z0-9'’.-]{1,}\b/g) || [];
  return tokens
    .map((token) => token.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((token) => token.length >= 2 && !/^(mv|hd|hq)$/i.test(token))
    .length;
}

function ensureFemaleCodeSwitch(text, song) {
  const value = cleanSpokenText(text);
  if (englishTokenCount(value) >= 1) return value;
  const genre = genreName(song?.genres?.[0] || "rock");
  return `${value}${/[。！？!?]$/.test(value) ? "" : "。"}这里可以用一个 music critic 常说的词：groove，也就是身体会先跟上的律动；放回 ${songName(song)}，这个 ${genre} 的质感不是标签，而是能听见的 bassline、vocal 和 mix 的关系。`;
}

function repairPersonaTextOrder(texts, ttsSlots) {
  const repaired = [...texts];
  for (let index = 0; index < repaired.length - 1; index += 1) {
    const currentVoice = ttsSlots[index]?.[1];
    const nextVoice = ttsSlots[index + 1]?.[1];
    if (
      currentVoice === "female" &&
      nextVoice === "male" &&
      looksLikeNewbieText(repaired[index]) &&
      looksLikeExpertText(repaired[index + 1])
    ) {
      [repaired[index], repaired[index + 1]] = [repaired[index + 1], repaired[index]];
    }
  }
  return repaired;
}

function deepSeekDialogueIssues(payload, baseGuides) {
  const guidesById = normalizeDeepSeekGuidePayload(payload);
  const issues = [];
  for (const guide of baseGuides) {
    const deepGuide = guidesById[guide.id];
    if (!deepGuide) {
      issues.push(`${guide.id}: missing guide`);
      continue;
    }
    if (!cleanSpokenText(deepGuide.title)) issues.push(`${guide.id}: missing title`);
    if (!cleanSpokenText(deepGuide.outline)) issues.push(`${guide.id}: missing outline`);
    const ttsTexts = Array.isArray(deepGuide?.ttsTexts) ? deepGuide.ttsTexts.map(cleanSpokenText).filter(Boolean) : [];
    const ttsSlots = guide.sequence.filter((item) => item[0] === "tts");
    const ttsSlotMeta = guide.sequence
      .map((item, sequenceIndex) => ({ item, sequenceIndex }))
      .filter(({ item }) => item[0] === "tts")
      .map(({ item, sequenceIndex }) => ({
        item,
        previousClip: guide.sequence[sequenceIndex - 1]?.[0] === "clip" ? guide.sequence[sequenceIndex - 1][1] : null,
        nextClip: guide.sequence[sequenceIndex + 1]?.[0] === "clip" ? guide.sequence[sequenceIndex + 1][1] : null
      }));
    const clips = guide.sequence.filter((item) => item[0] === "clip").map((item) => item[1]).filter(Boolean);
    if (ttsTexts.length < ttsSlots.length) {
      issues.push(`${guide.id}: expected at least ${ttsSlots.length} ttsTexts, got ${ttsTexts.length}`);
      continue;
    }
    const fittedTexts = repairPersonaTextOrder(fitTtsTextsToSlots(ttsTexts, ttsSlots.length), ttsSlots);
    const totalChars = fittedTexts.join("").replace(/\s+/g, "").length;
    if (totalChars < 900) issues.push(`${guide.id}: spoken script too short (${totalChars} chars), target 1600-2200 chars`);
    ttsSlots.forEach((slot, index) => {
      const text = fittedTexts[index] || "";
      if (!text) issues.push(`${guide.id}: empty turn ${index + 1}`);
      if (slot[1] === "male" && looksLikeExpertText(text) && !looksLikeNewbieText(text) && text.length > 280) {
        issues.push(`${guide.id}: male turn ${index + 1} sounds like long expert analysis`);
      }
      const meta = ttsSlotMeta[index] || {};
      const clipIssues = clipReferenceIssues(guide.id, index, text, meta.previousClip, meta.nextClip, clips);
      if (clipIssues.length && process.env.DEBUG_DEEPSEEK_VALIDATION === "1") {
        console.warn(`DeepSeek clip alignment warnings: ${clipIssues.join("；")}`);
      }
    });
  }
  return issues;
}

function cleanSpokenText(text) {
  return String(text || "")
    .replace(/^女(主持|专家)[:：]\s*/, "")
    .replace(/^男(主持|生|小白)[:：]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function textMentionsClip(text, clip) {
  if (!clip) return false;
  const value = String(text || "");
  const title = cleanSongTitleForSpeech(clip.title);
  const artist = String(clip.artist || "");
  return Boolean((title && value.includes(title)) || (artist && value.includes(artist)));
}

function sameClip(a, b) {
  if (!a || !b) return false;
  const titleA = cleanSongTitleForSpeech(a.title).toLowerCase();
  const titleB = cleanSongTitleForSpeech(b.title).toLowerCase();
  const artistA = String(a.artist || "").toLowerCase();
  const artistB = String(b.artist || "").toLowerCase();
  return Boolean(titleA && titleA === titleB && (!artistA || !artistB || artistA === artistB));
}

function clipReferenceIssues(guideId, index, text, previousClip, nextClip, clips) {
  const value = String(text || "");
  const issues = [];
  const forwardCue = /接下来|等一下|马上|待会|下一段|下一首|下一站|再跳到|再听|会跳到|第一个会选/;
  const backwardCue = /刚才|刚刚|上一段|刚才这段|上一首/;
  const sentences = value.split(/(?<=[。！？!?])/).map((sentence) => sentence.trim()).filter(Boolean);
  for (const sentence of sentences) {
    const hasForwardCue = forwardCue.test(sentence);
    const hasBackwardCue = backwardCue.test(sentence);
    if (!hasForwardCue && !hasBackwardCue) continue;
    for (const clip of clips) {
      if (!textMentionsClip(sentence, clip)) continue;
      if (hasForwardCue && !sameClip(clip, nextClip)) {
        issues.push(`${guideId}: turn ${index + 1} announces ${clipName(clip)} but next clip is ${nextClip ? clipName(nextClip) : "none"}`);
      }
      if (hasBackwardCue && !sameClip(clip, previousClip)) {
        issues.push(`${guideId}: turn ${index + 1} responds to ${clipName(clip)} but previous clip is ${previousClip ? clipName(previousClip) : "none"}`);
      }
    }
  }
  return issues;
}

function clipListeningCue(clip) {
  const nodes = (clip?.nodes || []).map(resolveGenreId);
  const text = normalizeSearchText([clip?.artist, clip?.title, clip?.reason, nodes.join(" ")].join(" "));
  if (/bass|groove|funk|dance|disco|drum|beat/.test(text)) return "\u4f4e\u9891\u548c\u9f13\u70b9\u600e\u6837\u5148\u628a\u8eab\u4f53\u5e26\u8d77\u6765";
  if (/guitar|riff|rock|grunge|shoegaze|hard rock|alternative|distortion/.test(text)) return "\u5409\u4ed6\u97f3\u8272\u3001riff \u548c\u7206\u53d1\u70b9\u600e\u6837\u5236\u9020\u63a8\u8fdb";
  if (/vocal|voice|soul|ballad|mandopop|cantopop|melody/.test(text)) return "\u4eba\u58f0\u4f4d\u7f6e\u548c\u65cb\u5f8b\u7ebf\u600e\u6837\u628a\u60c5\u7eea\u63a8\u5230\u524d\u9762";
  if (/synth|electronic|art pop|sophisti|dream pop|new wave|mix|space/.test(text)) return "\u5408\u6210\u5668\u3001\u6df7\u97f3\u7a7a\u95f4\u548c\u58f0\u573a\u5c42\u6b21\u600e\u6837\u6539\u53d8\u60c5\u7eea\u989c\u8272";
  if (/history|classic|anthem|britpop|college|radio|scene|era/.test(text)) return "\u5b83\u80cc\u540e\u7684\u65f6\u4ee3\u6c14\u5473\u3001\u7535\u53f0\u611f\u548c\u542c\u4f17\u73b0\u573a";
  return "\u5f00\u5934\u7684\u97f3\u8272\u5165\u53e3\u3001\u6bb5\u843d\u63a8\u8fdb\u548c\u60c5\u7eea\u91cd\u5fc3";
}
function alignTtsTextToAdjacentClip(text, voice, previousClip, nextClip) {
  let value = cleanSpokenText(text);
  if (previousClip && !textMentionsClip(value, previousClip)) {
    const prefix = voice === "male"
      ? `刚才这段 ${clipName(previousClip)}，我听到的重点是${clipListeningCue(previousClip)}。`
      : `刚才这段 ${clipName(previousClip)}，可以先抓住${clipListeningCue(previousClip)}。`;
    value = `${prefix}${value}`;
  }
  if (nextClip && !textMentionsClip(value, nextClip)) {
    const suffix = `\u4f60\u5148\u628a\u8033\u6735\u653e\u5230 ${clipName(nextClip)}\uff0c\u7559\u610f${clipListeningCue(nextClip)}\uff0c\u6211\u4eec\u56de\u6765\u518d\u628a\u8fd9\u4e2a\u542c\u611f\u63a5\u4e0a\u3002`;
    value = `${value}${/[。！？!?]$/.test(value) ? "" : "。"}${suffix}`;
  }
  return value;
}

function normalizeMandarinTtsText(text) {
  return String(text || "")
    .replace(/\[[^\]]*]/g, "")
    .replace(/【[^】]*】/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/（[^）]*）/g, "")
    .replace(/\b(?:Official Video|Official Audio|Music Video|Visualizer|Lyrics?|M\/V|MV|HD|HQ)\b/gi, "")
    .replaceAll("《紅豆》", "《红豆》")
    .replaceAll("紅豆", "红豆")
    .replaceAll("《對的人》", "《对的人》")
    .replaceAll("對的人", "对的人")
    .replaceAll("感應", "感应")
    .replaceAll("当Beyond的《海阔天空》出现时", "当《海阔天空》出现时")
    .replaceAll("Beyond的《海阔天空》", "《海阔天空》")
    .replaceAll("卡拉OK", "卡拉欧凯")
    .replace(/[“”"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function buildDeepSeekGuides(session, baseGuides, sessionDir, options = {}) {
  const cachePath = join(sessionDir, `deepseek-guides-${safeId(DEEPSEEK_GUIDE_VERSION)}.json`);
  let payload = null;
  if (!options.forceFresh && existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    if (!deepSeekDialogueIssues(cached, baseGuides).length) payload = cached;
  }
  if (!payload) {
    const song = compactSongForPrompt(session);
    const publicResearchContext = await loadPublicResearchContext(session, sessionDir);
    const blueprint = baseGuides.map(guideBlueprint);
    const makeMessages = (attempt, issues = []) => [
      {
        role: "system",
        content:
          "你是一位资深中文音乐评论编辑和播客策划，也懂电台对话节奏。你要基于给定资料做深度资料梳理与文案生成。只输出 JSON，不要 Markdown。不要编造不确定事实；如果资料不足，把分析落在可听见的声音、制作、歌词语气、传播场景和风格谱系上。"
      },
      {
        role: "user",
        content: JSON.stringify({
          task:
            "为这首歌生成三篇“深度聆听”播客文案。角色固定：女生是资深音乐专家，负责解释、判断和把声音细节讲清楚；男生是比较小白的听众，负责追问、确认、用普通听众语言把问题抛出来。两人必须像真实播客对话：每一句都要接住上一句，不能像两段独立讲稿拼在一起。ttsTexts 不是自由对话列表，而是逐格填空：第 i 项必须严格对应 blueprint.slots 中第 i 个 type=tts slot 的 voice/persona/slotGoal，不要把另一个角色的话混进同一个 ttsText。每条 guide 的 ttsTexts 数量必须严格等于对应 slots 里 type=tts 的数量，顺序完全一致。不要写旁白动作，不要写舞台说明，不要给 TTS 文案加 speaker 前缀。",
          hardRules: [
            "三篇的展开方式分配：第一篇 song 学 HOPICO 的作品站台式深挖；第二篇 map 学具象波的概念框架加 HOPICO 的参照曲跳转；第三篇 history 学具象波的概念史/文化史展开。",
            "每一篇最终要接近 5 分钟的 AI 播客：音乐采样大约占 1.5 到 2 分钟，人声对话大约占 3 到 3.5 分钟。请按这个目标写足信息量。",
            "每篇 ttsTexts 总字数目标为 1600 到 2200 个中文字符；女生专家每回合通常 240 到 360 个中文字符，男生小白每回合通常 120 到 220 个中文字符。不要写太短。",
            "这里只学习展开方法和分析结构，不要模仿或复刻任何创作者的固定口头禅、句式和原文表达。",
            "必须是一男一女对话：男生永远是小白听众，女生永远是专家；不要混淆人设。",
            "所有男生小白回合都必须是问句，文本里必须出现中文问号“？”或英文问号“?”。",
            "女生专家不得装作小白，不得说“我听不懂”“我没听出来”“我不知道为什么要听这首”这类小白问题；她可以反问，但必须是专家式引导。",
            "男生小白不得大段解释专业结论，不得替专家分析制作、历史或流派谱系；他只能用普通听众视角追问、确认、复述困惑。",
            "女生专家回合必须回答男生刚问的问题，或主动抛出一个男生下一句能接住的问题点。",
            "对话必须有来有回：不一定机械一问一答，但每一句都要像接着上一句说出来，不能像三段独立解说词。",
            "必须非常口语化，像真实播客聊天；少用书面词、排比句和总结腔，多用自然转折、确认、追问、举例。",
            "如果 slot 的 upcomingClip 不为空，说明这一句后面会立刻插入这首歌：本句必须自然介绍 upcomingClip 的艺人和歌名，并给出 1-2 个具体听点，例如低频、吉他、人声、鼓点、混音空间、段落推进。",
            "介绍 upcomingClip 时不要说“等一下插入”“插入采样”“播放片段”这类工程化报幕；要像电台导听一样说“你先听它的……”“先把耳朵放在……”“这里让这首歌自己说话”。",
            "如果 slot 的 previousClip 不为空，说明上一段刚播放了这首歌：本句开头必须先回应 previousClip 的听感，再继续讨论。不要把 previousClip 说成另一首歌。",
            "严禁错位报歌：不能在某个 slot 里介绍不是 upcomingClip 或 previousClip 的其他采样歌曲。尤其不能说“接下来听 A”，但系统实际插入 B。",
            "任何时候提到歌曲名称，都必须采用“艺人 的《歌名》”这种形式；不能只说《歌名》，也不能只说歌名。",
            "英文艺人名、英文歌名、风格名、制作术语和少量英文歌词短句必须保留英文原文，做自然中英夹杂；不要把 Radiohead、Thom Yorke、Creep、Billie Jean、Maybe Your Baby 这类名称意译或音译成中文。英文短语前后用中文解释听点，避免连续大段英文。",
            "女生专家必须有专业乐评里的自然中英文混读感：每个女生回合至少保留 1-3 个英文专名或术语，例如 groove、bassline、riff、hook、vocal、mix、post-punk、synth、Radiohead、Creep。英文必须嵌在中文句子里解释听感，不要整句英文，也不要把英文术语翻译掉。",
            "男生小白可以少量使用英文歌名或风格词，但重点仍是追问；中英文混读的主要质感由女生专家承担。",
            "念歌名时只念干净歌名，不要念 MV、M/V、Official Video、括号、方括号或版本备注。",
            "第一篇 song 必须先打招呼，开门见山介绍主题歌是谁的哪首歌，然后深挖艺人、歌曲、专辑或发行语境、职业生涯位置和风格定位。",
            "第一篇 song 可以多聊艺人的其他代表歌曲或职业节点，用来说明这首主题歌在其作品序列里的位置；资料不足时不要编造。",
            "第二篇 map 必须做有迹可循的裂变：每次跳到另一首歌，都要解释为什么要听它，以及它和上一首歌或主题歌之间的声音/风格/人群关联。",
            "第三篇 history 必须优先使用 publicResearchContext 的公开资料摘要，挖音乐人或风格背后的人群、城市、媒介、技术、传播、地缘政治或宗教等背景；资料不足时必须谨慎表达。",
            "slotGoal 只是结构功能，严禁照抄；必须重新组织语言，不能写成模板句。",
            "每个 ttsText 要像播客里一整轮发言，而不是一句短解说；可以有自然转折、例子、类比和追问，但不要空转、不要重复、不要水词。",
            "男生可以说“我有点没听出来”“所以你的意思是”“这跟普通情歌有什么区别？”这类真实问题；但不要装傻，不要重复废话。",
            "女生要有资深判断和听感细节；术语必须马上翻译成人话，语气像在录节目，不要像论文或百科词条。",
            "女生不要连续堆概念；每 2 到 3 句就要回到一个可听见的声音细节，例如鼓、低频、吉他、人声、和声、混音空间、歌词语气或段落推进。",
            "整体口语化：允许轻微停顿感和转折词，比如“你注意听”“对，但关键不是这个”“这就有意思了”。",
            "必须围绕具体歌曲、具体声音细节、歌词语气、编曲留白、时代传播和相邻金曲关系展开，避免泛泛说“好听”“有情绪”。",
            "如果提到创作者、年份、专辑等事实，必须基于已知资料或常识高置信；不确定就不要硬写。",
            "每次都当作全新稿件来写，不要复用旧稿结构、旧开场、旧收束或任何固定套话。"
          ],
          repairInstruction: attempt > 0
            ? `上一次输出不合格，原因：${issues.join("；")}。请完全重写，不要复用上一版独白式句子。`
            : "",
          returnShape: {
            guides: {
              song: { title: "string", outline: "string", ttsTexts: ["string"] },
              map: { title: "string", outline: "string", ttsTexts: ["string"] },
              history: { title: "string", outline: "string", ttsTexts: ["string"] }
            }
          },
          generationNonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          song,
          publicResearchContext,
          blueprint
        }, null, 2)
      }
    ];

    let issues = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        payload = await callDeepSeekJson(makeMessages(attempt, issues), `DeepSeek guide writing attempt ${attempt + 1}`);
      } catch (error) {
        issues = [`DeepSeek returned invalid JSON or failed: ${error.message}`];
        payload = null;
        continue;
      }
      issues = deepSeekDialogueIssues(payload, baseGuides);
      if (!issues.length) break;
      payload = null;
    }
    if (!payload) {
      throw new Error(`DeepSeek guide writing did not satisfy dialogue constraints: ${issues.slice(0, 8).join("；")}`);
    }
    writeFileSync(cachePath, JSON.stringify(payload, null, 2));
  }

  const guidesById = normalizeDeepSeekGuidePayload(payload);
  return baseGuides.map((guide) => {
    const deepGuide = guidesById[guide.id];
    const ttsSlots = guide.sequence.filter((item) => item[0] === "tts");
    const ttsCount = ttsSlots.length;
    const rawTtsTexts = Array.isArray(deepGuide?.ttsTexts) ? deepGuide.ttsTexts.map(cleanSpokenText).filter(Boolean) : [];
    if (rawTtsTexts.length < ttsCount) {
      throw new Error(`DeepSeek guide ${guide.id} returned ${rawTtsTexts.length} TTS texts, expected at least ${ttsCount}.`);
    }
    const ttsTexts = repairPersonaTextOrder(fitTtsTextsToSlots(rawTtsTexts, ttsCount), ttsSlots);
    let ttsIndex = 0;
    const sequence = guide.sequence.map((item, sequenceIndex) => {
      if (item[0] !== "tts") return item;
      const voice = item[1];
      const label = voice === "female" ? "女专家" : "男小白";
      const previousClip = guide.sequence[sequenceIndex - 1]?.[0] === "clip" ? guide.sequence[sequenceIndex - 1][1] : null;
      const nextClip = guide.sequence[sequenceIndex + 1]?.[0] === "clip" ? guide.sequence[sequenceIndex + 1][1] : null;
      let text = alignTtsTextToAdjacentClip(ttsTexts[ttsIndex++], voice, previousClip, nextClip);
      text = normalizeMandarinTtsText(text);
      if (voice === "female") text = ensureFemaleCodeSwitch(text, session.song);
      if (voice === "male" && text && !/[？?]/.test(text)) text = `${text}？`;
      return ["tts", voice, label, text];
    });
    return {
      ...guide,
      title: cleanSpokenText(deepGuide.title),
      outline: cleanSpokenText(deepGuide.outline),
      script: "DeepSeek 生成男女对话文案；云端 TTS 生成每段语音；FFmpeg 插入金曲片段并合成。",
      sequence
    };
  });
}

function splitTtsText(text, maxChars = 150) {
  const clean = String(text || "")
    .replace(/它在地图上暂时点亮[^。！？!?]+[。！？!?]?/g, "先听这首歌。")
    .replace(/地图/g, "路线")
    .replace(/入口/g, "起点")
    .replace(/华语/g, "中文")
    .replace(/国语/g, "普通话")
    .replace(/粤语/g, "广东话")
    .replace(/经典普通话流行/g, "经典歌曲")
    .replace(/中文流行、普通话流行、广东话流行/g, "流行歌曲")
    .replace(/中文流行、普通话流行/g, "流行歌曲")
    .replace(/普通话流行、广东话流行/g, "流行歌曲")
    .replace(/中文流行/g, "流行歌曲")
    .replace(/普通话流行/g, "流行歌曲")
    .replace(/广东话流行/g, "流行歌曲")
    .replace(/[()[\]【】]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[“”"]/g, "")
    .trim();
  if (!clean) return [];
  const sentences = clean.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [clean];
  const chunks = [];
  let current = "";

  const normalizeChunk = (chunk) => {
    const value = chunk.trim().replace(/[，,、：:；;]+$/g, "");
    if (!value) return "";
    return /[。！？!?]$/.test(value) ? value : `${value}。`;
  };

  const pushCurrent = () => {
    const chunk = normalizeChunk(current);
    if (chunk) chunks.push(chunk);
    current = "";
  };

  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;
    if (sentence.length > maxChars) {
      pushCurrent();
      const clauses = sentence.match(/[^，,、：:]+[，,、：:]?/g) || [sentence];
      let clauseBuffer = "";
      for (const clause of clauses) {
        if ((clauseBuffer + clause).length > maxChars && clauseBuffer) {
          const chunk = normalizeChunk(clauseBuffer);
          if (chunk) chunks.push(chunk);
          clauseBuffer = "";
        }
        if (clause.length > maxChars) {
          const chunk = normalizeChunk(clauseBuffer);
          if (chunk) chunks.push(chunk);
          clauseBuffer = "";
          for (let index = 0; index < clause.length; index += maxChars) {
            const piece = normalizeChunk(clause.slice(index, index + maxChars));
            if (piece) chunks.push(piece);
          }
          continue;
        }
        clauseBuffer += clause;
      }
      const chunk = normalizeChunk(clauseBuffer);
      if (chunk) chunks.push(chunk);
      continue;
    }
    if ((current + sentence).length > maxChars && current) pushCurrent();
    current += sentence;
  }
  pushCurrent();
  return chunks;
}

function prepareGuideForFish(guide) {
  const sequence = [];
  for (const item of guide.sequence) {
    if (item[0] !== "tts") {
      sequence.push(item);
      continue;
    }
    for (const chunk of splitTtsText(item[3], 88)) {
      sequence.push(["tts", item[1], item[2], chunk]);
    }
  }
  return { ...guide, sequence };
}

function makeMarkdown(guide) {
  const lines = [`# ${guide.title}`, "", "## 大纲", "", guide.outline, "", "## 生成稿件", ""];
  for (const item of guide.sequence) {
    if (item[0] === "tts") lines.push(`**${item[2]}**：${item[3]}`);
    if (item[0] === "clip") {
      const clip = item[1];
      lines.push(`> 金曲片段：${clip.artist} 的《${clip.title}》`);
      lines.push(`> 引用原因：${clip.reason}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function generatePack(session, options = {}) {
  const sessionDir = join(runtimeDir, session.id);
  const tts = currentTtsSignature(options.engine);
  const forceFresh = options.forceFresh === true;
  const guideIds = options.guideIds?.length ? [...options.guideIds] : null;
  const guideFilter = guideIds ? new Set(guideIds) : null;
  const manifestSuffix = guideIds ? `-${guideIds.map(safeId).join("-")}` : "";
  const manifestPath = join(sessionDir, `manifest-${tts.engine}${manifestSuffix}.json`);
  if (!forceFresh && existsSync(manifestPath)) {
    const cachedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const sameTts = Object.entries(tts).every(([key, value]) => cachedManifest.tts?.[key] === value);
    if (sameTts) {
      return cachedManifest;
    }
  }
  const workDir = join(sessionDir, `work-${tts.engine}`);
  const scriptsDir = join(sessionDir, `scripts-${tts.engine}`);
  mkdirSync(workDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });

  const manifest = {
    generatedAt: new Date().toISOString(),
    pipeline: ["真实搜索", "匹配 YouTube metadata", "下载歌曲", "宇宙流派映射", "稿件生成", "TTS", "金曲剪辑", "导出导听"],
    tts,
    guides: {}
  };

  const samplePool = buildSamplePool(session, workDir, { forceFresh: forceFresh && options.refreshSamplePool === true });
  const baseGuides = ensureDownloadableGuideClipPlan(
    chooseGuideClipPlan(buildGuides(session.song), session),
    session,
    workDir,
    samplePool
  );
  const buildTargetGuides = guideFilter ? baseGuides.filter((guide) => guideFilter.has(guide.id)) : baseGuides;
  const builtGuides = await buildDeepSeekGuides(session, buildTargetGuides, sessionDir, { forceFresh });
  const clipUseCounts = new Map();
  const usedClipKeys = new Set();
  for (const guide of baseGuides) {
    let clipNumber = 0;
    for (const item of guide.sequence) {
      if (item[0] !== "clip") continue;
      clipNumber += 1;
      if (clipNumber === 1 || isThemeClip(item[1], session)) continue;
      const key = clipIdentity(item[1]);
      if (key) usedClipKeys.add(key);
    }
  }

  for (const rawGuide of builtGuides) {
    if (guideFilter && !guideFilter.has(rawGuide.id)) continue;
    const guide = tts.engine === "fish" ? prepareGuideForFish(rawGuide) : rawGuide;
    const ttsJobs = guide.sequence
      .map((item, index) =>
        item[0] === "tts"
          ? { index, voice: item[1], text: item[3], output: ttsSegmentPath(workDir, guide.id, index) }
          : null
      )
      .filter(Boolean);
    const volcDialogueFiles = tts.engine === "volc-podcast"
      ? await renderVolcPodcastGuideBlocks(workDir, guide.id, guide.sequence)
      : null;
    if (!volcDialogueFiles) await renderTtsBatch(workDir, guide.id, ttsJobs, tts.engine);

    const files = [];
    const refs = [];
    let cursor = 0;
    let pendingClip = null;

    for (const [index, item] of guide.sequence.entries()) {
      if (item[0] === "tts") {
        const wavs = volcDialogueFiles ? volcDialogueFiles.get(index) : [ttsSegmentPath(workDir, guide.id, index)];
        if (!wavs) continue;
        if (pendingClip) {
          const mixed = mixVoiceOverMusic(workDir, guide.id, pendingClip.sequenceIndex, index, pendingClip, wavs);
          files.push(mixed.wav);
          refs.push({
            title: cleanSongTitleForSpeech(pendingClip.clip.title),
            artist: pendingClip.clip.artist,
            youtube: pendingClip.clip.youtube,
            time: `${formatTime(pendingClip.start)}-${formatTime(pendingClip.start + pendingClip.length)}`,
            reason: `${pendingClip.clip.reason}（新版混音：先让音乐前景出现约 ${Math.round(mixed.focusSeconds)} 秒；人声进入后，音乐从后续段落顺延播放并压低为背景。）`,
            nodes: pendingClip.clip.nodes || session.song.genres.slice(0, 3),
            edges: pendingClip.clip.edges || [],
            cueStart: Number(cursor.toFixed(2)),
            cueEnd: Number((cursor + mixed.duration).toFixed(2)),
            focusEnd: Number((cursor + mixed.focusSeconds).toFixed(2)),
            bedVolume: mixed.bedVolume
          });
          cursor += mixed.duration;
          pendingClip = null;
        } else {
          for (const wav of wavs) {
            files.push(wav);
            cursor += getDuration(wav);
          }
        }
        continue;
      }

      if (pendingClip) {
        files.push(pendingClip.wav);
        refs.push({
          title: cleanSongTitleForSpeech(pendingClip.clip.title),
          artist: pendingClip.clip.artist,
          youtube: pendingClip.clip.youtube,
          time: `${formatTime(pendingClip.start)}-${formatTime(pendingClip.start + pendingClip.length)}`,
          reason: pendingClip.clip.reason,
          nodes: pendingClip.clip.nodes || session.song.genres.slice(0, 3),
          edges: pendingClip.clip.edges || [],
          cueStart: Number(cursor.toFixed(2)),
          cueEnd: Number((cursor + pendingClip.duration).toFixed(2))
        });
        cursor += pendingClip.duration;
        pendingClip = null;
      }

      const { renderedClip: chosenClip, rendered } = renderBestClipSegment(
        workDir,
        guide.id,
        index,
        item[1],
        session,
        clipUseCounts,
        usedClipKeys
      );
      const { wav, source, sourceDuration, start, length: renderedLength } = rendered;
      const duration = getDuration(wav);
      const renderedClip = { ...chosenClip, length: renderedLength || chosenClip.length };
      pendingClip = {
        sequenceIndex: index,
        clip: renderedClip,
        wav,
        source,
        sourceDuration,
        start,
        length: renderedClip.length,
        duration
      };
    }

    if (pendingClip) {
      files.push(pendingClip.wav);
      refs.push({
        title: cleanSongTitleForSpeech(pendingClip.clip.title),
        artist: pendingClip.clip.artist,
        youtube: pendingClip.clip.youtube,
        time: `${formatTime(pendingClip.start)}-${formatTime(pendingClip.start + pendingClip.length)}`,
        reason: pendingClip.clip.reason,
        nodes: pendingClip.clip.nodes || session.song.genres.slice(0, 3),
        edges: pendingClip.clip.edges || [],
        cueStart: Number(cursor.toFixed(2)),
        cueEnd: Number((cursor + pendingClip.duration).toFixed(2))
      });
      cursor += pendingClip.duration;
    }

    const output = join(sessionDir, `guide-${guide.id}-${tts.engine}.wav`);
    concatFiles(files, output);
    const duration = getDuration(output);
    writeFileSync(join(scriptsDir, `guide-${guide.id}-${tts.engine}.md`), makeMarkdown(guide));
    manifest.guides[guide.id] = {
      title: guide.title,
      audioUrl: `assets/runtime/${session.id}/guide-${guide.id}-${tts.engine}.wav`,
      scriptUrl: `assets/runtime/${session.id}/scripts-${tts.engine}/guide-${guide.id}-${tts.engine}.md`,
      duration,
      durationLabel: formatTime(duration),
      outline: guide.outline,
      script: guide.script,
      refs,
      cues: refs.map((reference) => ({ start: reference.cueStart, end: reference.cueEnd, reference }))
    };
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  if (!guideIds && options.writeDefaultManifest !== false) {
    writeFileSync(join(sessionDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }
  return manifest;
}

async function generateScriptPack(session, options = {}) {
  const sessionDir = join(runtimeDir, session.id);
  mkdirSync(sessionDir, { recursive: true });
  const forceFresh = options.forceFresh === true;
  const guideIds = options.guideIds?.length ? [...options.guideIds] : null;
  const guideFilter = guideIds ? new Set(guideIds) : null;
  const manifestSuffix = guideIds ? `-${guideIds.map(safeId).join("-")}` : "";
  const scriptManifestPath = join(sessionDir, `manifest-script${manifestSuffix}.json`);
  if (!forceFresh && existsSync(scriptManifestPath)) {
    return JSON.parse(readFileSync(scriptManifestPath, "utf8"));
  }
  if (!envFirst(["DEEPSEEK_API_KEY"])) {
    throw new Error("Missing DeepSeek API key. Set DEEPSEEK_API_KEY in .env or the process environment.");
  }

  const scriptsDir = join(sessionDir, "scripts-deepseek");
  mkdirSync(scriptsDir, { recursive: true });
  const baseGuides = buildGuides(session.song).filter((guide) => !guideFilter || guideFilter.has(guide.id));
  const builtGuides = await buildDeepSeekGuides(session, baseGuides, sessionDir, { forceFresh });
  const manifest = {
    generatedAt: new Date().toISOString(),
    sessionId: session.id,
    engine: "deepseek-script",
    pipeline: ["真实搜索", "歌曲确认", "DeepSeek 三轮双人文稿", "角色与中英文混读校验"],
    guides: {}
  };

  for (const guide of builtGuides) {
    const scriptPath = join(scriptsDir, `guide-${guide.id}-deepseek.md`);
    writeFileSync(scriptPath, makeMarkdown(guide));
    const ttsTurns = guide.sequence.filter((item) => item[0] === "tts");
    const refs = guide.sequence
      .filter((item) => item[0] === "clip")
      .map((item) => {
        const clip = item[1];
        return {
          title: cleanSongTitleForSpeech(clip.title),
          artist: clip.artist,
          youtube: clip.youtube,
          time: `${formatTime(clip.start || 0)}-${formatTime((clip.start || 0) + (clip.length || DEFAULT_MUSIC_LISTEN_SECONDS))}`,
          reason: clip.reason,
          nodes: clip.nodes || session.song.genres.slice(0, 3),
          edges: clip.edges || [],
          cueStart: 0,
          cueEnd: 0
        };
      });
    manifest.guides[guide.id] = {
      title: guide.title,
      scriptUrl: `assets/runtime/${session.id}/scripts-deepseek/guide-${guide.id}-deepseek.md`,
      duration: null,
      durationLabel: "约 5 分钟",
      outline: guide.outline,
      script: guide.script,
      turnCount: ttsTurns.length,
      refs,
      cues: []
    };
  }

  writeFileSync(scriptManifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

async function generateComparePack(session, engines = ["deepseek-minimax"], options = {}) {
  const sessionDir = join(runtimeDir, session.id);
  const packs = {};
  for (const engine of engines) {
    packs[engine] = await generatePack(session, { engine, guideIds: options.guideIds, writeDefaultManifest: false, forceFresh: options.forceFresh === true });
  }
  const guideIds = [...new Set(engines.flatMap((engine) => Object.keys(packs[engine]?.guides || {})))];
  const guides = Object.fromEntries(
    guideIds.map((guideId) => [
      guideId,
      Object.fromEntries(engines.map((engine) => [engine, packs[engine]?.guides?.[guideId] || null]))
    ])
  );
  const comparison = {
    generatedAt: new Date().toISOString(),
    sessionId: session.id,
    engines,
    packs,
    guides
  };
  const suffix = options.guideIds?.length ? `-${options.guideIds.map(safeId).join("-")}` : "";
  writeFileSync(join(sessionDir, `manifest-compare${suffix}.json`), JSON.stringify(comparison, null, 2));
  return comparison;
}

function sessionPath(sessionId) {
  return join(runtimeDir, sessionId, "session.json");
}

function loadSession(sessionId) {
  return JSON.parse(readFileSync(sessionPath(sessionId), "utf8"));
}

function runtimeDiagnostics() {
  const requestedEngine = (process.env.TTS_ENGINE || "deepseek-minimax").toLowerCase();
  const requiredByEngine = {
    "volc-podcast": ["DEEPSEEK_API_KEY", "VOLC_VOICE_API_KEY", "VOLC_PODCAST_APP_ID", "VOLC_PODCAST_APP_KEY"],
    "deepseek-minimax": ["DEEPSEEK_API_KEY", "MINIMAX_API_KEY"],
    "deepseek-elevenlabs": ["DEEPSEEK_API_KEY", "ELEVENLABS_API_KEY"]
  };
  const engineKey = ["doubao", "doubao-podcast", "volc", "volc-tts"].includes(requestedEngine)
    ? "volc-podcast"
    : requestedEngine;
  const missing = (requiredByEngine[engineKey] || []).filter((key) => !envFirst([key]));
  const requestedCookies = envFirst(["YTDLP_COOKIES", "YOUTUBE_COOKIES"]);
  const usableCookies = configuredCookieFile();
  return {
    ok: !missing.length,
    engine: engineKey,
    missing,
    hasEnvFile: existsSync(join(root, ".env")),
    ytdlp: {
      bin: commands.ytdlp,
      cookiesConfigured: Boolean(requestedCookies),
      hasCookies: Boolean(usableCookies),
      cookiesPathValid: !requestedCookies || Boolean(usableCookies),
      cookiesFromBrowser: envFirst(["YTDLP_COOKIES_FROM_BROWSER", "YOUTUBE_COOKIES_FROM_BROWSER"]) || ""
    }
  };
}

async function handleApi(req, res, pathname, searchParams) {
  try {
    if (pathname === "/api/health" && req.method === "GET") {
      return jsonResponse(res, 200, runtimeDiagnostics());
    }

    if (pathname === "/api/search" && req.method === "GET") {
      const q = searchParams.get("q") || "";
      if (!q.trim()) return jsonResponse(res, 400, { error: "Missing query" });
      const raw = run(commands.ytdlp, [
        "--no-update",
        "--flat-playlist",
        ...ytdlpAuthArgs(),
        "-J",
        `ytsearch5:${q}`
      ], {
        capture: true,
        timeoutMs: Number(process.env.YTDLP_SEARCH_TIMEOUT_MS || 20000) || 20000
      });
      const data = JSON.parse(raw);
      const results = (data.entries || [])
        .filter((entry) => entry && (!entry.duration || Number(entry.duration) > MIN_SONG_SOURCE_SECONDS))
        .map((entry, index) => ({
        id: entry.id,
        title: entry.title || "Unknown title",
        artist: entry.uploader || entry.channel || "YouTube",
        uploader: entry.uploader || entry.channel || "YouTube",
        duration: entry.duration || null,
        durationLabel: entry.duration ? formatTime(entry.duration) : "未知",
        source: entry.channel_is_verified ? "YouTube verified result" : "YouTube result",
        confidence: index === 0 ? "高" : "候选",
        url: entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
        thumbnail: entry.thumbnails?.at(-1)?.url || ""
      }));
      return jsonResponse(res, 200, { results });
    }

    if (pathname === "/api/confirm" && req.method === "POST") {
      const body = await readJson(req);
      const url = body.url || (body.id ? `https://www.youtube.com/watch?v=${body.id}` : "");
      if (!url) return jsonResponse(res, 400, { error: "Missing YouTube URL" });
      let info;
      let warning = "";
      try {
        info = getInfo(url);
      } catch (error) {
        warning = error.message;
        console.warn(`YouTube metadata unavailable; continuing with search metadata: ${error.message}`);
        info = metadataOnlyInfo(body, url, error.message);
      }
      if (Number(info.duration || 0) && Number(info.duration || 0) <= MIN_SONG_SOURCE_SECONDS) {
        return jsonResponse(res, 400, { error: `歌曲时长需要长于 ${MIN_SONG_SOURCE_SECONDS} 秒。` });
      }
      const { artist, title } = parseArtistTitle(info);
      const videoId = info.id || body.id || safeId(url);
      const genreResult = await inferGenresWithMusicBrainz(info, { artist, title });
      const genres = genreResult.genres;
      let sourceFile = "";
      let sourceDuration = Number(info.duration || body.duration || 0) || 0;
      if (!warning) {
        try {
          sourceFile = downloadAudio(info.webpage_url || url, `selected-${videoId}`);
          sourceDuration = Number(info.duration || 0) || getDuration(sourceFile);
        } catch (error) {
          warning = error.message;
          console.warn(`YouTube audio download unavailable; continuing without theme audio: ${error.message}`);
        }
      }
      if (sourceFile && sourceDuration <= MIN_SONG_SOURCE_SECONDS) {
        return jsonResponse(res, 400, { error: `歌曲时长需要长于 ${MIN_SONG_SOURCE_SECONDS} 秒。` });
      }
      const sessionId = `${safeId(videoId)}-${Date.now().toString(36)}`;
      const sessionDir = join(runtimeDir, sessionId);
      mkdirSync(sessionDir, { recursive: true });
      const song = {
        title,
        artist,
        year: info.release_year || String(info.upload_date || "").slice(0, 4) || "未知",
        bpm: "metadata",
        key: "auto",
        region: info.uploader || info.channel || "YouTube",
        source: `${genreResult.source} + yt-dlp audio`,
        videoId,
        youtubeUrl: info.webpage_url || url,
        confidence: genreResult.confidence,
        genres,
        summary: `已真实匹配 YouTube：${artist} - ${title}。音频已下载，并通过 ${genreResult.source} 映射到 ${genreRoute(genres)} 节点。`,
        duration: sourceDuration,
        sourceFile,
        genreEvidence: genreResult.musicBrainz?.evidence || []
      };
      song.sessionId = sessionId;
      song.audioAvailable = Boolean(sourceFile);
      if (warning) {
        song.warning = warning;
        song.source = `${genreResult.source} + metadata-only`;
        song.summary = `Matched ${artist} - ${title} from search metadata. YouTube audio was not available on this machine, so the radio workspace opens first and sampling should use preview/fallback sources.`;
      }
      const session = { id: sessionId, song, info, genreResult, warning };
      writeFileSync(sessionPath(sessionId), JSON.stringify(session, null, 2));
      return jsonResponse(res, 200, { song: { ...song, sourceFile: undefined, sessionId }, sessionId, warning });
    }

    if (pathname === "/api/script" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.sessionId) return jsonResponse(res, 400, { error: "Missing sessionId" });
      const session = loadSession(body.sessionId);
      const manifest = await generateScriptPack(session, { forceFresh: body.forceFresh === true, guideIds: body.guideIds });
      return jsonResponse(res, 200, { pack: manifest });
    }

    if (pathname === "/api/generate" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.sessionId) return jsonResponse(res, 400, { error: "Missing sessionId" });
      const session = loadSession(body.sessionId);
      if (body.compare) {
        const engine = process.env.TTS_ENGINE || body.engine || undefined;
        const comparison = await generateComparePack(session, [engine || "deepseek-minimax"], { forceFresh: true });
        return jsonResponse(res, 200, { comparison, pack: Object.values(comparison.packs)[0] });
      }
      const manifest = await generatePack(session, {
        engine: process.env.TTS_ENGINE || body.engine || undefined,
        guideIds: body.guideIds,
        forceFresh: body.forceFresh === true,
        refreshSamplePool: body.refreshSamplePool === true
      });
      return jsonResponse(res, 200, { pack: manifest });
    }

    if (pathname === "/api/sample-pool" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.sessionId) return jsonResponse(res, 400, { error: "Missing sessionId" });
      const session = loadSession(body.sessionId);
      const sessionDir = join(runtimeDir, session.id);
      const workDir = join(sessionDir, `work-${currentTtsEngine(body.engine)}`);
      mkdirSync(workDir, { recursive: true });
      const pool = buildSamplePool(session, workDir, {
        forceFresh: body.forceFresh === true,
        target: body.target,
        maxCandidates: body.maxCandidates
      });
      return jsonResponse(res, 200, { pool });
    }

    return jsonResponse(res, 404, { error: "Unknown API route" });
  } catch (error) {
    console.error(error);
    return jsonResponse(res, 500, { error: error.message });
  }
}

function serveStatic(req, res, pathname) {
  const relative = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const file = resolve(root, `.${relative}`);
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml"
  }[extname(file)] || "application/octet-stream";
  res.writeHead(200, { "content-type": mime });
  res.end(readFileSync(file));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname.startsWith("/api/")) {
      handleApi(req, res, url.pathname, url.searchParams);
      return;
    }
    serveStatic(req, res, url.pathname);
  }).listen(port, "127.0.0.1", () => {
    console.log(`Music map prototype server running at http://127.0.0.1:${port}/index.html`);
  });
}

export {
  generateComparePack,
  generatePack,
  buildGuides,
  buildSamplePool,
  chooseGuideClipPlan,
  cleanSongTitleForSpeech,
  clipIdentity,
  ensureDownloadableGuideClipPlan,
  genreName,
  genreRoute,
  inferGenres,
  isThemeClip,
  loadSession,
  loadUniverseGenres,
  sessionPath
};

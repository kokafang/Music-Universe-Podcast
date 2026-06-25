import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceUrl = "https://everynoise.com/engenremap.html";
const outputPath = join(root, "assets", "data", "every-noise-genres.json");

const familyRules = [
  ["hiphop", /\b(hip hop|rap|drill|grime|phonk|boom bap|trap|plugg|crunk)\b/i],
  ["trap", /\btrap\b/i],
  ["metal", /\b(metal|thrash|doom|black metal|death metal|grindcore|metalcore)\b/i],
  ["punk", /\b(punk|emo|screamo|hardcore)\b/i],
  ["rock", /\b(rock|grunge|shoegaze|britpop|garage|psychedelic|indie)\b/i],
  ["electronic", /\b(electronic|electronica|edm|dance|trance|dubstep|brostep|breakbeat|idm|hyperpop)\b/i],
  ["house", /\bhouse\b/i],
  ["techno", /\btechno\b/i],
  ["ambient", /\b(ambient|drone|sleep|noise|downtempo|chill|lo-fi|healing)\b/i],
  ["disco", /\bdisco\b/i],
  ["funk", /\bfunk\b/i],
  ["soul", /\b(soul|motown)\b/i],
  ["rnb", /\b(r&b|rnb|quiet storm|urban contemporary)\b/i],
  ["jazz", /\b(jazz|bebop|swing|ragtime)\b/i],
  ["blues", /\bblues\b/i],
  ["reggae", /\b(reggae|dub|ska|dancehall)\b/i],
  ["latin", /\b(latin|reggaeton|salsa|bachata|cumbia|bolero|mariachi|bossa|tropical)\b/i],
  ["afrobeat", /\b(afro|afrobeats|amapiano|azonto|soukous|highlife)\b/i],
  ["country", /\b(country|americana|bluegrass|nashville|honky)\b/i],
  ["folk", /\b(folk|singer-songwriter|acoustic|roots)\b/i],
  ["gospel", /\b(gospel|worship|ccm|christian)\b/i],
  ["classical", /\b(classical|orchestra|orchestral|opera|choral|baroque|romantic)\b/i],
  ["mandopop", /\b(mandopop|taiwan|chinese|c-pop|zhongguo)\b/i],
  ["cantopop", /\b(cantopop|hong kong)\b/i],
  ["cpop", /\b(cpop|k-pop|j-pop|j-rock|anime|opm|v-pop|thai pop|indonesian pop)\b/i],
  ["artpop", /\b(art pop|dream pop|chamber pop|baroque pop|sophisti-pop)\b/i],
  ["popballad", /\b(ballad|adult standards|easy listening|mellow gold|soft pop)\b/i],
  ["synthpop", /\b(synth|new wave|electropop)\b/i]
];

const familyNames = familyRules.map(([family]) => family);

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&raquo;/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function safeId(value) {
  const normalized = decodeEntities(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "genre";
}

function extractStyleNumber(style, key) {
  const match = style.match(new RegExp(`${key}\\s*:\\s*([\\d.]+)px`, "i"));
  return match ? Number(match[1]) : 0;
}

function extractStylePercent(style, key) {
  const match = style.match(new RegExp(`${key}\\s*:\\s*([\\d.]+)%`, "i"));
  return match ? Number(match[1]) : 100;
}

function extractStyleColor(style) {
  const match = style.match(/color\s*:\s*(#[0-9a-f]{6})/i);
  return match ? match[1] : "#8f8f8f";
}

function hashNumber(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function fallbackFamily(name) {
  return familyNames[hashNumber(name) % familyNames.length];
}

function genreFamily(name) {
  for (const [family, pattern] of familyRules) {
    if (pattern.test(name)) return family;
  }
  return fallbackFamily(name);
}

function sourcePosition(genre, bounds) {
  const xNorm = (genre.sourceX - bounds.minX) / Math.max(bounds.maxX - bounds.minX, 1);
  const yNorm = (genre.sourceY - bounds.minY) / Math.max(bounds.maxY - bounds.minY, 1);
  const safeY = Math.max(0.015, Math.min(0.985, yNorm));
  const lat = Math.asin(1 - 2 * safeY) * (180 / Math.PI);
  const lon = xNorm * 360 - 180;
  return {
    lat: Math.round(lat * 100) / 100,
    lon: Math.round((((lon + 180) % 360) - 180) * 100) / 100
  };
}

function nameTokens(name) {
  const stop = new Set(["and", "the", "of", "pop", "music", "modern", "classic", "traditional"]);
  return new Set(
    name
      .toLowerCase()
      .replace(/&/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !stop.has(word))
  );
}

function sharedTokenCount(a, b) {
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count += 1;
  }
  return count;
}

function attachRelatedGenres(genres, bounds, relatedCount = 4) {
  const spanX = Math.max(bounds.maxX - bounds.minX, 1);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1);
  const tokens = new Map(genres.map((genre) => [genre.id, nameTokens(genre.name)]));

  genres.forEach((genre, index) => {
    const candidates = [];
    for (let otherIndex = 0; otherIndex < genres.length; otherIndex += 1) {
      if (otherIndex === index) continue;
      const other = genres[otherIndex];
      const dx = (genre.sourceX - other.sourceX) / spanX;
      const dy = (genre.sourceY - other.sourceY) / spanY;
      const shared = sharedTokenCount(tokens.get(genre.id), tokens.get(other.id));
      const familyFactor = genre.family === other.family ? 0.86 : 1;
      const nameFactor = shared > 0 ? 0.78 : 1;
      candidates.push({
        id: other.id,
        score: Math.hypot(dx, dy) * familyFactor * nameFactor
      });
    }
    genre.relatedTo = candidates
      .sort((a, b) => a.score - b.score)
      .slice(0, relatedCount)
      .map((candidate) => candidate.id);
  });
  return genres;
}

function parseGenres(html) {
  const pattern =
    /<div\s+id=item(\d+)\b([^>]*)class="genre[^"]*"([^>]*)style="([^"]+)"([^>]*)>([\s\S]*?)<a\s+class=navlink\b/gi;
  const raw = [];
  let match;

  while ((match = pattern.exec(html))) {
    const attrs = `${match[2]} ${match[3]} ${match[5]}`;
    const style = match[4];
    const name = decodeEntities(match[6].replace(/<[^>]+>/g, "").trim());
    if (!name) continue;
    const title = attrs.match(/\btitle="([^"]+)"/i)?.[1] || "";
    const href = match[0].match(/href="([^"]+)"/i)?.[1] || "";
    raw.push({
      sourceRank: Number(match[1]),
      id: safeId(name),
      name,
      sample: decodeEntities(title.replace(/^e\.g\.\s*/i, "")),
      sourceUrl: href ? `https://everynoise.com/${href}` : sourceUrl,
      sourceColor: extractStyleColor(style),
      sourceX: extractStyleNumber(style, "left"),
      sourceY: extractStyleNumber(style, "top"),
      sourceSize: extractStylePercent(style, "font-size")
    });
  }

  const bounds = {
    minX: Math.min(...raw.map((genre) => genre.sourceX)),
    maxX: Math.max(...raw.map((genre) => genre.sourceX)),
    minY: Math.min(...raw.map((genre) => genre.sourceY)),
    maxY: Math.max(...raw.map((genre) => genre.sourceY))
  };
  const seen = new Map();

  const genres = raw.map((genre) => {
    const baseId = genre.id;
    const count = seen.get(baseId) || 0;
    seen.set(baseId, count + 1);
    const id = count ? `${baseId}-${count + 1}` : baseId;
    const family = genreFamily(genre.name);
    const position = sourcePosition(genre, bounds);
    return {
      ...genre,
      id,
      aliases: id === baseId ? [genre.name.toLowerCase()] : [genre.name.toLowerCase(), baseId],
      family,
      era: "Every Noise",
      region: "Every Noise at Once",
      tags: genre.sample ? [genre.sample] : [],
      lon: position.lon,
      lat: position.lat,
      importance: Math.round((1 / Math.max(genre.sourceRank, 1)) * 1000000) / 1000000
    };
  });

  return attachRelatedGenres(genres, bounds);
}

async function main() {
  let html;
  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    html = await response.text();
  } catch (error) {
    const fallback = "/tmp/engenremap.html";
    html = await readFile(fallback, "utf8");
    console.warn(`Fetch failed (${error.message}); used ${fallback}.`);
  }

  const genres = parseGenres(html);
  if (genres.length < 1000) throw new Error(`Parsed only ${genres.length} genres; source format may have changed.`);

  const payload = {
    source: sourceUrl,
    generatedAt: new Date().toISOString(),
    count: genres.length,
    genres
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${genres.length} Every Noise genres to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

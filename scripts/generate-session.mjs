#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { generateComparePack, generatePack, genreRoute, inferGenres, loadSession, sessionPath } from "../server.mjs";

const args = process.argv.slice(2);
const sessionId = args.find((arg) => !arg.startsWith("--"));
if (!sessionId) {
  console.error("Usage: node scripts/generate-session.mjs <session-id> [--engine deepseek-elevenlabs|deepseek-minimax|gpt-sovits|fish|cosyvoice] [--compare] [--guide song|map|history]");
  process.exit(1);
}
const compare = args.includes("--compare");
const engineArgIndex = args.indexOf("--engine");
const engine = engineArgIndex >= 0 ? args[engineArgIndex + 1] : undefined;
const guideArgIndex = args.indexOf("--guide");
const guide = guideArgIndex >= 0 ? args[guideArgIndex + 1] : undefined;
const guideIds = guide ? [guide] : undefined;

const session = loadSession(sessionId);
if (session.info) {
  const genres = inferGenres(session.info);
  session.song.genres = genres;
  session.song.summary = `已真实匹配 YouTube：${session.song.artist} - ${session.song.title}。音频已下载，并映射到 ${genreRoute(genres)} 节点。`;
  writeFileSync(sessionPath(sessionId), JSON.stringify(session, null, 2));
}

function summarizePack(pack) {
  return Object.fromEntries(Object.entries(pack.guides).map(([id, guide]) => [
    id,
    {
      title: guide.title,
      audioUrl: guide.audioUrl,
      scriptUrl: guide.scriptUrl,
      durationLabel: guide.durationLabel,
      refs: guide.refs.map((ref) => `${ref.artist} - ${ref.title}`)
    }
  ]));
}

if (compare) {
  const comparison = await generateComparePack(session, undefined, { guideIds });
  const summary = Object.fromEntries(
    Object.entries(comparison.packs).map(([packEngine, pack]) => [packEngine, {
      tts: pack.tts,
      guides: summarizePack(pack)
    }])
  );
  const suffix = guide ? `-${guide}` : "";
  console.log(JSON.stringify({ sessionId, comparisonManifest: `assets/runtime/${sessionId}/manifest-compare${suffix}.json`, packs: summary }, null, 2));
  process.exit(0);
}

const pack = await generatePack(session, { engine, guideIds });
const summary = summarizePack(pack);

console.log(JSON.stringify({ sessionId, tts: pack.tts, guides: summary }, null, 2));

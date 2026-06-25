#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "assets", "runtime", "eleven-voice-design");
mkdirSync(outDir, { recursive: true });

function loadDotEnv() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return {};
  const env = {};
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function fetchJson(url, options, label) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${text.slice(0, 700)}`);
  }
  return JSON.parse(text);
}

async function createDesignedVoice({ key, name, description, gender }) {
  const text =
    "你好，欢迎来到音乐宇宙。今天我们会用比较轻松的方式，认真听一首歌的旋律、编曲、歌词和时代气息。声音不需要夸张，要像真实播客里的人在聊天，清楚、自然、有一点微笑，也保留一点思考的停顿。我们会先听主歌怎么铺开，再听副歌为什么没有用力过猛，最后把它放回中文流行音乐的历史现场里。";
  const design = await fetchJson("https://api.elevenlabs.io/v1/text-to-voice/design?output_format=mp3_44100_128", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "xi-api-key": key
    },
    body: JSON.stringify({
      voice_description: description,
      model_id: "eleven_multilingual_ttv_v2",
      text,
      loudness: 0.35,
      guidance_scale: 8,
      seed: gender === "female" ? 31817 : 49211
    })
  }, `ElevenLabs voice design ${name}`);

  const preview = design.previews?.[0];
  if (!preview?.generated_voice_id) {
    throw new Error(`ElevenLabs voice design ${name} returned no generated_voice_id.`);
  }
  if (preview.audio_base_64) {
    writeFileSync(join(outDir, `${name}.preview.mp3`), Buffer.from(preview.audio_base_64, "base64"));
  }

  const created = await fetchJson("https://api.elevenlabs.io/v1/text-to-voice", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "xi-api-key": key
    },
    body: JSON.stringify({
      voice_name: name,
      voice_description: description,
      generated_voice_id: preview.generated_voice_id,
      labels: {
        gender,
        language: "zh",
        accent: "Mandarin Chinese",
        use_case: "podcast"
      }
    })
  }, `ElevenLabs create voice ${name}`);

  return {
    name,
    gender,
    voice_id: created.voice_id,
    category: created.category,
    preview: join(outDir, `${name}.preview.mp3`)
  };
}

const env = loadDotEnv();
const key = env.ELEVENLABS_API_KEY || env.ELEVEN_API_KEY;
if (!key) throw new Error("Missing ELEVENLABS_API_KEY in .env");

const female = await createDesignedVoice({
  key,
  name: "music-universe-cn-female-expert",
  gender: "female",
  description:
    "A natural Mandarin Chinese female podcast host, early thirties, warm but precise, knowledgeable music critic, relaxed conversational pacing, clear pronunciation, elegant timbre, not theatrical."
});
const male = await createDesignedVoice({
  key,
  name: "music-universe-cn-male-newbie",
  gender: "male",
  description:
    "A natural Mandarin Chinese male podcast co-host, late twenties, curious beginner, friendly and casual, compact conversational pacing, clear pronunciation, bright but not childish, asks sincere questions."
});

const result = { female, male };
writeFileSync(join(outDir, "voices.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

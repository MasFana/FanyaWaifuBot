import { z } from "zod";
import type { OutboundMedia, ToolDefinition } from "../core/types.js";

// ponytail: btch backend is fixed and public; no config knob until it moves.
const baseUrl = "https://backend1.tioo.eu.org";
const clientVersion = "6.4.0";

const mediaFailureMessage = "Gagal membuka atau mengambil media dari tautan tersebut saat ini. Beri tahu pacarmu secara natural (tanpa menyebut kode error atau kata 'server downloader') bahwa videonya lagi nggak mau kebuka dari tempatmu, lalu tanyakan isi videonya tentang apa.";

const endpoints: Record<Platform, string> = {
  youtube: "youtube", tiktok: "ttdl", instagram: "igdl", facebook: "fbdown",
  twitter: "twitter", spotify: "spotify", soundcloud: "soundcloud",
  threads: "threads", kuaishou: "kuaishou", pinterest: "pinterest",
  douyin: "douyin", snackvideo: "snackvideo", cocofun: "cocofun",
  rednote: "rednote", capcut: "capcut", gdrive: "gdrive",
};

export type Platform =
  | "youtube" | "tiktok" | "instagram" | "facebook" | "twitter" | "spotify"
  | "soundcloud" | "threads" | "kuaishou" | "pinterest" | "douyin"
  | "snackvideo" | "cocofun" | "rednote" | "capcut" | "gdrive";

const hosts: ReadonlyArray<readonly [string, Platform]> = [
  ["music.youtube.com", "youtube"], ["youtube.com", "youtube"], ["youtu.be", "youtube"],
  ["vm.tiktok.com", "tiktok"], ["vt.tiktok.com", "tiktok"], ["tiktok.com", "tiktok"],
  ["instagram.com", "instagram"],
  ["fb.watch", "facebook"], ["fb.com", "facebook"], ["facebook.com", "facebook"],
  ["twitter.com", "twitter"], ["x.com", "twitter"],
  ["open.spotify.com", "spotify"], ["spotify.com", "spotify"], ["spotify.link", "spotify"],
  ["soundcloud.com", "soundcloud"],
  ["threads.net", "threads"], ["threads.com", "threads"],
  ["kuaishou.com", "kuaishou"],
  ["pinterest.com", "pinterest"], ["pin.it", "pinterest"],
  ["douyin.com", "douyin"],
  ["snackvideo.com", "snackvideo"],
  ["icocofun.com", "cocofun"], ["cocofun.com", "cocofun"],
  ["xiaohongshu.com", "rednote"], ["xhslink.com", "rednote"],
  ["capcut.com", "capcut"],
  ["drive.google.com", "gdrive"],
];

export function detectPlatform(url: string): Platform | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const [suffix, platform] of hosts) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return platform;
  }
  return undefined;
}

export function extractMedia(platform: Platform, payload: unknown, audio: boolean): OutboundMedia[] {
  if (platform === "instagram") return instagramMedia(payload);
  const root = asRecord(payload);
  // The raw backend is inconsistent: some platforms nest under result/data/res_data, others are flat.
  const body = asRecord(root["res_data"] ?? root["result"] ?? root["data"] ?? root);
  switch (platform) {
    case "youtube": {
      const url = text(audio ? body["mp3"] : body["mp4"]);
      if (!url) return [];
      return [media(audio ? "audio" : "video", url, label(text(body["title"]), text(body["author"])))];
    }
    case "tiktok": {
      const caption = text(body["title"]);
      return strings(asArray(audio ? body["audio"] : body["video"])).map((url) => media(audio ? "audio" : "video", url, caption));
    }
    case "facebook": {
      const url = text(body["HD"]) ?? text(body["Normal_video"]);
      return url ? [media("video", url)] : [];
    }
    case "twitter": {
      const url = twitterUrl(root["url"]);
      return url ? [media("video", url, text(body["title"]))] : [];
    }
    case "spotify": {
      const url = text(asRecord(asArray(body["formats"])[0])["url"]);
      return url ? [media("audio", url, text(body["title"]))] : [];
    }
    case "soundcloud": {
      const url = text(body["downloadMp3"]) ?? text(body["audio"]);
      return url ? [media("audio", url, text(body["title"]))] : [];
    }
    case "threads": {
      const video = text(body["video"]);
      if (video) return [media("video", video)];
      const image = text(body["image"]);
      return image ? [media("photo", image)] : [];
    }
    case "kuaishou": {
      const url = text(body["videoUrl"]);
      return url ? [media("video", url, text(body["title"]))] : [];
    }
    case "pinterest": {
      const caption = text(body["title"]);
      const video = text(body["video_url"]);
      if (video) return [media("video", video, caption)];
      const image = text(body["image"]) ?? firstImageUrl(body["images"]);
      return image ? [media("photo", image, caption)] : [];
    }
    case "douyin": {
      const caption = text(body["title"]);
      return strings(asArray(body["links"]).map((link) => asRecord(link)["url"])).map((url) => media("video", url, caption));
    }
    case "snackvideo": {
      const url = text(body["videoUrl"]);
      return url ? [media("video", url, text(body["title"]))] : [];
    }
    case "cocofun": {
      const url = text(body["no_watermark"]) ?? text(body["watermark"]);
      return url ? [media("video", url, text(body["caption"]))] : [];
    }
    case "rednote": {
      const caption = text(body["title"]);
      const downloads = strings(asArray(body["downloads"]).map((item) => asRecord(item)["url"]));
      if (downloads.length > 0) return downloads.map((url) => media("video", url, caption));
      return strings(asArray(body["images"])).map((url) => media("photo", url, caption));
    }
    case "capcut": {
      const url = text(body["originalVideoUrl"]);
      return url ? [media("video", url, text(body["title"]))] : [];
    }
    case "gdrive": {
      const url = text(body["downloadUrl"]);
      return url ? [media("document", url, text(body["filename"]))] : [];
    }
    default:
      return [];
  }
}

function instagramMedia(payload: unknown): OutboundMedia[] {
  if (!Array.isArray(payload)) return [];
  return strings(payload.map((item) => asRecord(item)["url"])).map((url) => media(kindForUrl(url), url));
}

function twitterUrl(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const record = asRecord(entry);
      const url = text(record["hd"]) ?? text(record["sd"]) ?? text(record["url"]);
      if (url !== undefined) return url;
    }
    return undefined;
  }
  return text(value);
}

function firstImageUrl(images: unknown): string | undefined {
  const record = asRecord(images);
  for (const value of Object.values(record)) {
    const url = text(asRecord(value)["url"]) ?? text(value);
    if (url !== undefined) return url;
  }
  return undefined;
}

function media(kind: OutboundMedia["kind"], url: string, caption?: string): OutboundMedia {
  return caption === undefined ? { kind, url } : { kind, url, caption };
}

function label(title: string | undefined, author: string | undefined): string | undefined {
  if (title && author) return `${title} — ${author}`;
  return title ?? author;
}

function kindForUrl(url: string): OutboundMedia["kind"] {
  return /\.(jpe?g|png|webp|gif|avif)(?:$|[?#])/i.test(url) ? "photo" : "video";
}

function strings(values: readonly unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const value_ = text(value);
    if (value_ !== undefined) result.push(value_);
  }
  return result;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function fetchMedia(platform: Platform, url: string): Promise<unknown> {
  try {
    const response = await fetch(`${baseUrl}/${endpoints[platform]}?url=${encodeURIComponent(url)}`, {
      headers: {
        "content-type": "application/json",
        "user-agent": `btch/${clientVersion}`,
        "x-client-version": clientVersion,
      },
    });
    if (!response.ok) throw new Error(mediaFailureMessage);
    return await response.json();
  } catch {
    throw new Error(mediaFailureMessage);
  }
}

function normalizeLink(link: string): string {
  const short = /^https?:\/\/youtu\.be\/([\w-]+)/iu.exec(link);
  if (short?.[1]) return `https://www.youtube.com/watch?v=${short[1]}`;
  const shorts = /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/([\w-]+)/iu.exec(link);
  if (shorts?.[1]) return `https://www.youtube.com/watch?v=${shorts[1]}`;
  return link;
}

const tool: ToolDefinition = {
  name: "download_media",
  description: "Download media (video, audio, photos) from a social or file link and send it to the owner. Set audio=true to get only the song/audio track (e.g. YouTube to MP3).",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The media link (YouTube, TikTok, Instagram, Facebook, X, Spotify, SoundCloud, Threads, Pinterest, Douyin, SnackVideo, CapCut, Google Drive, etc.)." },
      audio: { type: "boolean", description: "When true, send only the audio track instead of video." },
    },
    required: ["url"],
    additionalProperties: false,
  },
  argumentSchema: z.object({ url: z.string().url(), audio: z.boolean().optional() }).strict(),
  async execute(arguments_, context) {
    const parsed = z.object({ url: z.string(), audio: z.boolean().optional() }).parse(arguments_);
    const platform = detectPlatform(parsed.url);
    if (platform === undefined) throw new Error("Tautan itu tidak dikenali sebagai sumber media yang bisa kuunduh. Beri tahu pacarmu secara natural, tanpa istilah teknis, bahwa kamu nggak bisa mengunduh dari tautan itu.");
    const payload = await fetchMedia(platform, normalizeLink(parsed.url));
    const items = extractMedia(platform, payload, parsed.audio ?? false);
    if (items.length === 0) throw new Error(mediaFailureMessage);
    let sent = 0;
    const links: string[] = [];
    for (const item of items) {
      const delivery = context.sendMedia ? await context.sendMedia(item) : "link";
      if (delivery === "media") sent += 1;
      else links.push(item.url);
    }
    return { platform, sent, links };
  },
};

export default tool;


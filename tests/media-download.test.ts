import assert from "node:assert/strict";
import test from "node:test";
import type { OutboundMedia } from "../src/core/types.js";
import downloadMedia, { detectPlatform, extractMedia } from "../src/tools/media-download.js";

test("detectPlatform maps supported hosts to platform keys and rejects the rest", () => {
  assert.equal(detectPlatform("https://youtu.be/C8mJ8943X80"), "youtube");
  assert.equal(detectPlatform("https://www.youtube.com/watch?v=x"), "youtube");
  assert.equal(detectPlatform("https://www.tiktok.com/@a/video/1"), "tiktok");
  assert.equal(detectPlatform("https://www.instagram.com/reel/ABC/?x=1"), "instagram");
  assert.equal(detectPlatform("https://open.spotify.com/track/x"), "spotify");
  assert.equal(detectPlatform("https://example.com/watch"), undefined);
});

test("extractMedia picks youtube mp3 for audio mode and mp4 otherwise", () => {
  const payload = { status: true, title: "Lagu", author: "Penyanyi", mp3: "https://cdn/a.mp3", mp4: "https://cdn/a.mp4" };

  assert.deepEqual(extractMedia("youtube", payload, true), [{ kind: "audio", url: "https://cdn/a.mp3", caption: "Lagu — Penyanyi" }]);
  assert.deepEqual(extractMedia("youtube", payload, false), [{ kind: "video", url: "https://cdn/a.mp4", caption: "Lagu — Penyanyi" }]);
});

test("extractMedia reads the raw instagram array and the tiktok video/audio", () => {
  const instagram = [{ status: true, creator: "@x", thumbnail: "t", url: "https://cdn/1.mp4" }, { status: true, url: "https://cdn/2.jpg" }];
  const instagramMedia = extractMedia("instagram", instagram, false);
  assert.deepEqual(instagramMedia.map((media) => media.url), ["https://cdn/1.mp4", "https://cdn/2.jpg"]);
  assert.deepEqual(instagramMedia.map((media) => media.kind), ["video", "photo"]);

  const tiktok = { status: true, title: "T", video: ["https://cdn/v.mp4"], audio: ["https://cdn/a.mp3"] };
  assert.deepEqual(extractMedia("tiktok", tiktok, false), [{ kind: "video", url: "https://cdn/v.mp4", caption: "T" }]);
  assert.deepEqual(extractMedia("tiktok", tiktok, true), [{ kind: "audio", url: "https://cdn/a.mp3", caption: "T" }]);
});

test("extractMedia reads flat single-link platform responses", () => {
  assert.deepEqual(extractMedia("facebook", { status: true, HD: "https://cdn/hd.mp4", Normal_video: "https://cdn/sd.mp4" }, false), [{ kind: "video", url: "https://cdn/hd.mp4" }]);
  assert.deepEqual(extractMedia("kuaishou", { success: true, videoUrl: "https://cdn/k.mp4", title: "K" }, false), [{ kind: "video", url: "https://cdn/k.mp4", caption: "K" }]);
  assert.deepEqual(extractMedia("capcut", { status: true, title: "Cap", originalVideoUrl: "https://cdn/c.mp4" }, false), [{ kind: "video", url: "https://cdn/c.mp4", caption: "Cap" }]);
  assert.deepEqual(extractMedia("soundcloud", { status: true, title: "S", downloadMp3: "https://cdn/s.mp3", audio: "" }, false), [{ kind: "audio", url: "https://cdn/s.mp3", caption: "S" }]);
});

test("extractMedia reads twitter's url array, gdrive data, and spotify res_data", () => {
  const twitter = { status: true, title: "tw", url: [{ hd: "https://cdn/hd.mp4" }, { sd: "https://cdn/sd.mp4" }] };
  assert.deepEqual(extractMedia("twitter", twitter, false), [{ kind: "video", url: "https://cdn/hd.mp4", caption: "tw" }]);

  const gdrive = { success: true, data: { filename: "f.pdf", downloadUrl: "https://cdn/d" } };
  assert.deepEqual(extractMedia("gdrive", gdrive, false), [{ kind: "document", url: "https://cdn/d", caption: "f.pdf" }]);

  const spotify = { status: true, res_data: { title: "P", formats: [{ url: "https://cdn/p.mp3" }] } };
  assert.deepEqual(extractMedia("spotify", spotify, false), [{ kind: "audio", url: "https://cdn/p.mp3", caption: "P" }]);
});

test("extractMedia reads nested and multi-item platform responses", () => {
  assert.deepEqual(extractMedia("threads", { status: true, type: "image", image: "https://cdn/th.webp" }, false), [{ kind: "photo", url: "https://cdn/th.webp" }]);
  assert.deepEqual(extractMedia("threads", { status: true, type: "video", video: "https://cdn/th.mp4", image: "https://cdn/th.jpg" }, false), [{ kind: "video", url: "https://cdn/th.mp4" }]);
  assert.deepEqual(extractMedia("pinterest", { success: true, result: { title: "Pin", image: "https://cdn/p.jpg" } }, false), [{ kind: "photo", url: "https://cdn/p.jpg", caption: "Pin" }]);
  assert.deepEqual(extractMedia("douyin", { status: true, data: { title: "D", links: [{ url: "https://cdn/d1.mp4" }, { url: "https://cdn/d2.mp4" }] } }, false), [{ kind: "video", url: "https://cdn/d1.mp4", caption: "D" }, { kind: "video", url: "https://cdn/d2.mp4", caption: "D" }]);
  assert.deepEqual(extractMedia("rednote", { status: true, result: { title: "R", downloads: [{ url: "https://cdn/r.mp4" }], images: ["https://cdn/r.jpg"] } }, false), [{ kind: "video", url: "https://cdn/r.mp4", caption: "R" }]);
  assert.deepEqual(extractMedia("cocofun", { status: true, caption: "C", watermark: "https://cdn/wm.mp4", no_watermark: "https://cdn/nowm.mp4" }, false), [{ kind: "video", url: "https://cdn/nowm.mp4", caption: "C" }]);
});

test("extractMedia returns an empty list for error or media-less payloads", () => {
  assert.deepEqual(extractMedia("youtube", { status: false, error: "failed" }, false), []);
  assert.deepEqual(extractMedia("instagram", [], false), []);
  assert.deepEqual(extractMedia("instagram", "Request Failed With Code 401", false), []);
});

test("download_media fetches the platform endpoint and sends each extracted item", async () => {
  const sent: OutboundMedia[] = [];
  const calls: string[] = [];
  const restore = stubFetch(calls, { status: true, title: "Song", author: "A", mp3: "https://cdn/a.mp3", mp4: "https://cdn/a.mp4" });
  const context = { userId: "u", sendMedia: async (media: OutboundMedia) => { sent.push(media); return "media" as const; } };
  try {
    const result = await downloadMedia.execute({ url: "https://youtu.be/x", audio: true }, context);

    assert.match(calls[0] ?? "", /^https:\/\/backend1\.tioo\.eu\.org\/youtube\?url=https%3A%2F%2Fwww\.youtube\.com%2Fwatch%3Fv%3Dx$/u);
    assert.deepEqual(sent, [{ kind: "audio", url: "https://cdn/a.mp3", caption: "Song — A" }]);
    assert.deepEqual(result, { platform: "youtube", sent: 1, links: [] });
  } finally {
    restore();
  }
});

test("download_media reports items that fall back to a text link", async () => {
  const restore = stubFetch([], [{ status: true, url: "https://cdn/1.mp4" }, { status: true, url: "https://cdn/2.jpg" }]);
  const context = { userId: "u", sendMedia: async () => "link" as const };
  try {
    const result = await downloadMedia.execute({ url: "https://www.instagram.com/reel/x/" }, context);

    assert.deepEqual(result, { platform: "instagram", sent: 0, links: ["https://cdn/1.mp4", "https://cdn/2.jpg"] });
  } finally {
    restore();
  }
});

test("download_media rejects unsupported and media-less links", async () => {
  await assert.rejects(downloadMedia.execute({ url: "https://example.com/watch" }, { userId: "u" }), /Unsupported link/u);

  const restore = stubFetch([], { status: false, error: "Failed to fetch" });
  try {
    await assert.rejects(downloadMedia.execute({ url: "https://youtu.be/x" }, { userId: "u" }), /Source error: Failed to fetch/u);
  } finally {
    restore();
  }
});

function stubFetch(calls: string[], payload: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    calls.push(String(input));
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}
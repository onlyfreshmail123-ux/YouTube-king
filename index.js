const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const YOINKU_API_KEY = process.env.YOINKU_API_KEY;
const YOINKU_BASE = "https://yoinku.com/api/v1";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

function isYoutubeUrl(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");

    if (host === "youtu.be") {
      return !!u.pathname.slice(1);
    }

    if (
      (host === "youtube.com" || host.endsWith(".youtube.com")) &&
      u.searchParams.get("v")
    ) {
      return true;
    }
  } catch (_) {}

  return false;
}

function pickFormat(formats, quality) {
  const videos = (formats || [])
    .filter(
      f =>
        f &&
        f.kind === "video" &&
        f.container === "mp4" &&
        f.hasVideo &&
        f.hasAudio
    )
    .map(f => ({
      ...f,
      heightNum: Number(f.height) || 0
    }))
    .filter(f => f.heightNum > 0)
    .sort((a, b) => b.heightNum - a.heightNum);

  if (!videos.length) {
    return null;
  }

  if (quality === "Best available") {
    return videos[0];
  }

  const wanted = Number(String(quality).replace("p", ""));

  if (!wanted) {
    return videos[0];
  }

  return (
    videos.find(f => f.heightNum === wanted) ||
    videos.find(f => f.heightNum < wanted) ||
    videos[videos.length - 1]
  );
}

async function yoinku(path, params) {
  const url = new URL(`${YOINKU_BASE}${path}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      "x-api-key": YOINKU_API_KEY
    }
  });

  const data = await response.json().catch(() => null);

  return {
    response,
    data
  };
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "GRAB IT backend",
    provider: "Yoinku"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    yoinkuConfigured: Boolean(YOINKU_API_KEY)
  });
});

app.get("/api/download", async (req, res) => {
  if (!YOINKU_API_KEY) {
    return res.status(500).json({
      error: "YOINKU_API_KEY is not configured in Railway."
    });
  }

  const url = String(req.query.url || "").trim();
  const quality = String(
    req.query.quality || "Best available"
  ).trim();

  if (!url || !isYoutubeUrl(url)) {
    return res.status(400).json({
      error: "Please provide a valid YouTube URL."
    });
  }

  try {
    const infoResult = await yoinku("/info", {
      url
    });

    if (
      !infoResult.response.ok ||
      !infoResult.data?.ok
    ) {
      return res.status(
        infoResult.response.status || 502
      ).json({
        error: "Yoinku info request failed",
        details:
          infoResult.data?.error ||
          "Unknown error"
      });
    }

    const format = pickFormat(
      infoResult.data.data?.formats,
      quality
    );

    if (!format?.id) {
      return res.status(422).json({
        error:
          "No compatible MP4 video format was returned by Yoinku."
      });
    }

    const downloadResult = await yoinku("/download", {
      url,
      format: format.id,
      redirect: "1"
    });

    if (
      downloadResult.response.status >= 300 &&
      downloadResult.response.status < 400
    ) {
      const location =
        downloadResult.response.headers.get("location");

      if (location) {
        return res.redirect(302, location);
      }
    }

    if (!downloadResult.response.ok) {
      return res.status(
        downloadResult.response.status || 502
      ).json({
        error: "Yoinku download request failed",
        details:
          downloadResult.data?.error ||
          "Unknown error"
      });
    }

    if (downloadResult.data?.url) {
      return res.redirect(
        302,
        downloadResult.data.url
      );
    }

    return res.status(502).json({
      error:
        "Yoinku did not return a download URL."
    });
  } catch (error) {
    console.error("Yoinku error:", error);

    return res.status(502).json({
      error: "Unable to contact Yoinku",
      details:
        error?.message || String(error)
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `GRAB IT backend running on port ${PORT}`
  );

  console.log(
    `Yoinku API key configured: ${
      YOINKU_API_KEY ? "yes" : "no"
    }`
  );
});

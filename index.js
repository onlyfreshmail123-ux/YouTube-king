const express = require("express");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const YOINKU_API_KEY = process.env.YOINKU_API_KEY;
const YOINKU_BASE = "https://yoinku.com/api/v1";

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    yoinkuConfigured: Boolean(YOINKU_API_KEY)
  });
});

function isYouTubeUrl(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");

    if (host === "youtu.be") {
      return Boolean(u.pathname.slice(1));
    }

    return (
      (host === "youtube.com" || host.endsWith(".youtube.com")) &&
      Boolean(u.searchParams.get("v"))
    );
  } catch {
    return false;
  }
}

function pickFormat(formats, quality) {
  const videos = (formats || [])
    .filter(
      f =>
        f &&
        f.kind === "video" &&
        f.container === "mp4" &&
        f.hasVideo === true &&
        f.hasAudio === true
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

  const wanted = Number(
    String(quality).replace("p", "")
  );

  if (!wanted) {
    return videos[0];
  }

  return (
    videos.find(f => f.heightNum === wanted) ||
    videos.find(f => f.heightNum < wanted) ||
    videos[videos.length - 1]
  );
}

async function yoinkuJson(endpoint, params) {
  const url = new URL(
    `${YOINKU_BASE}${endpoint}`
  );

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      "x-api-key": YOINKU_API_KEY,
      "Accept": "application/json"
    }
  });

  const text = await response.text();

  let data = null;

  try {
    data = JSON.parse(text);
  } catch {}

  return {
    response,
    data
  };
}

app.get("/api/download", async (req, res) => {
  if (!YOINKU_API_KEY) {
    return res.status(500).json({
      error: "YOINKU_API_KEY is not configured in Railway."
    });
  }

  const youtubeUrl = String(
    req.query.url || ""
  ).trim();

  const quality = String(
    req.query.quality || "Best available"
  ).trim();

  if (!youtubeUrl || !isYouTubeUrl(youtubeUrl)) {
    return res.status(400).json({
      error: "Please provide a valid YouTube URL."
    });
  }

  try {
    const infoResult = await yoinkuJson(
      "/info",
      {
        url: youtubeUrl
      }
    );

    if (
      !infoResult.response.ok ||
      !infoResult.data?.ok
    ) {
      return res.status(
        infoResult.response.status || 502
      ).json({
        error: "Yoinku info request failed",
        details:
          infoResult.data?.error?.message ||
          infoResult.data?.error ||
          "Unknown error"
      });
    }

    const formats =
      infoResult.data?.data?.formats || [];

    const format = pickFormat(
      formats,
      quality
    );

    if (!format?.id) {
      return res.status(422).json({
        error:
          "No compatible MP4 video format was returned by Yoinku."
      });
    }

    const downloadUrl = new URL(
      `${YOINKU_BASE}/download`
    );

    downloadUrl.searchParams.set(
      "url",
      youtubeUrl
    );

    downloadUrl.searchParams.set(
      "format",
      format.id
    );

    downloadUrl.searchParams.set(
      "redirect",
      "1"
    );

    const downloadResponse = await fetch(
      downloadUrl,
      {
        redirect: "manual",
        headers: {
          "x-api-key": YOINKU_API_KEY,
          "Accept": "application/json"
        }
      }
    );

    const location =
      downloadResponse.headers.get("location");

    if (location) {
      return res.redirect(
        302,
        location
      );
    }

    const text =
      await downloadResponse.text();

    let data = null;

    try {
      data = JSON.parse(text);
    } catch {}

    if (
      downloadResponse.ok &&
      data?.ok &&
      data?.url
    ) {
      return res.redirect(
        302,
        data.url
      );
    }

    return res.status(
      downloadResponse.status || 502
    ).json({
      error:
        "Yoinku did not return a download URL.",
      details:
        data?.error?.message ||
        data?.error ||
        "Unexpected response from Yoinku."
    });

  } catch (error) {
    console.error(
      "Download error:",
      error
    );

    return res.status(502).json({
      error:
        "Unable to contact Yoinku.",
      details:
        error?.message ||
        String(error)
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

app.listen(
  PORT,
  () => {
    console.log(
      `GRAB IT running on port ${PORT}`
    );
  }
);

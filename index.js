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
  const url = new URL(`${YOINKU_BASE}${endpoint}`);

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

/*
  Download endpoint

  IMPORTANT:
  We stream heartbeat data while Yoinku is preparing
  the download URL.

  This prevents the Railway/browser connection from
  sitting completely silent for a long time.
*/
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

  /*
    We use SSE-style streaming.

    Browser receives a heartbeat every 20 seconds
    while Yoinku is working.
  */

  res.status(200);

  res.setHeader(
    "Content-Type",
    "text/event-stream; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "no-cache, no-transform"
  );

  res.setHeader(
    "Connection",
    "keep-alive"
  );

  res.setHeader(
    "X-Accel-Buffering",
    "no"
  );

  if (res.flushHeaders) {
    res.flushHeaders();
  }

  let clientClosed = false;

  req.on("close", () => {
    clientClosed = true;
  });

  const heartbeat = setInterval(() => {
    if (!clientClosed && !res.writableEnded) {
      res.write(
        `event: progress\ndata: ${JSON.stringify({
          status: "preparing"
        })}\n\n`
      );
    }
  }, 20000);

  function finish() {
    clearInterval(heartbeat);
  }

  try {
    /*
      STEP 1
      Ask Yoinku for available formats.
    */

    if (!clientClosed) {
      res.write(
        `event: progress\ndata: ${JSON.stringify({
          status: "checking"
        })}\n\n`
      );
    }

    const infoResult = await yoinkuJson(
      "/info",
      {
        url: youtubeUrl
      }
    );

    if (clientClosed) {
      finish();
      return;
    }

    if (
      !infoResult.response.ok ||
      !infoResult.data?.ok
    ) {
      finish();

      return res.end(
        `event: error\ndata: ${JSON.stringify({
          error: "Yoinku info request failed",
          details:
            infoResult.data?.error?.message ||
            infoResult.data?.error ||
            "Unknown error"
        })}\n\n`
      );
    }

    const formats =
      infoResult.data?.data?.formats || [];

    const format = pickFormat(
      formats,
      quality
    );

    if (!format?.id) {
      finish();

      return res.end(
        `event: error\ndata: ${JSON.stringify({
          error:
            "No compatible MP4 video format was returned by Yoinku."
        })}\n\n`
      );
    }

    /*
      STEP 2
      Ask Yoinku to create the actual download URL.
    */

    if (!clientClosed) {
      res.write(
        `event: progress\ndata: ${JSON.stringify({
          status: "creating"
        })}\n\n`
      );
    }

    const downloadUrl =
      new URL(`${YOINKU_BASE}/download`);

    downloadUrl.searchParams.set(
      "url",
      youtubeUrl
    );

    downloadUrl.searchParams.set(
      "format",
      format.id
    );

    /*
      IMPORTANT:
      Do NOT use redirect=1 here.

      We want JSON containing the temporary
      download URL.
    */

    const downloadResponse = await fetch(
      downloadUrl,
      {
        headers: {
          "x-api-key": YOINKU_API_KEY,
          "Accept": "application/json"
        }
      }
    );

    const text =
      await downloadResponse.text();

    if (clientClosed) {
      finish();
      return;
    }

    let data = null;

    try {
      data = JSON.parse(text);
    } catch {}

    if (
      downloadResponse.ok &&
      data?.ok &&
      data?.url
    ) {
      finish();

      res.write(
        `event: ready\ndata: ${JSON.stringify({
          url: data.url,
          filename: data.filename || "video.mp4"
        })}\n\n`
      );

      return res.end();
    }

    finish();

    return res.end(
      `event: error\ndata: ${JSON.stringify({
        error:
          "Yoinku did not return a download URL.",
        details:
          data?.error?.message ||
          data?.error ||
          "Unexpected response from Yoinku."
      })}\n\n`
    );

  } catch (error) {
    finish();

    console.error(
      "Download error:",
      error
    );

    if (!clientClosed && !res.writableEnded) {
      return res.end(
        `event: error\ndata: ${JSON.stringify({
          error: "Unable to contact Yoinku.",
          details:
            error?.message ||
            String(error)
        })}\n\n`
      );
    }
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
  "0.0.0.0",
  () => {
    console.log(
      `GRAB IT running on port ${PORT}`
    );
  }
);

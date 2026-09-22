const express = require("express");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const YOINKU_API_KEY = process.env.YOINKU_API_KEY;
const YOINKU_BASE = "https://yoinku.com/api/v1";

app.use(express.static(path.join(__dirname, "public")));

/*
  In-memory jobs.

  job = {
    status: "processing" | "ready" | "error",
    url: "...",
    filename: "...",
    error: "..."
  }
*/

const jobs = new Map();

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

async function fetchWithTimeout(url, options = {}, timeoutMs = 90000) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function yoinkuJson(endpoint, params) {
  const url = new URL(`${YOINKU_BASE}${endpoint}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "x-api-key": YOINKU_API_KEY,
        "Accept": "application/json"
      }
    },
    90000
  );

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
  Actual Yoinku processing.

  IMPORTANT:
  This function runs in the background.
  The user's browser does NOT have to keep
  /api/download open while Yoinku works.
*/
async function processDownload(jobId, youtubeUrl, quality) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  try {
    job.status = "processing";

    /*
      STEP 1: Get video information
    */
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
      const status =
        infoResult.response.status || 502;

      job.status = "error";

      job.error =
        infoResult.data?.error?.message ||
        infoResult.data?.error ||
        `Yoinku info request failed (${status})`;

      return;
    }

    const formats =
      infoResult.data?.data?.formats || [];

    /*
      STEP 2: Select MP4 format
    */
    const format = pickFormat(
      formats,
      quality
    );

    if (!format?.id) {
      job.status = "error";

      job.error =
        "No compatible MP4 video format was returned by Yoinku.";

      return;
    }

    /*
      STEP 3: Ask Yoinku for the actual
      short-lived download URL.

      We intentionally DON'T use redirect=1 here.
      We want the JSON response containing `url`.
    */
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

    const downloadResponse =
      await fetchWithTimeout(
        downloadUrl,
        {
          headers: {
            "x-api-key": YOINKU_API_KEY,
            "Accept": "application/json"
          }
        },
        90000
      );

    const text =
      await downloadResponse.text();

    let data = null;

    try {
      data = JSON.parse(text);
    } catch {}

    /*
      Handle Yoinku errors
    */
    if (
      !downloadResponse.ok ||
      !data?.ok ||
      !data?.url
    ) {
      const status =
        downloadResponse.status || 502;

      job.status = "error";

      job.error =
        data?.error?.message ||
        data?.error ||
        `Yoinku download request failed (${status})`;

      return;
    }

    /*
      SUCCESS
    */
    job.status = "ready";

    job.url = data.url;

    job.filename =
      data.filename ||
      "video.mp4";

  } catch (error) {
    console.error(
      "Background download error:",
      error
    );

    job.status = "error";

    if (error?.name === "AbortError") {
      job.error =
        "Yoinku took too long to respond. Please try again.";
    } else {
      job.error =
        error?.message ||
        String(error);
    }
  }
}


/*
  START DOWNLOAD JOB

  This responds immediately.

  Browser no longer waits 1-2 minutes
  for Yoinku.
*/
app.get("/api/download", (req, res) => {
  if (!YOINKU_API_KEY) {
    return res.status(500).json({
      error:
        "YOINKU_API_KEY is not configured in Railway."
    });
  }

  const youtubeUrl = String(
    req.query.url || ""
  ).trim();

  const quality = String(
    req.query.quality ||
      "Best available"
  ).trim();

  if (
    !youtubeUrl ||
    !isYouTubeUrl(youtubeUrl)
  ) {
    return res.status(400).json({
      error:
        "Please provide a valid YouTube URL."
    });
  }

  /*
    Unique job ID
  */
  const jobId =
    `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;

  jobs.set(jobId, {
    status: "processing",
    url: null,
    filename: null,
    error: null,
    createdAt: Date.now()
  });

  /*
    Start processing WITHOUT awaiting it.
  */
  processDownload(
    jobId,
    youtubeUrl,
    quality
  ).catch(error => {
    console.error(
      "Unexpected job error:",
      error
    );

    const job = jobs.get(jobId);

    if (job) {
      job.status = "error";
      job.error =
        error?.message ||
        String(error);
    }
  });

  /*
    Return immediately
  */
  return res.status(202).json({
    ok: true,
    jobId,
    status: "processing"
  });
});


/*
  CHECK JOB STATUS

  Frontend polls this endpoint.
*/
app.get("/api/status/:jobId", (req, res) => {
  const jobId = req.params.jobId;

  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({
      error: "Download job not found."
    });
  }

  if (job.status === "processing") {
    return res.json({
      ok: true,
      status: "processing"
    });
  }

  if (job.status === "error") {
    return res.status(502).json({
      ok: false,
      status: "error",
      error:
        job.error ||
        "Download failed."
    });
  }

  if (job.status === "ready") {
    return res.json({
      ok: true,
      status: "ready",
      url: job.url,
      filename: job.filename
    });
  }

  return res.status(500).json({
    error: "Unknown job status."
  });
});


/*
  Automatically remove old jobs.

  Keeps Railway memory clean.
*/
setInterval(() => {
  const now = Date.now();

  for (const [jobId, job] of jobs.entries()) {
    /*
      Remove jobs older than 1 hour.
    */
    if (
      now - job.createdAt >
      60 * 60 * 1000
    ) {
      jobs.delete(jobId);
    }
  }
}, 10 * 60 * 1000);


/*
  Frontend
*/
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

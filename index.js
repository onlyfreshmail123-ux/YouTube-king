const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;
const YOINKU_API_KEY = process.env.YOINKU_API_KEY;
const YOINKU_BASE = "https://yoinku.com/api/v1";

app.use(express.static(path.join(__dirname, "public")));

// Temporary in-memory job storage
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
  Background download preparation
*/
async function prepareDownload(jobId, youtubeUrl, quality) {
  try {
    jobs.set(jobId, {
      status: "processing",
      progress: "Getting video information..."
    });

    // STEP 1: Get video information
    const infoResult = await yoinkuJson("/info", {
      url: youtubeUrl
    });

    if (
      !infoResult.response.ok ||
      !infoResult.data?.ok
    ) {
      throw new Error(
        infoResult.data?.error?.message ||
        infoResult.data?.error ||
        "Yoinku info request failed."
      );
    }

    const formats =
      infoResult.data?.data?.formats || [];

    const format = pickFormat(
      formats,
      quality
    );

    if (!format?.id) {
      throw new Error(
        "No compatible MP4 video format was returned by Yoinku."
      );
    }

    jobs.set(jobId, {
      status: "processing",
      progress: "Preparing video file..."
    });

    // STEP 2: Ask Yoinku for the download URL
    // IMPORTANT:
    // Do NOT use redirect=1 here.
    // We want Yoinku's JSON response containing the URL.
    const downloadResult = await yoinkuJson(
      "/download",
      {
        url: youtubeUrl,
        format: format.id
      }
    );

    if (
      !downloadResult.response.ok ||
      !downloadResult.data?.ok ||
      !downloadResult.data?.url
    ) {
      throw new Error(
        downloadResult.data?.error?.message ||
        downloadResult.data?.error ||
        "Yoinku did not return a download URL."
      );
    }

    jobs.set(jobId, {
      status: "ready",
      progress: "Ready",
      url: downloadResult.data.url,
      filename:
        downloadResult.data.filename ||
        "video.mp4"
    });

    console.log(
      `Job ${jobId} is ready`
    );

  } catch (error) {
    console.error(
      `Job ${jobId} failed:`,
      error
    );

    jobs.set(jobId, {
      status: "error",
      error:
        error?.message ||
        String(error)
    });
  }
}


/*
  START DOWNLOAD JOB
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

  const jobId = crypto
    .randomBytes(12)
    .toString("hex");

  jobs.set(jobId, {
    status: "queued",
    progress: "Starting..."
  });

  // IMPORTANT:
  // Do NOT await this.
  // Let it run in the background.
  prepareDownload(
    jobId,
    youtubeUrl,
    quality
  );

  // Respond immediately
  res.json({
    ok: true,
    jobId
  });
});


/*
  CHECK JOB STATUS
*/
app.get("/api/status/:jobId", (req, res) => {
  const job = jobs.get(
    req.params.jobId
  );

  if (!job) {
    return res.status(404).json({
      error: "Download job not found."
    });
  }

  if (job.status === "ready") {
    return res.json({
      ok: true,
      status: "ready",
      progress: "Ready",
      url: job.url,
      filename: job.filename
    });
  }

  if (job.status === "error") {
    return res.status(500).json({
      ok: false,
      status: "error",
      error: job.error
    });
  }

  res.json({
    ok: true,
    status: job.status,
    progress: job.progress
  });
});


/*
  Remove old jobs periodically
*/
setInterval(() => {
  const now = Date.now();

  for (const [jobId, job] of jobs.entries()) {
    if (
      job.createdAt &&
      now - job.createdAt > 60 * 60 * 1000
    ) {
      jobs.delete(jobId);
    }
  }
}, 10 * 60 * 1000);


// Store creation time automatically
const originalSet = jobs.set.bind(jobs);

jobs.set = (key, value) => {
  if (!value.createdAt) {
    value.createdAt = Date.now();
  }

  return originalSet(key, value);
};


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

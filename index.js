const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();

app.use(express.json());

// CORS without external package
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const PORT = process.env.PORT || 3000;

const BGUTIL_URL =
  process.env.BGUTIL_URL || "http://127.0.0.1:4416";

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);

    const hosts = [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "youtu.be",
      "www.youtube-nocookie.com",
    ];

    return hosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function qualityFormat(quality) {
  switch (quality) {
    case "720":
      return "bestvideo[height<=720]+bestaudio/best[height<=720]/best";

    case "480":
      return "bestvideo[height<=480]+bestaudio/best[height<=480]/best";

    case "360":
      return "bestvideo[height<=360]+bestaudio/best[height<=360]/best";

    case "best":
    default:
      return "bestvideo+bestaudio/best";
  }
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "GRAB IT YouTube Backend",
    message: "Backend is running",
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    bgutil: BGUTIL_URL,
  });
});

app.get("/api/download", async (req, res) => {
  const videoUrl = req.query.url;
  const quality = req.query.quality || "best";

  if (!videoUrl) {
    return res.status(400).json({
      error: "YouTube URL is required",
    });
  }

  if (!isYouTubeUrl(videoUrl)) {
    return res.status(400).json({
      error: "Only YouTube URLs are supported",
    });
  }

  const outputDir = "/tmp/grab-it";

  try {
    await fs.promises.mkdir(outputDir, {
      recursive: true,
    });

    const outputTemplate = path.join(
      outputDir,
      "video-%(id)s.%(ext)s"
    );

    const args = [
      "--no-playlist",

      "--js-runtimes",
      "node",

      "--extractor-args",
      "youtube:player-client=mweb",

      "--extractor-args",
      `youtubepot-bgutilhttp:base_url=${BGUTIL_URL}`,

      "--format",
      qualityFormat(quality),

      "--merge-output-format",
      "mp4",

      "--retries",
      "2",

      "--fragment-retries",
      "2",

      "--socket-timeout",
"30",

"--verbose",

"--no-warnings",

"--print",
"after_move:filepath",

      "-o",
      outputTemplate,

      videoUrl,
    ];

    console.log(
      `Starting download: ${videoUrl} (${quality})`
    );

    console.log(
      "BGUTIL provider:",
      BGUTIL_URL
    );

    const yt = spawn("yt-dlp", args);

    let stdout = "";
    let stderr = "";

    yt.stdout.on("data", (data) => {
      const text = data.toString();

      stdout += text;

      console.log("[yt-dlp]", text.trim());
    });

    yt.stderr.on("data", (data) => {
      const text = data.toString();

      stderr += text;

      console.error("[yt-dlp]", text.trim());
    });

    yt.on("error", (error) => {
      console.error(
        "Failed to start yt-dlp:",
        error
      );

      if (!res.headersSent) {
        res.status(500).json({
          error: "Could not start yt-dlp",
          details: error.message,
        });
      }
    });

    yt.on("close", async (code) => {
      console.log(
        `yt-dlp exited with code ${code}`
      );

      if (code !== 0) {
        if (!res.headersSent) {
          return res.status(500).json({
            error: "YouTube download failed",
            details: stderr.slice(-4000),
          });
        }

        return;
      }

      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      let outputFile = lines[lines.length - 1];

      if (
        !outputFile ||
        !fs.existsSync(outputFile)
      ) {
        const files = await fs.promises.readdir(
          outputDir
        );

        const candidates = files
          .filter((file) =>
            /\.(mp4|mkv|webm|mov)$/i.test(file)
          )
          .map((file) =>
            path.join(outputDir, file)
          )
          .filter((file) =>
            fs.existsSync(file)
          );

        if (candidates.length > 0) {
          candidates.sort(
            (a, b) =>
              fs.statSync(b).mtimeMs -
              fs.statSync(a).mtimeMs
          );

          outputFile = candidates[0];
        }
      }

      if (
        !outputFile ||
        !fs.existsSync(outputFile)
      ) {
        return res.status(500).json({
          error:
            "Download finished but output file was not found",
        });
      }

      console.log(
        "Sending file:",
        outputFile
      );

      res.download(
        outputFile,
        "video.mp4",
        (error) => {
          if (error) {
            console.error(
              "File download error:",
              error
            );
          }

          fs.unlink(
            outputFile,
            () => {}
          );
        }
      );
    });
  } catch (error) {
    console.error(
      "Download handler error:",
      error
    );

    if (!res.headersSent) {
      res.status(500).json({
        error: "Internal server error",
        details: error.message,
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Server running on port ${PORT}`
  );

  console.log(
    `BGUTIL provider URL: ${BGUTIL_URL}`
  );
});

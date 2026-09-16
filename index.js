const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

const port = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || '/usr/local/bin/yt-dlp';

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'youtube-backend',
    message: 'YouTube downloader backend is running'
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

function isAllowedVideoUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');

    return (
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtu.be' ||
      host === 'youtube-nocookie.com' ||
      host.endsWith('.youtube-nocookie.com')
    );
  } catch {
    return false;
  }
}

function cleanup(filePath) {
  fs.unlink(filePath, () => {});
}

app.get('/api/download', (req, res) => {
  const videoUrl =
    typeof req.query.url === 'string'
      ? req.query.url.trim()
      : '';

  if (!videoUrl) {
    return res.status(400).send('Video URL is required');
  }

  if (!isAllowedVideoUrl(videoUrl)) {
    return res.status(400).send('Please provide a valid YouTube URL');
  }

  const id = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;

  const outputTemplate = path.join(
    '/tmp',
    `youtube-${id}.%(ext)s`
  );

  const args = [
    '--no-playlist',

    // JavaScript runtime
    '--js-runtimes',
    'node',

    // Use mweb client for PO Token support
    '--extractor-args',
    'youtube:player-client=mweb',

    // Connect yt-dlp to local BGUTIL PO Token server
    '--extractor-args',
    'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416',

    // Download
    '--format',
    'bestvideo+bestaudio/best',

    '--merge-output-format',
    'mp4',

    // Retry settings
    '--retries',
    '3',

    '--fragment-retries',
    '3',

    '--socket-timeout',
    '30',

    // Output
    '--output',
    outputTemplate,

    '--print',
    'after_move:filepath',

    '--',
    videoUrl
  ];

  console.log('======================================');
  console.log(`Starting download: ${videoUrl}`);
  console.log('PO Token Provider: BGUTIL');
  console.log('PO Token Server: http://127.0.0.1:4416');
  console.log('YouTube Client: mweb');
  console.log('======================================');

  const child = spawn(YTDLP, args, {
    env: process.env
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', chunk => {
    const text = chunk.toString();

    stdout += text;

    if (stdout.length > 10000) {
      stdout = stdout.slice(-10000);
    }

    console.log(text.trim());
  });

  child.stderr.on('data', chunk => {
    const text = chunk.toString();

    stderr += text;

    if (stderr.length > 30000) {
      stderr = stderr.slice(-30000);
    }

    console.error(text.trim());
  });

  child.on('error', error => {
    console.error('Could not start yt-dlp:', error);

    if (!res.headersSent) {
      return res
        .status(500)
        .send('Downloader is not available on the server.');
    }
  });

  child.on('close', code => {
    console.log(`yt-dlp exited with code ${code}`);

    if (code !== 0) {
      console.error('========== yt-dlp ERROR ==========');
      console.error(stderr);
      console.error('===================================');

      if (!res.headersSent) {
        return res
          .status(500)
          .send('Download failed. Please try again.');
      }

      return;
    }

    const lines = stdout
      .trim()
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    let outputPath =
      lines.length
        ? lines[lines.length - 1]
        : '';

    // Fallback: find generated file
    if (!outputPath || !fs.existsSync(outputPath)) {
      const matches = fs
        .readdirSync('/tmp')
        .filter(name =>
          name.startsWith(`youtube-${id}.`)
        )
        .map(name =>
          path.join('/tmp', name)
        );

      outputPath =
        matches.find(file =>
          fs.existsSync(file)
        ) || '';
    }

    if (!outputPath || !fs.existsSync(outputPath)) {
      console.error(
        'yt-dlp completed but output file was not found.'
      );

      console.error('stdout:', stdout);
      console.error('stderr:', stderr);

      if (!res.headersSent) {
        return res
          .status(500)
          .send('Download failed. Please try again.');
      }

      return;
    }

    console.log(
      `Download complete: ${outputPath}`
    );

    res.download(
      outputPath,
      'video.mp4',
      error => {
        cleanup(outputPath);

        if (error) {
          console.error(
            'Error sending downloaded file:',
            error
          );
        }
      }
    );
  });
});

app.listen(port, () => {
  console.log(
    `Server running on port ${port}`
  );
});      host === 'youtu.be' ||
      host === 'youtube-nocookie.com' ||
      host.endsWith('.youtube-nocookie.com')
    );
  } catch {
    return false;
  }
}

function qualityFormat(value) {
  switch (value) {
    case '720p':
      return 'bv*[height<=720]+ba/b[height<=720]/b';

    case '480p':
      return 'bv*[height<=480]+ba/b[height<=480]/b';

    case '360p':
      return 'bv*[height<=360]+ba/b[height<=360]/b';

    default:
      return 'bv*+ba/b';
  }
}

function cleanup(filePath) {
  if (filePath) {
    fs.unlink(filePath, () => {});
  }
}

app.get('/api/download', (req, res) => {
  const videoUrl =
    typeof req.query.url === 'string'
      ? req.query.url.trim()
      : '';

  const quality =
    typeof req.query.quality === 'string'
      ? req.query.quality.trim()
      : 'Best available';

  if (!videoUrl) {
    return res
      .status(400)
      .send('Video URL is required');
  }

  if (!isAllowedVideoUrl(videoUrl)) {
    return res
      .status(400)
      .send('Please provide a valid YouTube URL');
  }

  const id =
    `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;

  const outputTemplate =
    path.join('/tmp', `youtube-${id}.%(ext)s`);

  const args = [
    '--no-playlist',

    '--js-runtimes',
    'node',

    '--format',
    qualityFormat(quality),

    '--merge-output-format',
    'mp4',

    '--retries',
    '2',

    '--fragment-retries',
    '2',

    '--socket-timeout',
    '30',

    '--output',
    outputTemplate,

    '--print',
    'after_move:filepath',

    '--',
    videoUrl
  ];

  console.log(
    `Starting download: ${videoUrl} (${quality})`
  );

  const child = spawn(YTDLP, args, {
    env: process.env
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', chunk => {
    stdout += chunk.toString();

    if (stdout.length > 12000) {
      stdout = stdout.slice(-12000);
    }
  });

  child.stderr.on('data', chunk => {
    stderr += chunk.toString();

    if (stderr.length > 25000) {
      stderr = stderr.slice(-25000);
    }
  });

  child.on('error', error => {
    console.error(
      'Could not start yt-dlp:',
      error
    );

    if (!res.headersSent) {
      res
        .status(500)
        .send(
          'Downloader is not available on the server.'
        );
    }
  });

  child.on('close', code => {
    if (code !== 0) {
      console.error(
        `yt-dlp exited with code ${code}`
      );

      console.error(stderr);

      if (
        /PO Token|Missing required Visitor Data|Too Many Requests|not a bot|403|429|LOGIN_REQUIRED/i
          .test(stderr)
      ) {
        return res
          .status(502)
          .send(
            'YouTube could not authorize this server request. Please try again later.'
          );
      }

      return res
        .status(500)
        .send(
          'Download failed. Please try again.'
        );
    }

    const lines = stdout
      .trim()
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    let outputPath =
      lines.length
        ? lines[lines.length - 1]
        : '';

    if (
      !outputPath ||
      !fs.existsSync(outputPath)
    ) {
      const matches =
        fs.readdirSync('/tmp')
          .filter(name =>
            name.startsWith(`youtube-${id}.`)
          )
          .map(name =>
            path.join('/tmp', name)
          );

      outputPath =
        matches.find(file =>
          fs.existsSync(file)
        ) || '';
    }

    if (
      !outputPath ||
      !fs.existsSync(outputPath)
    ) {
      console.error(
        'yt-dlp completed but output file was not found.'
      );

      console.error(
        'stdout:',
        stdout
      );

      console.error(
        'stderr:',
        stderr
      );

      return res
        .status(500)
        .send(
          'Download failed. Please try again.'
        );
    }

    console.log(
      `Download complete: ${outputPath}`
    );

    res.download(
      outputPath,
      'video.mp4',
      error => {
        cleanup(outputPath);

        if (error) {
          console.error(
            'Error sending downloaded file:',
            error
          );
        }
      }
    );
  });
});

app.listen(port, () => {
  console.log(
    `Server running on port ${port}`
  );
});

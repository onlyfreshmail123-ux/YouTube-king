FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install \
    --break-system-packages \
    --no-cache-dir \
    "yt-dlp[default,curl-cffi]" \
    "bgutil-ytdlp-pot-provider"

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]

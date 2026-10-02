# Preview build container (Cloudflare Sandbox). Keep the tag equal to the @cloudflare/sandbox npm version.
FROM docker.io/cloudflare/sandbox:0.12.10

# ffmpeg encodes animated thumbnails (animated WebP)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/opt/pnpm PATH=/opt/pnpm:$PATH
RUN npm install --global pnpm@11.1.2

# The harness: Vite + React 19 + Tailwind v4 + shadcn (neutral) + vite-plugin-singlefile, common registry deps preinstalled
WORKDIR /opt/harness
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN sh setup.sh
# The harness version the Worker checks before using a container. Kept outside /opt/harness because run-job.mjs resets
# that directory (git clean -x) before every job.
RUN cp .harness-version /opt/harness-version

EXPOSE 3000

FROM denoland/deno:2.9.8
WORKDIR /app
COPY . .
RUN deno task build
# /data is the Fly volume (see fly.toml); the database must live there to survive deploys.
CMD ["deno", "task", "start", "--host", "0.0.0.0", "--port", "8080", "--db", "/data/data.sqlite"]

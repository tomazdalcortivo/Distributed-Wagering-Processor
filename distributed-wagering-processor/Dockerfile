FROM oven/bun:1.1.34-alpine

WORKDIR /app

COPY package.json bunfig.toml tsconfig.json nest-cli.json ./
RUN bun install

COPY src ./src
COPY test ./test

EXPOSE 3000

CMD ["sh", "-c", "bun run migration:up && bun run start"]

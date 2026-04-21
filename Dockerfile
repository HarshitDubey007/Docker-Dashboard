FROM node:20-alpine

RUN apk add --no-cache tini curl

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

RUN mkdir -p /app/data && \
    addgroup -g 1001 -S app && \
    adduser -u 1001 -S app -G app && \
    chown -R app:app /app

USER app

ENV PORT=3000
ENV DATA_DIR=/app/data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD sh -c 'code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/auth/me); [ "$code" -lt 500 ] && [ -n "$code" ]'

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]

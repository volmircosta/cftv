FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY server.js ./server.mjs
COPY nvr-query.mjs ./nvr-query.mjs
COPY nvr-clip-worker.mjs ./nvr-clip-worker.mjs
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3000
CMD node server.mjs

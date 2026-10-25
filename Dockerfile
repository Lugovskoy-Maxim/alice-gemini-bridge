FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    APP_DATA_DIR=/data

WORKDIR /app
COPY --chown=node:node server.mjs index.html ./
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8787
CMD ["node", "server.mjs"]

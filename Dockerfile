FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]

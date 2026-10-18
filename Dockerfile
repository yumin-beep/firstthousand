FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY public ./public
COPY examples ./examples
ENV NODE_ENV=production PORT=8080 DATA_DIR=/tmp/firstthousand HOME=/tmp
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]

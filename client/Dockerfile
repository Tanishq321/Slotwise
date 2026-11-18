# Static build served by nginx, which also forwards /api to the API container.
#   docker build -f client/Dockerfile -t slotwise-web .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY engine/package.json engine/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci -w client -w engine
COPY engine ./engine
COPY client ./client
RUN npm run build -w client

FROM nginx:1.27-alpine
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html
EXPOSE 80

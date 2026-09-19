FROM node:22.23.2-alpine3.24 AS build

WORKDIR /src/web

RUN npm install -g npm@12.0.2

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
ARG NEXT_PUBLIC_API_URL=http://localhost:8080
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build

FROM nginx:1.30.5-alpine3.24

COPY web/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /src/web/out /usr/share/nginx/html

USER 101:101
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3000/"]

ENTRYPOINT ["nginx", "-g", "daemon off;"]

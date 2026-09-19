FROM golang:1.27.1-alpine3.24 AS build

WORKDIR /src/backend

COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/spackt-server ./cmd/server

FROM alpine:3.24 AS certs
RUN apk --no-cache add ca-certificates

FROM scratch

COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /out/spackt-server /spackt-server

USER 65532:65532
EXPOSE 8080

ENV PORT=8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 CMD ["/spackt-server", "-healthcheck"]

ENTRYPOINT ["/spackt-server"]

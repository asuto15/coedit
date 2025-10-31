FROM rust:1.89-bullseye AS dev
ENV PATH="/usr/local/cargo/bin:/usr/local/rustup/bin:${PATH}"
ENV APP_ENV=dev
WORKDIR /workspace
RUN apt-get update -y && apt-get install -y pkg-config libssl-dev curl gosu && rm -rf /var/lib/apt/lists/*
RUN echo 'export PATH=/usr/local/cargo/bin:/usr/local/rustup/bin:$PATH' > /etc/profile.d/rust-path.sh
RUN rustup component add rustfmt clippy
RUN cargo install cargo-watch
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 9000
CMD ["/entrypoint.sh"]

FROM rust:1.89-bullseye AS build
ENV PATH="/usr/local/cargo/bin:/usr/local/rustup/bin:${PATH}"
WORKDIR /app
COPY . ./
RUN cargo build --release

FROM debian:bullseye-slim AS prod
WORKDIR /opt/server
COPY --from=build /app/target/release/server /opt/server/server
ENV DATA_DIR=/vault
ENV APP_ENV=prod
EXPOSE 9000
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
RUN apt-get update -y && apt-get install -y curl gosu && rm -rf /var/lib/apt/lists/*
CMD ["/entrypoint.sh"]
